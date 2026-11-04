import type { DocPublishInput, DocRef, DocStoreAdapter, DocStoreKind } from '@sdlc/adapters-contracts';
import type { TenantCtx } from '@sdlc/adapters-contracts';

// Doc store sobre un repo de GitHub: cada PRD / RFC / ADR / nota de cambio es un
// archivo markdown commiteado con la Contents API.
//
// Decisiones:
//
// - **El `id` es el path del archivo**, no un sha. `verify_artifact` llama
//   `fetch(id)` para comparar el hash del submit contra lo que hay *hoy*: tiene que
//   leer la última versión en la rama, que es justamente lo que detecta una
//   edición posterior. El sha del commit va en `version`, como trazabilidad.
// - **Un commit por publish, directo a la rama.** Sin PR: el documento ya pasó el
//   validador del MCP y su gate es el de la fase, no un review de git. Si la rama
//   por default está protegida, `settings.branch` apunta a otra (tiene que existir).
// - **`fetch` baja los bytes crudos** (`application/vnd.github.raw+json`), no el
//   base64 del JSON: el hash de `verify_artifact` se calcula sobre esos bytes.
// - **Los segmentos de carpeta se validan**: `folder_path` sale de nombres de
//   group/workspace, y un `..` o una `/` adentro de uno escribiría fuera de
//   `basePath`.

export interface GitHubRepoDocStoreAdapterOptions {
  token: string;
  owner: string;
  repo: string;
  /** Rama donde se commitean los docs. Sin valor: la rama por default del repo. */
  branch?: string;
  /** Carpeta raíz de los docs dentro del repo. Default `docs/sdlc`. */
  basePath?: string;
  /** Para GitHub Enterprise. Default `https://api.github.com`. */
  apiBaseUrl?: string;
}

class GitHubRepoDocStoreError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function checkSegment(segment: string): string {
  if (!segment || segment === '.' || segment === '..' || /[/\\]/.test(segment)) {
    throw new Error(`github-repo doc store: segmento de carpeta inválido "${segment}"`);
  }
  return segment;
}

export class GitHubRepoDocStoreAdapter implements DocStoreAdapter {
  readonly kind: DocStoreKind = 'github-repo';

  private readonly basePath: string[];
  private readonly apiBase: string;

  constructor(private readonly opts: GitHubRepoDocStoreAdapterOptions) {
    this.basePath = (opts.basePath ?? 'docs/sdlc').split('/').filter(Boolean).map(checkSegment);
    this.apiBase = (opts.apiBaseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  }

  async publish(input: DocPublishInput, _ctx: TenantCtx): Promise<DocRef> {
    if (input.doc_kind === 'adr' && !input.adr_filename) {
      throw new Error('adr_filename is required for ADR documents');
    }
    const file = input.doc_kind === 'adr' ? input.adr_filename! : `${input.doc_kind}.md`;
    const segments = [
      ...this.basePath,
      ...(input.folder_path ?? []).map(checkSegment),
      checkSegment(input.flow_folder),
      ...(input.doc_kind === 'adr' ? ['adr'] : []),
      checkSegment(file),
    ];
    const path = segments.join('/');

    const existing = (await this.request(this.contentsUrl(path), { method: 'GET' }, { allow404: true })) as
      | { sha?: string }
      | undefined;

    const res = (await this.request(this.contentsUrl(path, false), {
      method: 'PUT',
      body: JSON.stringify({
        message: `docs(sdlc): ${input.title}`,
        content: Buffer.from(input.markdown, 'utf8').toString('base64'),
        ...(existing?.sha ? { sha: existing.sha } : {}),
        ...(this.opts.branch ? { branch: this.opts.branch } : {}),
      }),
    })) as { content?: { path?: string; html_url?: string }; commit?: { sha?: string } };

    if (!res.content?.html_url) {
      throw new Error(`GitHub no devolvió html_url al publicar "${path}"`);
    }
    return {
      id: res.content.path ?? path,
      url: res.content.html_url,
      ...(res.commit?.sha ? { version: res.commit.sha } : {}),
    };
  }

  async fetch(id: string, _ctx: TenantCtx): Promise<{ markdown: string; version: string }> {
    const markdown = (await this.request(
      this.contentsUrl(id),
      { method: 'GET', headers: { Accept: 'application/vnd.github.raw+json' } },
      { raw: true },
    )) as string | undefined;
    if (markdown === undefined) {
      throw new Error(`El documento no existe en ${this.opts.owner}/${this.opts.repo}: ${id}`);
    }
    return { markdown, version: id };
  }

  /** `withRef`: los GET leen de la rama configurada; el PUT la lleva en el body. */
  private contentsUrl(path: string, withRef = true): string {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const owner = encodeURIComponent(this.opts.owner);
    const repo = encodeURIComponent(this.opts.repo);
    const ref = withRef && this.opts.branch ? `?ref=${encodeURIComponent(this.opts.branch)}` : '';
    return `${this.apiBase}/repos/${owner}/${repo}/contents/${encoded}${ref}`;
  }

  private async request(
    url: string,
    init: RequestInit,
    opts: { allow404?: boolean; raw?: boolean } = {},
  ): Promise<unknown> {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        ...((init.headers ?? {}) as Record<string, string>),
      },
    });

    // Mensajes seguros: nunca incluyen el header Authorization.
    if (res.status === 404 && (opts.allow404 || opts.raw)) return undefined;
    if (res.status === 401 || res.status === 403) {
      throw new GitHubRepoDocStoreError(res.status, `GitHub auth failed (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new GitHubRepoDocStoreError(res.status, `GitHub API error ${res.status}: ${body}`);
    }
    const text = await res.text();
    if (opts.raw) return text;
    return text ? (JSON.parse(text) as unknown) : {};
  }
}
