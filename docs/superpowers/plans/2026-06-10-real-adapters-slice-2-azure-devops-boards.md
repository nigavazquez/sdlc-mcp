# Real Adapters — Slice 2: Azure DevOps Boards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `NotImplementedError` placeholder in `ConfigBackedTaskSystemProvider`'s `azure-devops` branch with a real `AzureDevOpsTaskSystemAdapter` that implements the full `TaskSystemAdapter` contract against the ADO Work Item Tracking REST API, using native `fetch`.

**Architecture:** `AzureDevOpsTaskSystemAdapter` is a stateless class constructed fresh per `resolve()` call, receiving `{ org, project, pat }` from the provider. It calls the ADO REST API v7.1 for CRUD and state transitions on Epics, User Stories, and Tasks. All HTTP is mocked in unit tests via `vi.stubGlobal('fetch', ...)`. An optional live integration test is gated on `ADO_TEST_ORG`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, native `fetch` (Node 20+), no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-06-10-real-adapters-slice-2-azure-devops-boards-design.md`

---

## File Structure

**Create:**
- `apps/server/src/adapters/azure-devops-task-system.ts` — `AzureDevOpsTaskSystemAdapter`, `AzureDevOpsAdapterOptions`, `AdoApiError`, `AdoRateLimitError`.
- `apps/server/test/azure-devops-task-system.test.ts` — unit tests (fetch mocked).
- `apps/server/test/azure-devops-task-system.integration.test.ts` — live integration tests (gated on `ADO_TEST_ORG`, SKIP by default).

**Modify:**
- `apps/server/src/adapters/task-system-provider.ts` — replace the `NotImplementedError` branch with construction of `AzureDevOpsTaskSystemAdapter`. **SHARED FILE:** last modified in Slice 1 (merged). Slices 3 and 4 do NOT touch this file — no merge conflict anticipated.
- `apps/server/src/adapters/index.ts` — export the new adapter and its error types.

**No new DB migration needed.** The `tenant_integrations` table (migration `0003`, Slice 1) already supports the `azure-devops` config. Migration `0004` is not claimed by Slice 2.

---

## Task 1: AdoApiError + AdoRateLimitError + private request helper (TDD)

**Files:**
- Create: `apps/server/src/adapters/azure-devops-task-system.ts` (skeleton + errors + `request` helper only)
- Test: `apps/server/test/azure-devops-task-system.test.ts` (error-path tests only)

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/azure-devops-task-system.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AzureDevOpsTaskSystemAdapter } from '../src/adapters/azure-devops-task-system.js';
import {
  AdoApiError,
  AdoRateLimitError,
} from '../src/adapters/azure-devops-task-system.js';

const BASE_OPTS = {
  org: 'my-org',
  project: 'my-project',
  pat: 'secret-pat',
};

function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('AzureDevOpsTaskSystemAdapter — error handling', () => {
  afterEach(() => vi.restoreAllMocks());

  it('throws AdoRateLimitError on HTTP 429', async () => {
    vi.stubGlobal('fetch', mockFetch(429, { message: 'Rate limited' }));
    const adapter = new AzureDevOpsTaskSystemAdapter(BASE_OPTS);
    await expect(
      adapter.getItem('1', { tenantId: 't1', userId: 'u', roles: [], resolveSecret: async () => '' }),
    ).rejects.toBeInstanceOf(AdoRateLimitError);
  });

  it('throws AdoApiError on HTTP 404', async () => {
    vi.stubGlobal('fetch', mockFetch(404, { message: 'Not found' }));
    const adapter = new AzureDevOpsTaskSystemAdapter(BASE_OPTS);
    await expect(
      adapter.getItem('999', { tenantId: 't1', userId: 'u', roles: [], resolveSecret: async () => '' }),
    ).rejects.toBeInstanceOf(AdoApiError);
  });

  it('throws AdoApiError on HTTP 400', async () => {
    vi.stubGlobal('fetch', mockFetch(400, { message: 'Invalid state' }));
    const adapter = new AzureDevOpsTaskSystemAdapter(BASE_OPTS);
    await expect(
      adapter.transition('1', 'BadState', {
        tenantId: 't1',
        userId: 'u',
        roles: [],
        resolveSecret: async () => '',
      }),
    ).rejects.toBeInstanceOf(AdoApiError);
  });

  it('throws at construction when org is missing', () => {
    expect(
      () => new AzureDevOpsTaskSystemAdapter({ org: '', project: 'p', pat: 'x' }),
    ).toThrow(/missing required settings/);
  });

  it('throws at construction when project is missing', () => {
    expect(
      () => new AzureDevOpsTaskSystemAdapter({ org: 'o', project: '', pat: 'x' }),
    ).toThrow(/missing required settings/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sdlc/server test azure-devops-task-system`
Expected: FAIL — cannot find `../src/adapters/azure-devops-task-system.js`.

- [ ] **Step 3: Write the skeleton + errors + request helper**

Create `apps/server/src/adapters/azure-devops-task-system.ts`:

```ts
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

  // Stub implementations — filled in Tasks 2–5.
  async createEpic(_input: EpicInput, _ctx: TenantCtx): Promise<ExternalRef> {
    throw new Error('Not yet implemented');
  }
  async createStory(_input: StoryInput, _ctx: TenantCtx): Promise<ExternalRef> {
    throw new Error('Not yet implemented');
  }
  async createSubtask(_input: SubtaskInput, _ctx: TenantCtx): Promise<ExternalRef> {
    throw new Error('Not yet implemented');
  }
  async linkChildToParent(_parentId: string, _childId: string, _ctx: TenantCtx): Promise<void> {
    throw new Error('Not yet implemented');
  }
  async getItem(_id: string, _ctx: TenantCtx): Promise<TaskItem> {
    throw new Error('Not yet implemented');
  }
  async transition(_id: string, _status: string, _ctx: TenantCtx): Promise<void> {
    throw new Error('Not yet implemented');
  }
  async search(_query: TaskQuery, _ctx: TenantCtx): Promise<TaskItem[]> {
    throw new Error('Not yet implemented');
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
}
```

- [ ] **Step 4: Run error tests to verify they pass**

Run: `pnpm --filter @sdlc/server test azure-devops-task-system`
Expected: the 5 error-path / constructor tests PASS; the "Not yet implemented" method stubs are not yet exercised.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/adapters/azure-devops-task-system.ts apps/server/test/azure-devops-task-system.test.ts
git commit -m "feat(ado): AzureDevOpsTaskSystemAdapter skeleton + error types + request helper"
```

---

## Task 2: createEpic, createStory, createSubtask (TDD)

**Files:**
- Modify: `apps/server/src/adapters/azure-devops-task-system.ts`
- Modify: `apps/server/test/azure-devops-task-system.test.ts`

- [ ] **Step 1: Add failing tests for the three creation methods**

Append to `apps/server/test/azure-devops-task-system.test.ts`:

```ts
// ---------------------------------------------------------------------------
// Helpers shared across creation tests
// ---------------------------------------------------------------------------

function adoWorkItemResponse(id: number, fields: Record<string, unknown> = {}): object {
  return {
    id,
    url: `https://dev.azure.com/my-org/_apis/wit/workItems/${id}`,
    fields: {
      'System.Title': fields['System.Title'] ?? 'Untitled',
      'System.State': 'New',
      'System.WorkItemType': fields['System.WorkItemType'] ?? 'User Story',
      ...fields,
    },
    relations: [],
  };
}

describe('AzureDevOpsTaskSystemAdapter — createEpic', () => {
  const ctx = { tenantId: 't1', userId: 'u', roles: [], resolveSecret: async () => '' };

  afterEach(() => vi.restoreAllMocks());

  it('returns ExternalRef with id and URL', async () => {
    vi.stubGlobal('fetch', mockFetch(200, adoWorkItemResponse(42, { 'System.WorkItemType': 'Epic' })));
    const adapter = new AzureDevOpsTaskSystemAdapter(BASE_OPTS);
    const ref = await adapter.createEpic(
      { project_key: 'my-project', title: 'My Epic', description: 'desc', labels: ['team-a'] },
      ctx,
    );
    expect(ref.external_id).toBe('42');
    expect(ref.url).toContain('_workitems/edit/42');
  });

  it('sends System.Tags for labels', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(adoWorkItemResponse(1, { 'System.WorkItemType': 'Epic' })), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new AzureDevOpsTaskSystemAdapter(BASE_OPTS);
    await adapter.createEpic(
      { project_key: 'p', title: 'T', description: 'D', labels: ['frontend', 'prio-1'] },
      ctx,
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string) as object[];
    const tagsOp = body.find((op: { path?: string }) => op.path === '/fields/System.Tags');
    expect((tagsOp as { value: string }).value).toBe('frontend; prio-1');
  });
});

describe('AzureDevOpsTaskSystemAdapter — createStory', () => {
  const ctx = { tenantId: 't1', userId: 'u', roles: [], resolveSecret: async () => '' };

  afterEach(() => vi.restoreAllMocks());

  it('returns ExternalRef', async () => {
    vi.stubGlobal('fetch', mockFetch(200, adoWorkItemResponse(7)));
    const adapter = new AzureDevOpsTaskSystemAdapter(BASE_OPTS);
    const ref = await adapter.createStory(
      {
        project_key: 'p',
        epic_id: '1',
        title: 'Story',
        description: 'desc',
        acceptance_criteria: ['AC1', 'AC2'],
      },
      ctx,
    );
    expect(ref.external_id).toBe('7');
  });

  it('maps acceptance_criteria to AcceptanceCriteria field as HTML list', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(adoWorkItemResponse(8)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new AzureDevOpsTaskSystemAdapter(BASE_OPTS);
    await adapter.createStory(
      {
        project_key: 'p',
        epic_id: '1',
        title: 'Story',
        description: 'desc',
        acceptance_criteria: ['AC1', 'AC2'],
      },
      ctx,
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string) as object[];
    const acOp = body.find(
      (op: { path?: string }) =>
        op.path === '/fields/Microsoft.VSTS.Common.AcceptanceCriteria',
    );
    expect((acOp as { value: string }).value).toContain('AC1');
    expect((acOp as { value: string }).value).toContain('AC2');
  });

  it('sends StoryPoints when estimate is provided', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(adoWorkItemResponse(9)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new AzureDevOpsTaskSystemAdapter(BASE_OPTS);
    await adapter.createStory(
      {
        project_key: 'p',
        epic_id: '1',
        title: 'S',
        description: 'd',
        acceptance_criteria: [],
        estimate: 5,
      },
      ctx,
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string) as object[];
    const spOp = body.find(
      (op: { path?: string }) =>
        op.path === '/fields/Microsoft.VSTS.Scheduling.StoryPoints',
    );
    expect((spOp as { value: number }).value).toBe(5);
  });
});

describe('AzureDevOpsTaskSystemAdapter — createSubtask', () => {
  const ctx = { tenantId: 't1', userId: 'u', roles: [], resolveSecret: async () => '' };

  afterEach(() => vi.restoreAllMocks());

  it('returns ExternalRef', async () => {
    vi.stubGlobal('fetch', mockFetch(200, adoWorkItemResponse(15, { 'System.WorkItemType': 'Task' })));
    const adapter = new AzureDevOpsTaskSystemAdapter(BASE_OPTS);
    const ref = await adapter.createSubtask(
      { project_key: 'p', parent_story_id: '7', title: 'Subtask' },
      ctx,
    );
    expect(ref.external_id).toBe('15');
  });

  it('omits description when not provided', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(adoWorkItemResponse(16, { 'System.WorkItemType': 'Task' })), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new AzureDevOpsTaskSystemAdapter(BASE_OPTS);
    await adapter.createSubtask({ project_key: 'p', parent_story_id: '7', title: 'T' }, ctx);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string) as object[];
    const descOp = body.find((op: { path?: string }) => op.path === '/fields/System.Description');
    expect(descOp).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @sdlc/server test azure-devops-task-system`
Expected: FAIL — the `createEpic`, `createStory`, `createSubtask` methods throw "Not yet implemented".

- [ ] **Step 3: Implement createEpic, createStory, createSubtask**

Replace the stub methods in `apps/server/src/adapters/azure-devops-task-system.ts`:

```ts
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
        ? `<ul>${input.acceptance_criteria.map((c) => `<li>${c}</li>`).join('')}</ul>`
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @sdlc/server test azure-devops-task-system`
Expected: all creation tests PASS (error tests remain passing).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/adapters/azure-devops-task-system.ts apps/server/test/azure-devops-task-system.test.ts
git commit -m "feat(ado): implement createEpic, createStory, createSubtask"
```

---

## Task 3: linkChildToParent, getItem, transition (TDD)

**Files:**
- Modify: `apps/server/src/adapters/azure-devops-task-system.ts`
- Modify: `apps/server/test/azure-devops-task-system.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `apps/server/test/azure-devops-task-system.test.ts`:

```ts
describe('AzureDevOpsTaskSystemAdapter — linkChildToParent', () => {
  const ctx = { tenantId: 't1', userId: 'u', roles: [], resolveSecret: async () => '' };

  afterEach(() => vi.restoreAllMocks());

  it('sends a PATCH with Hierarchy-Reverse relation on the child', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(adoWorkItemResponse(7)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new AzureDevOpsTaskSystemAdapter(BASE_OPTS);
    await adapter.linkChildToParent('1', '7', ctx);

    const [calledUrl, calledOpts] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(calledUrl).toContain('/workitems/7');
    const body = JSON.parse(calledOpts.body as string) as object[];
    const relOp = body.find((op: { path?: string }) => op.path === '/relations/-') as {
      value: { rel: string; url: string };
    };
    expect(relOp.value.rel).toBe('System.LinkTypes.Hierarchy-Reverse');
    expect(relOp.value.url).toContain('/workItems/1');
  });
});

describe('AzureDevOpsTaskSystemAdapter — getItem', () => {
  const ctx = { tenantId: 't1', userId: 'u', roles: [], resolveSecret: async () => '' };

  afterEach(() => vi.restoreAllMocks());

  it('maps ADO fields to TaskItem', async () => {
    const wi = {
      id: 42,
      url: 'https://dev.azure.com/my-org/_apis/wit/workItems/42',
      fields: {
        'System.Title': 'My Story',
        'System.Description': 'desc',
        'System.State': 'Active',
        'System.WorkItemType': 'User Story',
        'System.Tags': 'frontend; prio-1',
      },
      relations: [
        {
          rel: 'System.LinkTypes.Hierarchy-Reverse',
          url: 'https://dev.azure.com/my-org/_apis/wit/workItems/10',
        },
      ],
    };
    vi.stubGlobal('fetch', mockFetch(200, wi));
    const adapter = new AzureDevOpsTaskSystemAdapter(BASE_OPTS);
    const item = await adapter.getItem('42', ctx);

    expect(item.external_id).toBe('42');
    expect(item.title).toBe('My Story');
    expect(item.status).toBe('Active');
    expect(item.type).toBe('story');
    expect(item.labels).toEqual(['frontend', 'prio-1']);
    expect(item.parent_id).toBe('10');
  });

  it('maps Epic type correctly', async () => {
    const wi = {
      id: 5,
      url: '',
      fields: {
        'System.Title': 'E',
        'System.Description': '',
        'System.State': 'New',
        'System.WorkItemType': 'Epic',
        'System.Tags': '',
      },
      relations: [],
    };
    vi.stubGlobal('fetch', mockFetch(200, wi));
    const adapter = new AzureDevOpsTaskSystemAdapter(BASE_OPTS);
    const item = await adapter.getItem('5', ctx);
    expect(item.type).toBe('epic');
    expect(item.parent_id).toBeUndefined();
  });

  it('maps Task type to "subtask"', async () => {
    const wi = {
      id: 20,
      url: '',
      fields: {
        'System.Title': 'T',
        'System.Description': '',
        'System.State': 'New',
        'System.WorkItemType': 'Task',
        'System.Tags': '',
      },
      relations: [],
    };
    vi.stubGlobal('fetch', mockFetch(200, wi));
    const adapter = new AzureDevOpsTaskSystemAdapter(BASE_OPTS);
    const item = await adapter.getItem('20', ctx);
    expect(item.type).toBe('subtask');
  });
});

describe('AzureDevOpsTaskSystemAdapter — transition', () => {
  const ctx = { tenantId: 't1', userId: 'u', roles: [], resolveSecret: async () => '' };

  afterEach(() => vi.restoreAllMocks());

  it('PATCHes System.State with the given status', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(adoWorkItemResponse(7, { 'System.State': 'Active' })), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new AzureDevOpsTaskSystemAdapter(BASE_OPTS);
    await adapter.transition('7', 'Active', ctx);

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string) as object[];
    const stateOp = body.find((op: { path?: string }) => op.path === '/fields/System.State') as {
      value: string;
    };
    expect(stateOp.value).toBe('Active');
  });

  it('applies stateMap override', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(adoWorkItemResponse(7)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new AzureDevOpsTaskSystemAdapter({
      ...BASE_OPTS,
      stateMap: { Resolved: 'Done' },
    });
    await adapter.transition('7', 'Resolved', ctx);

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string) as object[];
    const stateOp = body.find((op: { path?: string }) => op.path === '/fields/System.State') as {
      value: string;
    };
    expect(stateOp.value).toBe('Done');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @sdlc/server test azure-devops-task-system`
Expected: FAIL — `linkChildToParent`, `getItem`, `transition` throw "Not yet implemented".

- [ ] **Step 3: Implement linkChildToParent, getItem, transition**

Replace the stub methods:

```ts
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

  async transition(id: string, status: string, _ctx: TenantCtx): Promise<void> {
    const url = `${this.baseUrl()}/workitems/${id}?api-version=7.1`;
    const mappedState = this.mapState(status);
    await this.request<unknown>(url, {
      method: 'PATCH',
      body: [{ op: 'add', path: '/fields/System.State', value: mappedState }],
    });
  }
```

Also add the ADO response type and `mapWorkItem` private method at the bottom of the class:

```ts
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
      parent_id,
      labels,
    };
  }
```

Add the private interface above the class body:

```ts
interface AdoWorkItemResponse {
  id: number;
  url: string;
  fields: Record<string, string>;
  relations?: Array<{ rel: string; url: string }>;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @sdlc/server test azure-devops-task-system`
Expected: all tests so far PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/adapters/azure-devops-task-system.ts apps/server/test/azure-devops-task-system.test.ts
git commit -m "feat(ado): implement linkChildToParent, getItem, transition"
```

---

## Task 4: search (WIQL + batch-fetch) (TDD)

**Files:**
- Modify: `apps/server/src/adapters/azure-devops-task-system.ts`
- Modify: `apps/server/test/azure-devops-task-system.test.ts`

- [ ] **Step 1: Add failing tests for search**

Append to `apps/server/test/azure-devops-task-system.test.ts`:

```ts
describe('AzureDevOpsTaskSystemAdapter — search', () => {
  const ctx = { tenantId: 't1', userId: 'u', roles: [], resolveSecret: async () => '' };

  afterEach(() => vi.restoreAllMocks());

  it('returns mapped TaskItems for a status-filtered search', async () => {
    // First fetch: WIQL response
    const wiqlResponse = { workItems: [{ id: 7, url: '' }, { id: 8, url: '' }] };
    // Second fetch: batch-fetch response
    const batchResponse = {
      value: [
        adoWorkItemResponse(7, { 'System.State': 'Active', 'System.WorkItemType': 'User Story' }),
        adoWorkItemResponse(8, { 'System.State': 'Active', 'System.WorkItemType': 'User Story' }),
      ],
    };
    let callCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        callCount++;
        const body = callCount === 1 ? wiqlResponse : batchResponse;
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }),
    );
    const adapter = new AzureDevOpsTaskSystemAdapter(BASE_OPTS);
    const items = await adapter.search({ status: 'Active' }, ctx);
    expect(items).toHaveLength(2);
    expect(items[0]!.status).toBe('Active');
  });

  it('returns empty array when WIQL returns no work items', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { workItems: [] }));
    const adapter = new AzureDevOpsTaskSystemAdapter(BASE_OPTS);
    const items = await adapter.search({ text: 'nonexistent' }, ctx);
    expect(items).toEqual([]);
  });

  it('applies limit via WIQL top clause', async () => {
    const wiqlResponse = { workItems: [] };
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(wiqlResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new AzureDevOpsTaskSystemAdapter(BASE_OPTS);
    await adapter.search({ limit: 10 }, ctx);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string) as {
      query: string;
    };
    expect(body.query).toContain('TOP 10');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @sdlc/server test azure-devops-task-system`
Expected: FAIL — `search` throws "Not yet implemented".

- [ ] **Step 3: Implement search**

Replace the `search` stub method:

```ts
  async search(query: TaskQuery, _ctx: TenantCtx): Promise<TaskItem[]> {
    const topClause = query.limit !== undefined ? `TOP ${query.limit}` : 'TOP 200';
    const conditions: string[] = [
      `[System.TeamProject] = '${this.project}'`,
    ];
    if (query.status) conditions.push(`[System.State] = '${query.status}'`);
    if (query.parent_id) {
      // Filter by parent via a sub-select is not native in WIQL; include in post-filter below.
    }
    if (query.text) conditions.push(`[System.Title] CONTAINS '${query.text.replace(/'/g, "''")}'`);

    const whereClause = conditions.join(' AND ');
    const wiqlQuery = `SELECT [System.Id] FROM workitems WHERE ${whereClause} ORDER BY [System.ChangedDate] DESC`;

    const wiqlUrl = `${this.baseUrl()}/wiql?api-version=7.1${query.limit !== undefined ? `&$top=${query.limit}` : ''}`;
    const wiqlBody = { query: `SELECT ${topClause} [System.Id] FROM workitems WHERE ${whereClause} ORDER BY [System.ChangedDate] DESC` };

    const wiqlResult = await this.request<{ workItems: Array<{ id: number; url: string }> }>(
      wiqlUrl,
      { method: 'POST', body: wiqlBody, contentType: 'application/json' },
    );

    if (!wiqlResult.workItems || wiqlResult.workItems.length === 0) return [];

    const ids = wiqlResult.workItems.map((wi) => wi.id);
    const batchUrl = `${this.baseUrl()}/workitemsbatch?api-version=7.1`;
    const batchFields = [
      'System.Id',
      'System.Title',
      'System.Description',
      'System.State',
      'System.WorkItemType',
      'System.Tags',
    ];
    const batchResult = await this.request<{ value: AdoWorkItemResponse[] }>(
      batchUrl,
      {
        method: 'POST',
        body: { ids, fields: batchFields, $expand: 'relations' },
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @sdlc/server test azure-devops-task-system`
Expected: ALL tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/adapters/azure-devops-task-system.ts apps/server/test/azure-devops-task-system.test.ts
git commit -m "feat(ado): implement search via WIQL + workitemsbatch"
```

---

## Task 5: Wire adapter into ConfigBackedTaskSystemProvider

**Files:**
- Modify: `apps/server/src/adapters/task-system-provider.ts` (**SHARED FILE** — last modified in Slice 1, merged)
- Modify: `apps/server/src/adapters/index.ts`
- Modify: `apps/server/test/task-system-provider.test.ts`

> **Merge sequencing note:** `task-system-provider.ts` was last touched in Slice 1 (merged). Slices 3 and 4 add `doc_store` and `pr_provider` handling in separate files and do NOT modify `task-system-provider.ts`. There is no anticipated conflict. If Slices 3/4 branches are open in parallel, coordinate a rebase before merging whichever branch lands last.

- [ ] **Step 1: Add a failing provider test for the real adapter**

Append to `apps/server/test/task-system-provider.test.ts`:

```ts
import { AzureDevOpsTaskSystemAdapter } from '../src/adapters/azure-devops-task-system.js';

// ... existing tests above ...

describe('ConfigBackedTaskSystemProvider — azure-devops real adapter', () => {
  it('constructs AzureDevOpsTaskSystemAdapter and returns it (no throw)', async () => {
    // Stub fetch so the adapter constructor does not attempt a network call.
    // (Constructor is synchronous — no fetch at construction time; this just ensures
    // the provider no longer throws NotImplementedError.)
    const configStore = new InMemoryIntegrationConfigStore();
    configStore.seed('t1', 'proj-a', {
      task_system: {
        kind: 'azure-devops',
        secret_ref: 'aws-sm://ado#token',
        settings: { org: 'acme', project: 'my-project' },
      },
    });
    const provider = new ConfigBackedTaskSystemProvider({
      configStore,
      inMemory: new InMemoryTaskSystemAdapter(),
    });
    const resolved = await provider.resolve(
      ctx(async () => 'my-pat'),
      FLOW,
    );
    expect(resolved).toBeInstanceOf(AzureDevOpsTaskSystemAdapter);
    expect(resolved.kind).toBe('azure-devops');
  });

  it('passes org and project from settings to the adapter', async () => {
    const configStore = new InMemoryIntegrationConfigStore();
    configStore.seed('t1', 'proj-a', {
      task_system: {
        kind: 'azure-devops',
        secret_ref: 'aws-sm://ado#token',
        settings: { org: 'contoso', project: 'platform' },
      },
    });
    const provider = new ConfigBackedTaskSystemProvider({
      configStore,
      inMemory: new InMemoryTaskSystemAdapter(),
    });
    const resolved = (await provider.resolve(
      ctx(async () => 'pat'),
      FLOW,
    )) as AzureDevOpsTaskSystemAdapter;
    // Access internal config via a public method added for testability:
    expect(resolved.orgName()).toBe('contoso');
    expect(resolved.projectName()).toBe('platform');
  });
});
```

- [ ] **Step 2: Add testability accessors to the adapter**

In `apps/server/src/adapters/azure-devops-task-system.ts`, add two public accessors (read-only):

```ts
  /** Exposed for provider tests only. */
  orgName(): string { return this.org; }
  projectName(): string { return this.project; }
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @sdlc/server test task-system-provider`
Expected: FAIL — the `azure-devops` branch still throws `NotImplementedError`.

- [ ] **Step 4: Replace NotImplementedError with real construction**

In `apps/server/src/adapters/task-system-provider.ts`:

Add the import at the top of the file:
```ts
import { AzureDevOpsTaskSystemAdapter } from './azure-devops-task-system.js';
```

Replace the `azure-devops` case body:
```ts
      case 'azure-devops': {
        if (!cfg.secret_ref) {
          throw new Error('azure-devops adapter: secret_ref is required in task_system config');
        }
        const pat = await ctx.resolveSecret(cfg.secret_ref);
        const s = cfg.settings as Record<string, unknown>;
        return new AzureDevOpsTaskSystemAdapter({
          org:           s.org as string,
          project:       s.project as string,
          pat,
          epicType:      s.epicType as string | undefined,
          storyType:     s.storyType as string | undefined,
          subtaskType:   s.subtaskType as string | undefined,
          stateMap:      s.stateMap as Record<string, string> | undefined,
          areaPath:      s.areaPath as string | undefined,
          iterationPath: s.iterationPath as string | undefined,
        });
      }
```

- [ ] **Step 5: Export from the adapters barrel**

In `apps/server/src/adapters/index.ts`, add:
```ts
export * from './azure-devops-task-system.js';
```

- [ ] **Step 6: Update the seam test (task-system-provider-tool-seam.test.ts)**

The existing seam test asserts that calling `create_epic` with an `azure-devops` config rejects with `NotImplementedError`. Now it will no longer reject — it will attempt a real `fetch` call. Update the test: stub `fetch` to return a valid creation response so the seam test verifies the adapter is wired through, not that it throws.

In `apps/server/test/task-system-provider-tool-seam.test.ts`, replace the assertion block:

```ts
// Add at top of file:
import { vi, afterEach } from 'vitest';

// Inside the describe/it block, before the `call` helper:
afterEach(() => vi.restoreAllMocks());

// Replace the "await expect(...).rejects.toBeInstanceOf(NotImplementedError)" assertion with:
vi.stubGlobal(
  'fetch',
  vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        id: 99,
        url: 'https://dev.azure.com/acme/_apis/wit/workItems/99',
        fields: { 'System.Title': 'Cuotas', 'System.WorkItemType': 'Epic', 'System.State': 'New', 'System.Tags': '' },
        relations: [],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  ),
);

const epicResult = await registry.get('create_epic')!.handler(
  { flow_id, epic: { title: 'Cuotas', description: 'desc' } },
  ctx,
);
expect((epicResult as { ok: boolean }).ok).toBe(true);
// The secret was resolved:
expect(resolvedRefs).toEqual([SECRET_REF]);
```

Also remove the `NotImplementedError` import if it is no longer referenced.

- [ ] **Step 7: Run the full test suite**

Run: `pnpm --filter @sdlc/server test`
Expected: ALL tests PASS (Postgres integration tests SKIP without `TEST_DATABASE_URL`). The seam test now validates the real adapter is returned.

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @sdlc/server typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/adapters/task-system-provider.ts apps/server/src/adapters/azure-devops-task-system.ts apps/server/src/adapters/index.ts apps/server/test/task-system-provider.test.ts apps/server/test/task-system-provider-tool-seam.test.ts
git commit -m "feat(adapters): wire AzureDevOpsTaskSystemAdapter into ConfigBackedTaskSystemProvider"
```

---

## Task 6: Optional live integration test (gated)

**Files:**
- Create: `apps/server/test/azure-devops-task-system.integration.test.ts`

- [ ] **Step 1: Write the gated integration test**

Create `apps/server/test/azure-devops-task-system.integration.test.ts`:

```ts
/**
 * Live integration test against a real Azure DevOps project.
 * Skipped unless ADO_TEST_ORG, ADO_TEST_PROJECT, and ADO_TEST_PAT are set.
 * Never run in CI without those env vars configured.
 *
 * Cleanup: items are transitioned to Closed after each test run;
 * they can be deleted manually if needed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AzureDevOpsTaskSystemAdapter } from '../src/adapters/azure-devops-task-system.js';
import type { TenantCtx } from '@sdlc/adapters-contracts';

const org = process.env.ADO_TEST_ORG;
const project = process.env.ADO_TEST_PROJECT;
const pat = process.env.ADO_TEST_PAT;

const maybe = org && project && pat ? describe : describe.skip;

maybe('AzureDevOpsTaskSystemAdapter — live integration', () => {
  const adapter = new AzureDevOpsTaskSystemAdapter({ org: org!, project: project!, pat: pat! });
  const ctx: TenantCtx = {
    tenantId: 'integration-test',
    userId: 'ci',
    roles: [],
    resolveSecret: async () => pat!,
  };

  let epicId: string;
  let storyId: string;
  let taskId: string;

  beforeAll(async () => {
    const epicRef = await adapter.createEpic(
      {
        project_key: project!,
        title: '[CI] Integration Test Epic',
        description: 'Created by automated integration test — safe to close',
        labels: ['ci-test'],
      },
      ctx,
    );
    epicId = epicRef.external_id;
  });

  afterAll(async () => {
    // Transition all created items to Closed for cleanup.
    for (const id of [taskId, storyId, epicId].filter(Boolean)) {
      try { await adapter.transition(id, 'Closed', ctx); } catch { /* ignore */ }
    }
  });

  it('creates a User Story under the Epic', async () => {
    const ref = await adapter.createStory(
      {
        project_key: project!,
        epic_id: epicId,
        title: '[CI] Integration Test Story',
        description: 'Auto-created',
        acceptance_criteria: ['AC1: system works', 'AC2: no errors'],
        labels: ['ci-test'],
        estimate: 3,
      },
      ctx,
    );
    storyId = ref.external_id;
    expect(storyId).toBeTruthy();
  });

  it('links the story as a child of the epic', async () => {
    await adapter.linkChildToParent(epicId, storyId, ctx);
    const story = await adapter.getItem(storyId, ctx);
    expect(story.parent_id).toBe(epicId);
  });

  it('creates a Task under the story', async () => {
    const ref = await adapter.createSubtask(
      { project_key: project!, parent_story_id: storyId, title: '[CI] Integration Test Task' },
      ctx,
    );
    taskId = ref.external_id;
    expect(taskId).toBeTruthy();
    await adapter.linkChildToParent(storyId, taskId, ctx);
  });

  it('transitions the story to Active', async () => {
    await adapter.transition(storyId, 'Active', ctx);
    const item = await adapter.getItem(storyId, ctx);
    expect(item.status).toBe('Active');
  });

  it('retrieves the epic and verifies fields', async () => {
    const epic = await adapter.getItem(epicId, ctx);
    expect(epic.type).toBe('epic');
    expect(epic.title).toContain('[CI] Integration Test Epic');
    expect(epic.labels).toContain('ci-test');
  });

  it('searches for Active stories containing "Integration"', async () => {
    const results = await adapter.search({ status: 'Active', text: 'Integration' }, ctx);
    const found = results.find((i) => i.external_id === storyId);
    expect(found).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to confirm it skips without env vars**

Run: `pnpm --filter @sdlc/server test azure-devops-task-system.integration`
Expected: `describe.skip` — 0 tests run, suite reported as skipped.

- [ ] **Step 3: Commit**

```bash
git add apps/server/test/azure-devops-task-system.integration.test.ts
git commit -m "test(ado): optional live integration test gated on ADO_TEST_ORG"
```

---

## Task 7: Full suite verification + typecheck

- [ ] **Step 1: Run the complete server test suite**

Run: `pnpm --filter @sdlc/server test`
Expected: ALL tests PASS. Count should include all previously passing tests. Postgres integration tests SKIP without `TEST_DATABASE_URL`. ADO integration test SKIP without `ADO_TEST_ORG`.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @sdlc/server typecheck`
Expected: no type errors.

- [ ] **Step 3: Build**

Run: `pnpm turbo run build`
Expected: build succeeds with no errors.

- [ ] **Step 4: Smoke dev server**

Run (no DATABASE_URL → in-memory flow store; no ADO config → in-memory task system):
```bash
API_KEYS="demo-tenant:dev-key-12345" pnpm --filter @sdlc/server dev &
sleep 3
curl -s localhost:3000/health
kill %1
```
Expected: `/health` returns JSON with `"store":"in-memory"`; no crash.

- [ ] **Step 5: Commit (if any fixup commits were needed)**

If any issues were fixed in this task:
```bash
git add -p
git commit -m "fix(ado): final suite fixes from full-suite run"
```

---

## Self-Review Notes

- **Spec coverage:** Error types + request helper (T1) · createEpic/createStory/createSubtask with field mapping, labels, acceptance-criteria HTML, StoryPoints (T2) · linkChildToParent with Hierarchy-Reverse, getItem with full field+relation mapping, transition with stateMap support (T3) · search via WIQL + workitemsbatch with all query filters + parent_id post-filter (T4) · provider wiring replacing NotImplementedError, barrel exports, seam test update (T5) · live integration test gated on ADO_TEST_ORG (T6) · full suite + typecheck + build smoke (T7).
- **Contract compatibility:** The adapter is drop-in with `InMemoryTaskSystemAdapter`: same `ExternalRef` shape (`external_id` as string, `url` as edit link), same `TaskItem` shape, same `kind = 'azure-devops'`, same state strings passed through from the 7 tools (`New`, `Active`, `Resolved`, `Closed`).
- **No migration:** `tenant_integrations` (migration `0003`) from Slice 1 is sufficient. Migration `0004` is not claimed.
- **Shared file:** `task-system-provider.ts` is modified in T5. Last touched in Slice 1 (merged). Slices 3/4 do not modify it — no collision anticipated. Coordinate rebase if Slices 3/4 branches are open in parallel at merge time.
- **No new runtime dependencies:** native `fetch` (Node 20+) is used; no npm packages added.
- **Open decisions deferred:** stateMap defaults (OD-1/OD-2) are configurable but not enforced; area/iteration path (OD-3) optionally set; rate limit (OD-5) surfaces as `AdoRateLimitError` without retry logic.
