/**
 * Seam bajo test: el contrato `TaskSystemAdapter` implementado por
 * GitHubIssuesTaskSystemAdapter, con `fetch` stubbeado. Se observa el request
 * HTTP (URL, método, body) y el TaskItem que sale; ningún test toca un helper
 * privado.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import {
  GitHubIssuesApiError,
  GitHubIssuesRateLimitError,
  GitHubIssuesTaskSystemAdapter,
  GitHubIssuesUnsupportedError,
} from '../src/adapters/github-issues-task-system.js';

const BASE_OPTS = { token: 'gh-token', owner: 'acme', repo: 'checkout' };

const ctx: TenantCtx = {
  tenantId: 't1',
  userId: 'u',
  roles: [],
  resolveSecret: async () => '',
};

interface Stubbed {
  status?: number;
  body?: unknown;
}

function ghMock(respond: (url: string, init: RequestInit) => Stubbed): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (url: string, init: RequestInit = {}) => {
    const r = respond(url, init);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', spy);
  return spy as unknown as ReturnType<typeof vi.fn>;
}

function bodyOf(spy: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  const init = spy.mock.calls[callIndex]![1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

function issueResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 987654,
    number: 7,
    html_url: 'https://github.com/acme/checkout/issues/7',
    title: 'Título',
    body: 'cuerpo',
    state: 'open',
    labels: [{ name: 'sdlc:story' }, { name: 'frontend' }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('GitHubIssuesTaskSystemAdapter — construcción', () => {
  afterEach(() => vi.restoreAllMocks());

  it('falla si falta owner', () => {
    expect(() => new GitHubIssuesTaskSystemAdapter({ token: 't', owner: '', repo: 'r' })).toThrow(
      /missing required settings/,
    );
  });

  it('falla si falta repo', () => {
    expect(() => new GitHubIssuesTaskSystemAdapter({ token: 't', owner: 'o', repo: '' })).toThrow(
      /missing required settings/,
    );
  });

  it('expone kind = github', () => {
    expect(new GitHubIssuesTaskSystemAdapter(BASE_OPTS).kind).toBe('github');
  });
});

describe('GitHubIssuesTaskSystemAdapter — errores', () => {
  afterEach(() => vi.restoreAllMocks());

  it('tira GitHubIssuesRateLimitError en HTTP 429', async () => {
    ghMock(() => ({ status: 429, body: { message: 'rate limited' } }));
    const adapter = new GitHubIssuesTaskSystemAdapter(BASE_OPTS);
    await expect(adapter.getItem('7', ctx)).rejects.toBeInstanceOf(GitHubIssuesRateLimitError);
  });

  it('trata el 403 con rate limit agotado como rate limit, no como auth', async () => {
    const spy = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0' },
        }),
    );
    vi.stubGlobal('fetch', spy);
    const adapter = new GitHubIssuesTaskSystemAdapter(BASE_OPTS);
    await expect(adapter.getItem('7', ctx)).rejects.toBeInstanceOf(GitHubIssuesRateLimitError);
  });

  it('tira GitHubIssuesApiError en 401 sin filtrar el token', async () => {
    ghMock(() => ({ status: 401, body: { message: 'Bad credentials' } }));
    const adapter = new GitHubIssuesTaskSystemAdapter(BASE_OPTS);
    await expect(adapter.getItem('7', ctx)).rejects.toBeInstanceOf(GitHubIssuesApiError);
    await expect(adapter.getItem('7', ctx)).rejects.not.toThrow(/gh-token/);
  });
});

describe('GitHubIssuesTaskSystemAdapter — creación', () => {
  afterEach(() => vi.restoreAllMocks());

  it('crea el epic en el repo de settings y devuelve number + html_url', async () => {
    const spy = ghMock(() => ({ status: 201, body: issueResponse({ labels: [{ name: 'sdlc:epic' }] }) }));
    const adapter = new GitHubIssuesTaskSystemAdapter(BASE_OPTS);
    const ref = await adapter.createEpic(
      { project_key: 'ignorado', title: 'Mi epic', description: 'desc', labels: ['prio-1'] },
      ctx,
    );
    expect(spy.mock.calls[0]![0]).toBe('https://api.github.com/repos/acme/checkout/issues');
    expect(ref.external_id).toBe('7');
    expect(ref.url).toBe('https://github.com/acme/checkout/issues/7');
    const body = bodyOf(spy);
    expect(body.title).toBe('Mi epic');
    expect(body.labels).toEqual(['prio-1', 'sdlc:epic']);
  });

  it('manda el token como Bearer y la versión de la API', async () => {
    const spy = ghMock(() => ({ status: 201, body: issueResponse() }));
    const adapter = new GitHubIssuesTaskSystemAdapter(BASE_OPTS);
    await adapter.createEpic({ project_key: 'p', title: 'T', description: 'D' }, ctx);
    const headers = (spy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer gh-token');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
  });

  it('serializa los criterios de aceptación como task list en el body', async () => {
    const spy = ghMock(() => ({ status: 201, body: issueResponse() }));
    const adapter = new GitHubIssuesTaskSystemAdapter(BASE_OPTS);
    await adapter.createStory(
      {
        project_key: 'p',
        epic_id: '1',
        title: 'S',
        description: 'cuerpo',
        acceptance_criteria: ['AC1', 'AC2'],
      },
      ctx,
    );
    const body = bodyOf(spy);
    expect(body.body).toContain('cuerpo');
    expect(body.body).toContain('- [ ] AC1');
    expect(body.labels).toEqual(['sdlc:story']);
  });

  it('falla explícito con un estimate: GitHub Issues no tiene dónde guardarlo', async () => {
    ghMock(() => ({ status: 201, body: issueResponse() }));
    const adapter = new GitHubIssuesTaskSystemAdapter(BASE_OPTS);
    await expect(
      adapter.createStory(
        {
          project_key: 'p',
          epic_id: '1',
          title: 'S',
          description: 'd',
          acceptance_criteria: [],
          estimate: 3,
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(GitHubIssuesUnsupportedError);
  });

  it('guarda el estimate como label cuando el operador configura estimateLabelPrefix', async () => {
    const spy = ghMock(() => ({ status: 201, body: issueResponse() }));
    const adapter = new GitHubIssuesTaskSystemAdapter({ ...BASE_OPTS, estimateLabelPrefix: 'points:' });
    await adapter.createStory(
      {
        project_key: 'p',
        epic_id: '1',
        title: 'S',
        description: 'd',
        acceptance_criteria: [],
        estimate: 3,
      },
      ctx,
    );
    expect(bodyOf(spy).labels).toEqual(['sdlc:story', 'points:3']);
  });

  it('etiqueta la subtask con sdlc:subtask', async () => {
    const spy = ghMock(() => ({ status: 201, body: issueResponse() }));
    const adapter = new GitHubIssuesTaskSystemAdapter(BASE_OPTS);
    await adapter.createSubtask({ project_key: 'p', parent_story_id: '1', title: 'T' }, ctx);
    expect(bodyOf(spy).labels).toEqual(['sdlc:subtask']);
  });
});

describe('GitHubIssuesTaskSystemAdapter — linkChildToParent', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resuelve el id de base de datos del hijo y lo cuelga como sub-issue', async () => {
    const spy = ghMock((url) =>
      url.endsWith('/issues/9')
        ? { body: issueResponse({ id: 555000, number: 9 }) }
        : { status: 201, body: {} },
    );
    const adapter = new GitHubIssuesTaskSystemAdapter(BASE_OPTS);
    await adapter.linkChildToParent('4', '9', ctx);

    expect(spy.mock.calls[0]![0]).toBe('https://api.github.com/repos/acme/checkout/issues/9');
    expect(spy.mock.calls[1]![0]).toBe(
      'https://api.github.com/repos/acme/checkout/issues/4/sub_issues',
    );
    // La API de sub-issues toma el id de base de datos, no el número visible.
    expect(bodyOf(spy, 1)).toEqual({ sub_issue_id: 555000 });
  });
});

describe('GitHubIssuesTaskSystemAdapter — getItem', () => {
  afterEach(() => vi.restoreAllMocks());

  it('deriva el tipo de la label marcadora y la saca de labels', async () => {
    ghMock(() => ({ body: issueResponse() }));
    const adapter = new GitHubIssuesTaskSystemAdapter(BASE_OPTS);
    const item = await adapter.getItem('7', ctx);
    expect(item.type).toBe('story');
    expect(item.labels).toEqual(['frontend']);
    expect(item.status).toBe('open');
    expect(item.external_id).toBe('7');
  });

  it('un issue sin label marcadora es un task, no se adivina', async () => {
    ghMock(() => ({ body: issueResponse({ labels: [{ name: 'bug' }] }) }));
    const adapter = new GitHubIssuesTaskSystemAdapter(BASE_OPTS);
    expect((await adapter.getItem('7', ctx)).type).toBe('task');
  });

  it('toma el parent_id de la relación de sub-issue cuando la API la devuelve', async () => {
    ghMock(() => ({ body: issueResponse({ parent: { number: 4 } }) }));
    const adapter = new GitHubIssuesTaskSystemAdapter(BASE_OPTS);
    expect((await adapter.getItem('7', ctx)).parent_id).toBe('4');
  });

  it('sin relación de sub-issue, parent_id queda ausente', async () => {
    ghMock(() => ({ body: issueResponse() }));
    const adapter = new GitHubIssuesTaskSystemAdapter(BASE_OPTS);
    expect((await adapter.getItem('7', ctx)).parent_id).toBeUndefined();
  });

  it('con statusLabelPrefix el status fino vuelve de la label', async () => {
    ghMock(() => ({
      body: issueResponse({ labels: [{ name: 'sdlc:story' }, { name: 'status:Resolved' }] }),
    }));
    const adapter = new GitHubIssuesTaskSystemAdapter({ ...BASE_OPTS, statusLabelPrefix: 'status:' });
    const item = await adapter.getItem('7', ctx);
    expect(item.status).toBe('Resolved');
    expect(item.labels).toEqual([]);
  });
});

describe('GitHubIssuesTaskSystemAdapter — transition', () => {
  afterEach(() => vi.restoreAllMocks());

  it('Closed cierra el issue como completado', async () => {
    const spy = ghMock(() => ({ body: issueResponse() }));
    const adapter = new GitHubIssuesTaskSystemAdapter(BASE_OPTS);
    await adapter.transition('7', 'Closed', ctx);
    expect((spy.mock.calls[0]![1] as RequestInit).method).toBe('PATCH');
    expect(bodyOf(spy)).toEqual({ state: 'closed', state_reason: 'completed' });
  });

  it('Removed cierra el issue como not_planned', async () => {
    const spy = ghMock(() => ({ body: issueResponse() }));
    const adapter = new GitHubIssuesTaskSystemAdapter(BASE_OPTS);
    await adapter.transition('7', 'Removed', ctx);
    expect(bodyOf(spy)).toEqual({ state: 'closed', state_reason: 'not_planned' });
  });

  it('Active reabre el issue', async () => {
    const spy = ghMock(() => ({ body: issueResponse() }));
    const adapter = new GitHubIssuesTaskSystemAdapter(BASE_OPTS);
    await adapter.transition('7', 'Active', ctx);
    expect(bodyOf(spy)).toEqual({ state: 'open' });
  });

  it('un status desconocido falla explícito y nombra stateMap', async () => {
    ghMock(() => ({ body: issueResponse() }));
    const adapter = new GitHubIssuesTaskSystemAdapter(BASE_OPTS);
    await expect(adapter.transition('7', 'In Review', ctx)).rejects.toThrow(/stateMap/);
  });

  it('el operador extiende el vocabulario con stateMap', async () => {
    const spy = ghMock(() => ({ body: issueResponse() }));
    const adapter = new GitHubIssuesTaskSystemAdapter({
      ...BASE_OPTS,
      stateMap: { 'In Review': 'open' },
    });
    await adapter.transition('7', 'In Review', ctx);
    expect(bodyOf(spy)).toEqual({ state: 'open' });
  });

  it('con statusLabelPrefix reemplaza la label de status anterior', async () => {
    const spy = ghMock((url, init) =>
      init.method === 'GET' || init.method === undefined
        ? { body: issueResponse({ labels: [{ name: 'sdlc:story' }, { name: 'status:Active' }] }) }
        : { body: issueResponse() },
    );
    const adapter = new GitHubIssuesTaskSystemAdapter({ ...BASE_OPTS, statusLabelPrefix: 'status:' });
    await adapter.transition('7', 'Resolved', ctx);
    const patch = bodyOf(spy, 1);
    expect(patch.labels).toEqual(['sdlc:story', 'status:Resolved']);
    expect(patch.state).toBe('open');
  });
});

describe('GitHubIssuesTaskSystemAdapter — search', () => {
  afterEach(() => vi.restoreAllMocks());

  it('busca por la search API acotada al repo', async () => {
    const spy = ghMock(() => ({ body: { total_count: 1, items: [issueResponse()] } }));
    const adapter = new GitHubIssuesTaskSystemAdapter(BASE_OPTS);
    const items = await adapter.search({ status: 'Closed', text: 'pago', limit: 10 }, ctx);

    const url = new URL(spy.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/search/issues');
    expect(url.searchParams.get('q')).toBe('repo:acme/checkout is:issue state:closed in:title pago');
    expect(url.searchParams.get('per_page')).toBe('10');
    expect(items).toHaveLength(1);
    expect(items[0]!.external_id).toBe('7');
  });

  it('con parent_id lista los sub-issues del padre en vez de buscar', async () => {
    const spy = ghMock(() => ({ body: [issueResponse(), issueResponse({ number: 8, state: 'closed' })] }));
    const adapter = new GitHubIssuesTaskSystemAdapter(BASE_OPTS);
    const items = await adapter.search({ parent_id: '4', status: 'Closed' }, ctx);

    expect(spy.mock.calls[0]![0]).toContain('/repos/acme/checkout/issues/4/sub_issues');
    // El filtro de estado se aplica del lado del cliente sobre los hijos.
    expect(items).toHaveLength(1);
    expect(items[0]!.external_id).toBe('8');
    expect(items[0]!.parent_id).toBe('4');
  });
});
