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
// Security helpers
// ---------------------------------------------------------------------------

/**
 * Escape a string value for safe interpolation inside a WIQL single-quoted
 * string literal.  WIQL escapes a literal single quote by doubling it.
 */
function wiqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Escape user-supplied text before embedding it in an HTML field stored in
 * ADO (e.g. AcceptanceCriteria, Description stored as HTML).
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class AdoApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdoApiError';
  }
}

export class AdoRateLimitError extends Error {
  constructor() {
    super('ADO rate limit reached; retry later');
    this.name = 'AdoRateLimitError';
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AzureDevOpsAdapterOptions {
  org: string;
  project: string;
  pat: string;
  /** Work-item type name overrides (default: Agile template). */
  epicType?: string;
  storyType?: string;
  subtaskType?: string;
  /** Maps contract state strings to ADO state strings. Default: identity. */
  stateMap?: Record<string, string>;
  /** Area path override (omitted = ADO project root). */
  areaPath?: string;
  /** Iteration path override (omitted = ADO project root). */
  iterationPath?: string;
}

// ---------------------------------------------------------------------------
// Internal ADO response type
// ---------------------------------------------------------------------------

interface AdoWorkItemResponse {
  id: number;
  rev?: number;
  url: string;
  fields: Record<string, string>;
  relations?: Array<{ rel: string; url: string }>;
}

/** La API de comentarios de work items sigue en preview en 7.1. */
const COMMENTS_API_VERSION = 'api-version=7.1-preview.4';
/** Páginas de 200 comentarios; el tope evita un loop sin fin ante una API que no corta. */
const MAX_COMMENT_PAGES = 50;

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class AzureDevOpsTaskSystemAdapter implements TaskSystemAdapter {
  readonly kind: TaskSystemKind = 'azure-devops';

  private readonly org: string;
  private readonly project: string;
  private readonly authHeader: string;
  private readonly epicType: string;
  private readonly storyType: string;
  private readonly subtaskType: string;
  private readonly stateMap: Record<string, string>;
  private readonly areaPath: string | undefined;
  private readonly iterationPath: string | undefined;

  constructor(opts: AzureDevOpsAdapterOptions) {
    if (!opts.org || !opts.project) {
      throw new Error('azure-devops adapter: missing required settings.org / settings.project');
    }
    this.org = opts.org;
    this.project = opts.project;
    this.authHeader = `Basic ${Buffer.from(`:${opts.pat}`).toString('base64')}`;
    this.epicType = opts.epicType ?? 'Epic';
    this.storyType = opts.storyType ?? 'User Story';
    this.subtaskType = opts.subtaskType ?? 'Task';
    this.stateMap = opts.stateMap ?? {};
    this.areaPath = opts.areaPath;
    this.iterationPath = opts.iterationPath;
  }

  /** Exposed for provider tests only. */
  orgName(): string { return this.org; }
  projectName(): string { return this.project; }

  async createEpic(input: EpicInput, _ctx: TenantCtx): Promise<ExternalRef> {
    const url = `${this.baseUrl()}/workitems/${encodeURIComponent(`$${this.epicType}`)}?api-version=7.1`;
    const fields: Record<string, unknown> = {
      'System.Title': input.title,
      'System.Description': input.description,
    };
    if (input.labels && input.labels.length > 0) {
      fields['System.Tags'] = input.labels.join('; ');
    }
    const wi = await this.request<{ id: number }>(url, {
      method: 'POST',
      body: this.patchBody(fields),
    });
    return this.externalRef(wi.id);
  }

  async createStory(input: StoryInput, _ctx: TenantCtx): Promise<ExternalRef> {
    const url = `${this.baseUrl()}/workitems/${encodeURIComponent(`$${this.storyType}`)}?api-version=7.1`;
    const acHtml =
      input.acceptance_criteria.length > 0
        ? `<ul>${input.acceptance_criteria.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>`
        : undefined;
    const fields: Record<string, unknown> = {
      'System.Title': input.title,
      'System.Description': input.description,
      'Microsoft.VSTS.Common.AcceptanceCriteria': acHtml,
    };
    if (input.labels && input.labels.length > 0) {
      fields['System.Tags'] = input.labels.join('; ');
    }
    if (input.estimate !== undefined) {
      fields['Microsoft.VSTS.Scheduling.StoryPoints'] = input.estimate;
    }
    const wi = await this.request<{ id: number }>(url, {
      method: 'POST',
      body: this.patchBody(fields),
    });
    return this.externalRef(wi.id);
  }

  async createSubtask(input: SubtaskInput, _ctx: TenantCtx): Promise<ExternalRef> {
    const url = `${this.baseUrl()}/workitems/${encodeURIComponent(`$${this.subtaskType}`)}?api-version=7.1`;
    const fields: Record<string, unknown> = {
      'System.Title': input.title,
      ...(input.description ? { 'System.Description': input.description } : {}),
    };
    const wi = await this.request<{ id: number }>(url, {
      method: 'POST',
      body: this.patchBody(fields),
    });
    return this.externalRef(wi.id);
  }

  async linkChildToParent(parentId: string, childId: string, _ctx: TenantCtx): Promise<void> {
    const url = `${this.baseUrl()}/workitems/${childId}?api-version=7.1`;
    const body = [
      {
        op: 'add',
        path: '/relations/-',
        value: {
          rel: 'System.LinkTypes.Hierarchy-Reverse',
          url: this.workItemUrl(parentId),
        },
      },
    ];
    await this.request<unknown>(url, { method: 'PATCH', body });
  }

  async getItem(id: string, _ctx: TenantCtx): Promise<TaskItem> {
    const url = `${this.baseUrl()}/workitems/${id}?api-version=7.1&$expand=relations`;
    const wi = await this.request<AdoWorkItemResponse>(url, { method: 'GET' });
    return this.mapWorkItem(wi);
  }

  /**
   * Tag + comentario en el work item (historia #25).
   *
   * Los tags se agregan a los que ya tiene, con `test /rev` para no pisar un cambio
   * concurrente. Si el body tiene marcador, se busca un comentario con ese marcador y
   * se actualiza en vez de duplicarlo. Los comentarios van en markdown.
   */
  async annotate(id: string, annotation: Annotation, _ctx: TenantCtx): Promise<void> {
    if (!/^\d+$/.test(id)) throw new AdoApiError(400, `annotate: id de work item inválido: ${id}`);

    if (annotation.labels.length > 0) {
      const wi = await this.request<AdoWorkItemResponse>(
        `${this.baseUrl()}/workitems/${id}?api-version=7.1&fields=System.Tags`,
        { method: 'GET' },
      );
      const current = (wi.fields['System.Tags'] ?? '')
        .split(';')
        .map((t) => t.trim())
        .filter(Boolean);
      const have = new Set(current.map((t) => t.toLowerCase()));
      const missing = annotation.labels.filter((l) => !have.has(l.toLowerCase()));
      if (missing.length > 0) {
        await this.request<unknown>(`${this.baseUrl()}/workitems/${id}?api-version=7.1`, {
          method: 'PATCH',
          body: [
            { op: 'test', path: '/rev', value: wi.rev },
            this.pathOp('System.Tags', [...current, ...missing].join('; ')),
          ],
        });
      }
    }

    if (!annotation.body) return;

    const commentsUrl = `${this.baseUrl()}/workItems/${id}/comments`;
    const marker = findAnnotationMarker(annotation.body);
    const existing = marker ? await this.findCommentWithMarker(commentsUrl, marker) : undefined;
    if (existing !== undefined) {
      await this.request<unknown>(`${commentsUrl}/${existing}?format=markdown&${COMMENTS_API_VERSION}`, {
        method: 'PATCH',
        body: { text: annotation.body },
        contentType: 'application/json',
      });
    } else {
      await this.request<unknown>(`${commentsUrl}?format=markdown&${COMMENTS_API_VERSION}`, {
        method: 'POST',
        body: { text: annotation.body },
        contentType: 'application/json',
      });
    }
  }

  /** Recorre los comentarios con el continuation token; el tope evita un loop sin fin. */
  private async findCommentWithMarker(commentsUrl: string, marker: string): Promise<number | undefined> {
    let token: string | undefined;
    for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
      const url =
        `${commentsUrl}?${COMMENTS_API_VERSION}&$top=200` +
        (token ? `&continuationToken=${encodeURIComponent(token)}` : '');
      const data = await this.request<{
        comments?: Array<{ id: number; text?: string | null }>;
        continuationToken?: string | null;
      }>(url, { method: 'GET' });
      const found = (data.comments ?? []).find((c) => (c.text ?? '').includes(marker));
      if (found) return found.id;
      if (!data.continuationToken) return undefined;
      token = data.continuationToken;
    }
    return undefined;
  }

  async transition(id: string, status: string, _ctx: TenantCtx): Promise<void> {
    const url = `${this.baseUrl()}/workitems/${id}?api-version=7.1`;
    const mappedState = this.mapState(status);
    await this.request<unknown>(url, {
      method: 'PATCH',
      body: [{ op: 'add', path: '/fields/System.State', value: mappedState }],
    });
  }

  async search(query: TaskQuery, _ctx: TenantCtx): Promise<TaskItem[]> {
    // Allowlist guard: ADO state names are short identifiers; reject anything
    // that looks like an injection attempt before even building the query.
    if (query.status !== undefined && !/^[A-Za-z0-9 _-]+$/.test(query.status)) {
      throw new AdoApiError(400, 'invalid status filter');
    }

    const topClause = query.limit !== undefined ? `TOP ${query.limit}` : 'TOP 200';
    const conditions: string[] = [
      `[System.TeamProject] = '${wiqlEscape(this.project)}'`,
    ];
    if (query.status) conditions.push(`[System.State] = '${wiqlEscape(query.status)}'`);
    if (query.text) conditions.push(`[System.Title] CONTAINS '${wiqlEscape(query.text)}'`);

    const whereClause = conditions.join(' AND ');
    const wiqlUrl = `${this.baseUrl()}/wiql?api-version=7.1`;
    const wiqlBody = { query: `SELECT ${topClause} [System.Id] FROM workitems WHERE ${whereClause} ORDER BY [System.ChangedDate] DESC` };

    const wiqlResult = await this.request<{ workItems: Array<{ id: number; url: string }> }>(
      wiqlUrl,
      { method: 'POST', body: wiqlBody, contentType: 'application/json' },
    );

    if (!wiqlResult.workItems || wiqlResult.workItems.length === 0) return [];

    const ids = wiqlResult.workItems.map((wi) => wi.id);
    const batchUrl = `${this.baseUrl()}/workitemsbatch?api-version=7.1`;
    const batchResult = await this.request<{ value: AdoWorkItemResponse[] }>(
      batchUrl,
      {
        method: 'POST',
        body: { ids, $expand: 'relations' },
        contentType: 'application/json',
      },
    );

    let items = (batchResult.value ?? []).map((wi) => this.mapWorkItem(wi));

    // Post-filter: parent_id (WIQL cannot directly filter by parent relation)
    if (query.parent_id !== undefined) {
      items = items.filter((i) => i.parent_id === query.parent_id);
    }

    return items;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  protected baseUrl(): string {
    return `https://dev.azure.com/${encodeURIComponent(this.org)}/${encodeURIComponent(this.project)}/_apis/wit`;
  }

  protected workItemUrl(id: string | number): string {
    return `https://dev.azure.com/${encodeURIComponent(this.org)}/_apis/wit/workItems/${id}`;
  }

  protected mapState(status: string): string {
    return this.stateMap[status] ?? status;
  }

  protected async request<T>(
    url: string,
    opts: {
      method: 'GET' | 'POST' | 'PATCH';
      body?: unknown;
      contentType?: string;
    },
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: 'application/json',
    };
    if (opts.body !== undefined) {
      headers['Content-Type'] = opts.contentType ?? 'application/json-patch+json';
    }
    const res = await fetch(url, {
      method: opts.method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    if (res.status === 429) throw new AdoRateLimitError();
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AdoApiError(res.status, `ADO API error ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  protected pathOp(field: string, value: unknown): object {
    return { op: 'add', path: `/fields/${field}`, value };
  }

  protected patchBody(fields: Record<string, unknown>): object[] {
    const ops: object[] = Object.entries(fields)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => this.pathOp(k, v));
    if (this.areaPath) ops.push(this.pathOp('System.AreaPath', this.areaPath));
    if (this.iterationPath) ops.push(this.pathOp('System.IterationPath', this.iterationPath));
    return ops;
  }

  protected externalRef(id: number): ExternalRef {
    return {
      external_id: String(id),
      url: `https://dev.azure.com/${this.org}/${this.project}/_workitems/edit/${id}`,
    };
  }

  private mapWorkItem(wi: AdoWorkItemResponse): TaskItem {
    const fields = wi.fields;
    const typeName = fields['System.WorkItemType'] ?? '';
    const type: TaskItem['type'] =
      typeName === this.epicType
        ? 'epic'
        : typeName === this.storyType
          ? 'story'
          : 'subtask';

    const tagsRaw: string = fields['System.Tags'] ?? '';
    const labels = tagsRaw
      .split(';')
      .map((t) => t.trim())
      .filter(Boolean);

    const parentRel = wi.relations?.find(
      (r) => r.rel === 'System.LinkTypes.Hierarchy-Reverse',
    );
    const parent_id = parentRel
      ? String(parentRel.url.split('/').pop())
      : undefined;

    return {
      external_id: String(wi.id),
      url: `https://dev.azure.com/${this.org}/${this.project}/_workitems/edit/${wi.id}`,
      title: fields['System.Title'] ?? '',
      description: fields['System.Description'] ?? '',
      status: fields['System.State'] ?? '',
      type,
      ...(parent_id !== undefined ? { parent_id } : {}),
      labels,
    };
  }
}
