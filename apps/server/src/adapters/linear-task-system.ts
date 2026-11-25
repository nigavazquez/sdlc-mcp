import type {
  Annotation,
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
import { findAnnotationMarker } from '@sdlc/adapters-contracts';

// ---------------------------------------------------------------------------
// Mapeo del contrato al modelo de Linear — y qué se pierde
// ---------------------------------------------------------------------------
//
// Linear no tiene tres tipos de work item: tiene Issues dentro de un Team, y un
// Issue puede colgar de otro vía `parentId`. Así que los tres niveles del
// contrato son tres Issues encadenados:
//
//   epic     → Issue sin parent
//   story    → Issue con parent (el epic)
//   subtask  → Issue con parent (la story)
//
// Consecuencias, explícitas:
//
// - **El tipo se infiere de la profundidad del padre**, no de un campo. `getItem`
//   pide `parent { id parent { id } }` en la misma query: sin padre → epic, con
//   padre y sin abuelo → story, más hondo → subtask. Lo que se pierde: un issue
//   creado a mano en Linear, fuera de este server, se lee como `epic` sólo por no
//   tener padre. Es el precio de no ensuciar cada issue con una label de tipo.
// - **`project_key` se ignora**: el Team es el del adapter (`settings.teamId`),
//   igual que el adapter de ADO ignora `project_key` y usa `settings.project`.
//   Opcionalmente `settings.projectId` adjunta los issues a un Project de Linear.
// - **Los criterios de aceptación no tienen campo propio**: van al final de la
//   descripción como checklist markdown. Se pierde que sean un campo estructurado
//   (nadie puede filtrar por ellos), pero se leen y se tildan en la UI.
// - **`external_id` es el UUID del issue, no el identifier humano** (`ENG-42`).
//   Es lo que la API acepta en todas las mutations; el `ENG-42` vive en la `url`.
// - **Los estados no se inventan**: `transition` traduce el vocabulario del server
//   a un nombre de workflow state del team y falla explícito, listando los estados
//   que sí existen, si el team no tiene ese estado. Antes que simular un estado
//   inexistente, el operador configura `stateMap`.

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

export class LinearApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LinearApiError';
  }
}

export class LinearRateLimitError extends Error {
  constructor() {
    super('Linear rate limit reached; retry later');
    this.name = 'LinearRateLimitError';
  }
}

// ---------------------------------------------------------------------------
// Opciones
// ---------------------------------------------------------------------------

export interface LinearAdapterOptions {
  /** Personal API key (`lin_api_…`) o access token OAuth. */
  apiKey: string;
  /** UUID del Team de Linear donde se crean los issues. */
  teamId: string;
  /** UUID opcional de un Project de Linear al que adjuntar los issues creados. */
  projectId?: string;
  /** Override del endpoint GraphQL (tests / proxies). */
  apiUrl?: string;
  /** status del contrato → nombre del workflow state en Linear. */
  stateMap?: Record<string, string>;
}

/**
 * El server habla el vocabulario de estados de Azure DevOps (`Active`,
 * `Resolved`, `Closed`, `Removed`: ver report-progress, claim-story,
 * submit-qa-results y discard-story). El default traduce ese vocabulario al
 * workflow por defecto de Linear; un team con otros nombres lo sobrescribe con
 * `settings.stateMap`.
 */
/** Páginas de 100 comentarios; el tope evita un loop sin fin ante una API que no corta. */
const MAX_COMMENT_PAGES = 50;

const DEFAULT_STATE_MAP: Record<string, string> = {
  New: 'Todo',
  Active: 'In Progress',
  Resolved: 'In Review',
  Closed: 'Done',
  Removed: 'Canceled',
};

// ---------------------------------------------------------------------------
// Shapes de la API de Linear que consumimos
// ---------------------------------------------------------------------------

interface LinearIssueNode {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string | null;
  state: { name: string } | null;
  labels?: { nodes: Array<{ name: string }> };
  parent?: { id: string; parent?: { id: string } | null } | null;
}

const ISSUE_FIELDS = `
  id
  identifier
  url
  title
  description
  state { name }
  labels { nodes { name } }
  parent { id parent { id } }
`;

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class LinearTaskSystemAdapter implements TaskSystemAdapter {
  readonly kind: TaskSystemKind = 'linear';

  private readonly apiKey: string;
  private readonly teamId: string;
  private readonly projectId: string | undefined;
  private readonly apiUrl: string;
  private readonly stateMap: Record<string, string>;

  /** Caches por instancia; la instancia vive lo que dura la llamada a la tool. */
  private labelIdsByName: Map<string, string> | undefined;
  private stateIdsByName: Map<string, string> | undefined;
  /** Nombres tal cual los devolvió Linear, para el mensaje de error. */
  private stateNames: string[] = [];

  constructor(opts: LinearAdapterOptions) {
    if (!opts.apiKey || !opts.teamId) {
      throw new Error('linear adapter: missing required settings.teamId / secret (apiKey)');
    }
    this.apiKey = opts.apiKey;
    this.teamId = opts.teamId;
    this.projectId = opts.projectId;
    this.apiUrl = opts.apiUrl ?? 'https://api.linear.app/graphql';
    this.stateMap = { ...DEFAULT_STATE_MAP, ...(opts.stateMap ?? {}) };
  }

  /** Expuesto sólo para los tests del provider. */
  teamIdentifier(): string {
    return this.teamId;
  }

  // -------------------------------------------------------------------------
  // Contrato
  // -------------------------------------------------------------------------

  async createEpic(input: EpicInput, _ctx: TenantCtx): Promise<ExternalRef> {
    return this.createIssue({
      title: input.title,
      description: input.description,
      ...(input.labels ? { labels: input.labels } : {}),
    });
  }

  async createStory(input: StoryInput, _ctx: TenantCtx): Promise<ExternalRef> {
    return this.createIssue({
      title: input.title,
      description: withAcceptanceCriteria(input.description, input.acceptance_criteria),
      parentId: input.epic_id,
      ...(input.labels ? { labels: input.labels } : {}),
      ...(input.estimate !== undefined ? { estimate: input.estimate } : {}),
    });
  }

  async createSubtask(input: SubtaskInput, _ctx: TenantCtx): Promise<ExternalRef> {
    return this.createIssue({
      title: input.title,
      description: input.description ?? '',
      parentId: input.parent_story_id,
    });
  }

  async linkChildToParent(parentId: string, childId: string, _ctx: TenantCtx): Promise<void> {
    await this.gql<{ issueUpdate: { success: boolean } }>(
      `mutation SdlcLinkChild($id: String!, $input: IssueUpdateInput!) {
         issueUpdate(id: $id, input: $input) { success }
       }`,
      { id: childId, input: { parentId } },
    );
  }

  async getItem(id: string, _ctx: TenantCtx): Promise<TaskItem> {
    const data = await this.gql<{ issue: LinearIssueNode | null }>(
      `query SdlcIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
      { id },
    );
    if (!data.issue) throw new LinearApiError(404, `linear adapter: issue not found: ${id}`);
    return mapIssue(data.issue);
  }

  /**
   * Labels + comentario en el issue (historia #25).
   *
   * Las labels que el team no tiene se crean (como al crear issues) y se agregan una
   * por una con `issueAddLabel`, que no duplica. Si el body tiene marcador, se busca un
   * comentario con ese marcador y se actualiza en vez de duplicarlo.
   */
  async annotate(id: string, annotation: Annotation, _ctx: TenantCtx): Promise<void> {
    if (annotation.labels.length > 0) {
      for (const labelId of await this.resolveLabelIds(annotation.labels)) {
        const data = await this.gql<{ issueAddLabel: { success: boolean } }>(
          `mutation SdlcAddLabel($id: String!, $labelId: String!) {
             issueAddLabel(id: $id, labelId: $labelId) { success }
           }`,
          { id, labelId },
        );
        if (!data.issueAddLabel?.success) {
          throw new LinearApiError(200, 'linear adapter: issueAddLabel returned success=false');
        }
      }
    }

    if (!annotation.body) return;

    const marker = findAnnotationMarker(annotation.body);
    const existing = marker ? await this.findCommentWithMarker(id, marker) : undefined;
    if (existing !== undefined) {
      const data = await this.gql<{ commentUpdate: { success: boolean } }>(
        `mutation SdlcUpdateComment($id: String!, $input: CommentUpdateInput!) {
           commentUpdate(id: $id, input: $input) { success }
         }`,
        { id: existing, input: { body: annotation.body } },
      );
      if (!data.commentUpdate?.success) {
        throw new LinearApiError(200, 'linear adapter: commentUpdate returned success=false');
      }
      return;
    }
    const data = await this.gql<{ commentCreate: { success: boolean } }>(
      `mutation SdlcCreateComment($input: CommentCreateInput!) {
         commentCreate(input: $input) { success }
       }`,
      { input: { issueId: id, body: annotation.body } },
    );
    if (!data.commentCreate?.success) {
      throw new LinearApiError(200, 'linear adapter: commentCreate returned success=false');
    }
  }

  async transition(id: string, status: string, _ctx: TenantCtx): Promise<void> {
    const stateName = this.stateMap[status] ?? status;
    const stateId = await this.resolveStateId(stateName);
    await this.gql<{ issueUpdate: { success: boolean } }>(
      `mutation SdlcTransition($id: String!, $input: IssueUpdateInput!) {
         issueUpdate(id: $id, input: $input) { success }
       }`,
      { id, input: { stateId } },
    );
  }

  async search(query: TaskQuery, _ctx: TenantCtx): Promise<TaskItem[]> {
    const filter: Record<string, unknown> = { team: { id: { eq: this.teamId } } };
    if (query.status !== undefined) {
      filter.state = { name: { eq: this.stateMap[query.status] ?? query.status } };
    }
    if (query.text !== undefined) filter.title = { contains: query.text };
    if (query.parent_id !== undefined) filter.parent = { id: { eq: query.parent_id } };

    const data = await this.gql<{ issues: { nodes: LinearIssueNode[] } }>(
      `query SdlcSearch($filter: IssueFilter, $first: Int) {
         issues(filter: $filter, first: $first) { nodes { ${ISSUE_FIELDS} } }
       }`,
      { filter, first: query.limit ?? 50 },
    );
    return (data.issues.nodes ?? []).map(mapIssue);
  }

  // -------------------------------------------------------------------------
  // Privados
  // -------------------------------------------------------------------------

  private async createIssue(args: {
    title: string;
    description: string;
    parentId?: string;
    labels?: string[];
    estimate?: number;
  }): Promise<ExternalRef> {
    const input: Record<string, unknown> = {
      teamId: this.teamId,
      title: args.title,
      description: args.description,
    };
    if (this.projectId) input.projectId = this.projectId;
    if (args.parentId) input.parentId = args.parentId;
    if (args.estimate !== undefined) input.estimate = args.estimate;
    if (args.labels && args.labels.length > 0) {
      input.labelIds = await this.resolveLabelIds(args.labels);
    }

    const data = await this.gql<{
      issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } | null };
    }>(
      `mutation SdlcCreateIssue($input: IssueCreateInput!) {
         issueCreate(input: $input) { success issue { id identifier url } }
       }`,
      { input },
    );

    const issue = data.issueCreate?.issue;
    if (!data.issueCreate?.success || !issue) {
      throw new LinearApiError(200, 'linear adapter: issueCreate returned success=false');
    }
    return { external_id: issue.id, url: issue.url };
  }

  /** Nombres → ids de IssueLabel, creando las que el team todavía no tiene. */
  private async resolveLabelIds(names: string[]): Promise<string[]> {
    if (!this.labelIdsByName) {
      const data = await this.gql<{ team: { labels: { nodes: Array<{ id: string; name: string }> } } | null }>(
        `query SdlcTeamLabels($teamId: String!) {
           team(id: $teamId) { labels(first: 250) { nodes { id name } } }
         }`,
        { teamId: this.teamId },
      );
      this.labelIdsByName = new Map(
        (data.team?.labels.nodes ?? []).map((l) => [l.name.toLowerCase(), l.id]),
      );
    }

    const ids: string[] = [];
    for (const name of names) {
      const cached = this.labelIdsByName.get(name.toLowerCase());
      if (cached) {
        ids.push(cached);
        continue;
      }
      const created = await this.gql<{
        issueLabelCreate: { success: boolean; issueLabel: { id: string; name: string } | null };
      }>(
        `mutation SdlcCreateLabel($input: IssueLabelCreateInput!) {
           issueLabelCreate(input: $input) { success issueLabel { id name } }
         }`,
        { input: { name, teamId: this.teamId } },
      );
      const label = created.issueLabelCreate?.issueLabel;
      if (!label) {
        throw new LinearApiError(200, `linear adapter: could not create label "${name}"`);
      }
      this.labelIdsByName.set(name.toLowerCase(), label.id);
      ids.push(label.id);
    }
    return ids;
  }

  /** Pagina los comentarios del issue; el tope evita un loop sin fin. */
  private async findCommentWithMarker(issueId: string, marker: string): Promise<string | undefined> {
    let after: string | null = null;
    for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
      const data: {
        issue: {
          comments: {
            nodes: Array<{ id: string; body?: string | null }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        } | null;
      } = await this.gql(
        `query SdlcIssueComments($id: String!, $after: String) {
           issue(id: $id) {
             comments(first: 100, after: $after) { nodes { id body } pageInfo { hasNextPage endCursor } }
           }
         }`,
        { id: issueId, after },
      );
      if (!data.issue) throw new LinearApiError(404, `linear adapter: issue not found: ${issueId}`);
      const found = data.issue.comments.nodes.find((c) => (c.body ?? '').includes(marker));
      if (found) return found.id;
      if (!data.issue.comments.pageInfo.hasNextPage) return undefined;
      after = data.issue.comments.pageInfo.endCursor;
    }
    return undefined;
  }

  /** Nombre de workflow state → id. Falla explícito si el team no lo tiene. */
  private async resolveStateId(stateName: string): Promise<string> {
    if (!this.stateIdsByName) {
      const data = await this.gql<{ team: { states: { nodes: Array<{ id: string; name: string }> } } | null }>(
        `query SdlcTeamStates($teamId: String!) {
           team(id: $teamId) { states(first: 100) { nodes { id name } } }
         }`,
        { teamId: this.teamId },
      );
      const nodes = data.team?.states.nodes ?? [];
      this.stateIdsByName = new Map(nodes.map((s) => [s.name.toLowerCase(), s.id]));
      this.stateNames = nodes.map((s) => s.name);
    }
    const id = this.stateIdsByName.get(stateName.toLowerCase());
    if (!id) {
      const available = this.stateNames.join(', ');
      throw new LinearApiError(
        422,
        `linear adapter: el team ${this.teamId} no tiene un workflow state "${stateName}". ` +
          `Estados disponibles: ${available || '(ninguno)'}. ` +
          'Configurá settings.stateMap para mapear el status del server a uno de ellos.',
      );
    }
    return id;
  }

  private authHeader(): string {
    // Personal API key: va cruda. Access token OAuth: va como Bearer.
    return this.apiKey.startsWith('lin_api_') ? this.apiKey : `Bearer ${this.apiKey}`;
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 429) throw new LinearRateLimitError();
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LinearApiError(res.status, `Linear API error ${res.status}: ${text}`);
    }

    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors && json.errors.length > 0) {
      // GraphQL responde 200 con errors[]: sin esto, un "Entity not found" se
      // leería como éxito con data vacía.
      throw new LinearApiError(200, `Linear GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    if (!json.data) throw new LinearApiError(200, 'Linear GraphQL response without data');
    return json.data;
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

function mapIssue(issue: LinearIssueNode): TaskItem {
  const parentId = issue.parent?.id;
  const type: TaskItem['type'] = !parentId ? 'epic' : issue.parent?.parent?.id ? 'subtask' : 'story';

  return {
    external_id: issue.id,
    url: issue.url,
    title: issue.title,
    description: issue.description ?? '',
    status: issue.state?.name ?? '',
    type,
    ...(parentId !== undefined ? { parent_id: parentId } : {}),
    labels: (issue.labels?.nodes ?? []).map((l) => l.name),
  };
}
