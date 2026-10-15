import type {
  EpicInput,
  ExternalRef,
  StoryInput,
  SubtaskInput,
  TaskItem,
  TaskQuery,
  TaskSystemAdapter,
  TaskSystemKind,
  TenantCtx,
} from '@sdlc/adapters-contracts';

// ---------------------------------------------------------------------------
// Mapeo del contrato a GitHub Issues — y qué se pierde
// ---------------------------------------------------------------------------
//
// GitHub Issues no tiene jerarquía de tres niveles ni tipos de work item: tiene
// Issues en un repo, labels, y la API de sub-issues (un nivel padre → hijo, que
// se puede encadenar). El mapeo es:
//
//   epic     → Issue con la label `sdlc:epic`
//   story    → Issue con la label `sdlc:story`, colgada del epic por sub-issues
//   subtask  → Issue con la label `sdlc:subtask`, colgada de la story
//
// Lo que se pierde, dicho en voz alta:
//
// - **El tipo es una convención de labels, no un campo**: nada en GitHub impide
//   colgar un `sdlc:epic` de otro. Un issue sin label marcadora se lee como
//   `task` (el cuarto tipo del contrato) en vez de adivinar cuál era.
// - **Los estados son sólo `open`/`closed`**. El vocabulario del server (`Active`,
//   `Resolved`, `Closed`, `Removed`) no entra ahí: `Active` y `Resolved` colapsan
//   ambos en `open`. Un status fuera del mapa **falla explícito** en vez de
//   inventar un estado; el operador lo agrega a `settings.stateMap`. Si necesita
//   que el status fino sobreviva el round-trip, activa `statusLabelPrefix` y el
//   adapter lo escribe/lee como label (`status:Resolved`).
// - **No hay campo de estimación**. `createStory` con `estimate` tira
//   `GitHubIssuesUnsupportedError` salvo que el operador configure
//   `estimateLabelPrefix`, y entonces va como label (`points:3`). No hay opción de
//   tragárselo en silencio: un estimate que desaparece sin avisar es peor que un
//   error.
// - **Los criterios de aceptación** van al body como task list markdown: se leen y
//   se tildan, pero dejan de ser un campo consultable (y cuentan en el contador de
//   tareas que GitHub muestra en el issue).
// - **`parent_id` sólo aparece si la API devuelve la relación de sub-issue** en el
//   payload del issue. Si no viene, queda ausente en vez de fabricarse; para
//   recorrer la jerarquía al revés está `search({ parent_id })`, que usa el
//   endpoint de sub-issues y es exacto.
// - **`search` con texto usa la Search API** (`/search/issues`), que es
//   eventualmente consistente y tiene su propio rate limit: un issue recién creado
//   puede tardar en aparecer.
// - **`project_key` se ignora**: el repo sale de `settings.owner`/`settings.repo`,
//   igual que el adapter de ADO usa `settings.project`.

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

export class GitHubIssuesApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubIssuesApiError';
  }
}

export class GitHubIssuesRateLimitError extends Error {
  constructor() {
    super('GitHub rate limit reached; retry later');
    this.name = 'GitHubIssuesRateLimitError';
  }
}

/** Algo del contrato que GitHub Issues no puede representar sin simularlo. */
export class GitHubIssuesUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubIssuesUnsupportedError';
  }
}

// ---------------------------------------------------------------------------
// Opciones
// ---------------------------------------------------------------------------

/** Estado nativo de GitHub, con el motivo de cierre cuando aplica. */
export type GitHubIssueState = 'open' | 'closed' | 'closed:not_planned';

export interface GitHubIssuesAdapterOptions {
  /** PAT o token de GitHub App con permiso de issues. */
  token: string;
  owner: string;
  repo: string;
  /** Override del host de la API (GitHub Enterprise, tests). */
  apiBaseUrl?: string;
  /** Prefijo de las labels que marcan el tipo. Default `sdlc:`. */
  typeLabelPrefix?: string;
  /** status del contrato → estado nativo. Se mergea sobre el default. */
  stateMap?: Record<string, GitHubIssueState>;
  /** Si está seteado, el status fino también se escribe/lee como label. */
  statusLabelPrefix?: string;
  /** Si está seteado, el estimate se guarda como label en vez de fallar. */
  estimateLabelPrefix?: string;
}

/** El vocabulario que el server realmente manda a `transition`. */
const DEFAULT_STATE_MAP: Record<string, GitHubIssueState> = {
  New: 'open',
  Active: 'open',
  Resolved: 'open',
  Closed: 'closed',
  Removed: 'closed:not_planned',
};

interface GitHubIssueResponse {
  id: number;
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  state: string;
  labels?: Array<{ name: string } | string>;
  parent?: { number: number } | null;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class GitHubIssuesTaskSystemAdapter implements TaskSystemAdapter {
  readonly kind: TaskSystemKind = 'github';

  private readonly token: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly apiBaseUrl: string;
  private readonly typeLabelPrefix: string;
  private readonly stateMap: Record<string, GitHubIssueState>;
  private readonly statusLabelPrefix: string | undefined;
  private readonly estimateLabelPrefix: string | undefined;

  constructor(opts: GitHubIssuesAdapterOptions) {
    if (!opts.owner || !opts.repo) {
      throw new Error('github-issues adapter: missing required settings.owner / settings.repo');
    }
    this.token = opts.token;
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.apiBaseUrl = (opts.apiBaseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.typeLabelPrefix = opts.typeLabelPrefix ?? 'sdlc:';
    this.stateMap = { ...DEFAULT_STATE_MAP, ...(opts.stateMap ?? {}) };
    this.statusLabelPrefix = opts.statusLabelPrefix;
    this.estimateLabelPrefix = opts.estimateLabelPrefix;
  }

  /** Expuesto sólo para los tests del provider. */
  repoSlug(): string {
    return `${this.owner}/${this.repo}`;
  }

  // -------------------------------------------------------------------------
  // Contrato
  // -------------------------------------------------------------------------

  async createEpic(input: EpicInput, _ctx: TenantCtx): Promise<ExternalRef> {
    return this.createIssue({
      title: input.title,
      body: input.description,
      labels: [...(input.labels ?? []), this.typeLabel('epic')],
    });
  }

  async createStory(input: StoryInput, _ctx: TenantCtx): Promise<ExternalRef> {
    const labels = [...(input.labels ?? []), this.typeLabel('story')];
    if (input.estimate !== undefined) {
      if (!this.estimateLabelPrefix) {
        throw new GitHubIssuesUnsupportedError(
          'github-issues adapter: GitHub Issues no tiene campo de estimación. ' +
            'Configurá settings.estimateLabelPrefix (p.ej. "points:") para guardarlo como label, ' +
            'o sacá el estimate del breakdown.',
        );
      }
      labels.push(`${this.estimateLabelPrefix}${input.estimate}`);
    }
    return this.createIssue({
      title: input.title,
      body: withAcceptanceCriteria(input.description, input.acceptance_criteria),
      labels,
    });
  }

  async createSubtask(input: SubtaskInput, _ctx: TenantCtx): Promise<ExternalRef> {
    return this.createIssue({
      title: input.title,
      body: input.description ?? '',
      labels: [this.typeLabel('subtask')],
    });
  }

  async linkChildToParent(parentId: string, childId: string, _ctx: TenantCtx): Promise<void> {
    // La API de sub-issues toma el id de base de datos del hijo, no su número
    // visible: hay que leerlo primero.
    const child = await this.request<GitHubIssueResponse>(this.issueUrl(childId), { method: 'GET' });
    await this.request<unknown>(`${this.issueUrl(parentId)}/sub_issues`, {
      method: 'POST',
      body: { sub_issue_id: child.id },
    });
  }

  async getItem(id: string, _ctx: TenantCtx): Promise<TaskItem> {
    const issue = await this.request<GitHubIssueResponse>(this.issueUrl(id), { method: 'GET' });
    return this.mapIssue(issue);
  }

  async transition(id: string, status: string, _ctx: TenantCtx): Promise<void> {
    const state = this.mapState(status);
    const patch: Record<string, unknown> = { state: state === 'open' ? 'open' : 'closed' };
    if (state === 'closed') patch.state_reason = 'completed';
    if (state === 'closed:not_planned') patch.state_reason = 'not_planned';

    if (this.statusLabelPrefix) {
      // Leer las labels actuales para reemplazar la de status sin pisar el resto.
      const current = await this.request<GitHubIssueResponse>(this.issueUrl(id), { method: 'GET' });
      const kept = labelNames(current).filter((n) => !n.startsWith(this.statusLabelPrefix!));
      patch.labels = [...kept, `${this.statusLabelPrefix}${status}`];
    }

    await this.request<unknown>(this.issueUrl(id), { method: 'PATCH', body: patch });
  }

  async search(query: TaskQuery, _ctx: TenantCtx): Promise<TaskItem[]> {
    const limit = query.limit ?? 50;

    if (query.parent_id !== undefined) {
      // Exacto: los hijos declarados del padre. El resto de los filtros se
      // aplica del lado del cliente, sobre un conjunto ya acotado.
      const children = await this.request<GitHubIssueResponse[]>(
        `${this.issueUrl(query.parent_id)}/sub_issues?per_page=${limit}`,
        { method: 'GET' },
      );
      const wanted = query.status !== undefined ? this.mapState(query.status) : undefined;
      return (children ?? [])
        .filter((c) => (wanted === undefined ? true : matchesState(c.state, wanted)))
        .filter((c) => (query.text === undefined ? true : c.title.includes(query.text)))
        .map((c) => ({ ...this.mapIssue(c), parent_id: query.parent_id! }));
    }

    const terms = [`repo:${this.owner}/${this.repo}`, 'is:issue'];
    if (query.status !== undefined) {
      terms.push(`state:${this.mapState(query.status) === 'open' ? 'open' : 'closed'}`);
    }
    if (query.text !== undefined) terms.push(`in:title ${query.text}`);

    const url = `${this.apiBaseUrl}/search/issues?q=${encodeURIComponent(terms.join(' '))}&per_page=${limit}`;
    const result = await this.request<{ items: GitHubIssueResponse[] }>(url, { method: 'GET' });
    return (result.items ?? []).map((i) => this.mapIssue(i));
  }

  // -------------------------------------------------------------------------
  // Privados
  // -------------------------------------------------------------------------

  private typeLabel(type: 'epic' | 'story' | 'subtask'): string {
    return `${this.typeLabelPrefix}${type}`;
  }

  private issueUrl(idOrNumber: string): string {
    // El id del contrato es el número visible del issue; se coacciona a entero
    // para que nada del input se cuele en el path.
    const n = parseInt(idOrNumber, 10);
    if (!Number.isFinite(n)) {
      throw new GitHubIssuesApiError(400, `github-issues adapter: invalid issue id "${idOrNumber}"`);
    }
    return `${this.apiBaseUrl}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/issues/${n}`;
  }

  private mapState(status: string): GitHubIssueState {
    const mapped = this.stateMap[status];
    if (!mapped) {
      throw new GitHubIssuesUnsupportedError(
        `github-issues adapter: no sé a qué estado de GitHub corresponde "${status}". ` +
          `GitHub Issues sólo tiene open/closed; agregá el status a settings.stateMap ` +
          `(valores válidos: open, closed, closed:not_planned).`,
      );
    }
    return mapped;
  }

  private async createIssue(args: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<ExternalRef> {
    const url = `${this.apiBaseUrl}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/issues`;
    const issue = await this.request<GitHubIssueResponse>(url, {
      method: 'POST',
      body: { title: args.title, body: args.body, labels: args.labels },
    });
    return { external_id: String(issue.number), url: issue.html_url };
  }

  private mapIssue(issue: GitHubIssueResponse): TaskItem {
    const names = labelNames(issue);

    const typeName = names.find((n) => n.startsWith(this.typeLabelPrefix))?.slice(this.typeLabelPrefix.length);
    const type: TaskItem['type'] =
      typeName === 'epic' || typeName === 'story' || typeName === 'subtask' ? typeName : 'task';

    const statusLabel = this.statusLabelPrefix
      ? names.find((n) => n.startsWith(this.statusLabelPrefix!))
      : undefined;

    const labels = names.filter(
      (n) =>
        !n.startsWith(this.typeLabelPrefix) &&
        !(this.statusLabelPrefix && n.startsWith(this.statusLabelPrefix)),
    );

    const parentNumber = issue.parent?.number;

    return {
      external_id: String(issue.number),
      url: issue.html_url,
      title: issue.title,
      description: issue.body ?? '',
      status: statusLabel ? statusLabel.slice(this.statusLabelPrefix!.length) : issue.state,
      type,
      ...(parentNumber !== undefined ? { parent_id: String(parentNumber) } : {}),
      labels,
    };
  }

  private async request<T>(
    url: string,
    opts: { method: 'GET' | 'POST' | 'PATCH'; body?: unknown },
  ): Promise<T> {
    const res = await fetch(url, {
      method: opts.method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });

    // GitHub devuelve el rate limit agotado como 403 con el header en cero; sin
    // esto se leería como un problema de permisos y el operador buscaría donde no es.
    if (res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
      throw new GitHubIssuesRateLimitError();
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // El mensaje nunca incluye el token: sólo lo que contestó GitHub.
      throw new GitHubIssuesApiError(res.status, `GitHub API error ${res.status}: ${text}`);
    }

    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
}

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------

function withAcceptanceCriteria(description: string, criteria: string[]): string {
  if (criteria.length === 0) return description;
  const checklist = criteria.map((c) => `- [ ] ${c}`).join('\n');
  return `${description}\n\n## Acceptance criteria\n\n${checklist}`;
}

/** La API devuelve labels como objetos, pero algunos endpoints las dan como strings. */
function labelNames(issue: GitHubIssueResponse): string[] {
  return (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
}

function matchesState(nativeState: string, wanted: GitHubIssueState): boolean {
  return wanted === 'open' ? nativeState === 'open' : nativeState === 'closed';
}
