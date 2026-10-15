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

  it('WIQL URL does NOT append $top query param (TOP is in body only)', async () => {
    const wiqlResponse = { workItems: [] };
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(wiqlResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new AzureDevOpsTaskSystemAdapter(BASE_OPTS);
    await adapter.search({ limit: 5 }, ctx);
    const calledUrl = fetchSpy.mock.calls[0]![0] as string;
    expect(calledUrl).not.toContain('$top');
  });

  it('workitemsbatch request body has $expand=relations and NO fields key', async () => {
    const wiqlResponse = { workItems: [{ id: 7, url: '' }, { id: 8, url: '' }] };
    const batchResponse = {
      value: [
        adoWorkItemResponse(7, { 'System.State': 'Active', 'System.WorkItemType': 'User Story' }),
        adoWorkItemResponse(8, { 'System.State': 'Active', 'System.WorkItemType': 'User Story' }),
      ],
    };
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(wiqlResponse), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(batchResponse), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new AzureDevOpsTaskSystemAdapter(BASE_OPTS);
    await adapter.search({ status: 'Active' }, ctx);

    // Second call is the workitemsbatch call
    const batchCallBody = JSON.parse(
      (fetchSpy.mock.calls[1]![1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(batchCallBody).toHaveProperty('ids');
    expect(batchCallBody).toHaveProperty('$expand', 'relations');
    expect(batchCallBody).not.toHaveProperty('fields');
  });

  it('post-filter by parent_id returns only items with matching parent', async () => {
    const wiqlResponse = { workItems: [{ id: 10, url: '' }, { id: 11, url: '' }] };
    const batchResponse = {
      value: [
        {
          id: 10,
          url: '',
          fields: {
            'System.Title': 'Child of 42',
            'System.State': 'New',
            'System.WorkItemType': 'User Story',
            'System.Tags': '',
          },
          relations: [
            {
              rel: 'System.LinkTypes.Hierarchy-Reverse',
              url: 'https://dev.azure.com/my-org/_apis/wit/workItems/42',
            },
          ],
        },
        {
          id: 11,
          url: '',
          fields: {
            'System.Title': 'Child of 99',
            'System.State': 'New',
            'System.WorkItemType': 'User Story',
            'System.Tags': '',
          },
          relations: [
            {
              rel: 'System.LinkTypes.Hierarchy-Reverse',
              url: 'https://dev.azure.com/my-org/_apis/wit/workItems/99',
            },
          ],
        },
      ],
    };
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(wiqlResponse), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(batchResponse), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new AzureDevOpsTaskSystemAdapter(BASE_OPTS);
    const items = await adapter.search({ parent_id: '42' }, ctx);
    expect(items).toHaveLength(1);
    expect(items[0]!.external_id).toBe('10');
    expect(items[0]!.parent_id).toBe('42');
  });
});

// ---------------------------------------------------------------------------
// Security: WIQL injection guard (Fix 1)
// ---------------------------------------------------------------------------

describe('AzureDevOpsTaskSystemAdapter — security: WIQL injection', () => {
  const ctx = { tenantId: 't1', userId: 'u', roles: [], resolveSecret: async () => '' };

  afterEach(() => vi.restoreAllMocks());

  it('throws AdoApiError when status contains a single quote (allowlist guard)', async () => {
    const adapter = new AzureDevOpsTaskSystemAdapter(BASE_OPTS);
    await expect(
      adapter.search({ status: "Active' OR 1=1 --" }, ctx),
    ).rejects.toBeInstanceOf(AdoApiError);
  });

  it('throws AdoApiError when status contains other non-allowlisted characters', async () => {
    const adapter = new AzureDevOpsTaskSystemAdapter(BASE_OPTS);
    await expect(
      adapter.search({ status: 'Active; DROP TABLE workitems--' }, ctx),
    ).rejects.toBeInstanceOf(AdoApiError);
  });

  it('benign status "Active" is accepted and produces correct WIQL', async () => {
    const wiqlResponse = { workItems: [] };
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(wiqlResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const adapter = new AzureDevOpsTaskSystemAdapter(BASE_OPTS);
    await adapter.search({ status: 'Active' }, ctx);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string) as {
      query: string;
    };
    expect(body.query).toContain("[System.State] = 'Active'");
  });
});

// ---------------------------------------------------------------------------
// Security: HTML escaping in AcceptanceCriteria (Fix 2)
// ---------------------------------------------------------------------------

describe('AzureDevOpsTaskSystemAdapter — security: HTML escaping in createStory', () => {
  const ctx = { tenantId: 't1', userId: 'u', roles: [], resolveSecret: async () => '' };

  afterEach(() => vi.restoreAllMocks());

  it('HTML-escapes acceptance criteria containing a <script> tag', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(adoWorkItemResponse(99)), {
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
        acceptance_criteria: ['<script>alert(1)</script>', 'Normal criterion'],
      },
      ctx,
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string) as object[];
    const acOp = body.find(
      (op: { path?: string }) =>
        op.path === '/fields/Microsoft.VSTS.Common.AcceptanceCriteria',
    ) as { value: string };
    // Must NOT contain raw <script>
    expect(acOp.value).not.toContain('<script>');
    // Must contain escaped form
    expect(acOp.value).toContain('&lt;script&gt;');
    // Safe criterion should still appear
    expect(acOp.value).toContain('Normal criterion');
  });

  it('HTML-escapes ampersands and quotes in acceptance criteria', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(adoWorkItemResponse(100)), {
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
        acceptance_criteria: ['A & B should work', 'Say "hello"'],
      },
      ctx,
    );
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string) as object[];
    const acOp = body.find(
      (op: { path?: string }) =>
        op.path === '/fields/Microsoft.VSTS.Common.AcceptanceCriteria',
    ) as { value: string };
    expect(acOp.value).toContain('A &amp; B');
    expect(acOp.value).toContain('&quot;hello&quot;');
  });
});
