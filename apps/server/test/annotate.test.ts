/**
 * Seam bajo test: `annotate` de los contratos `PullRequestAdapter` y
 * `TaskSystemAdapter`, en cada adapter. GitHub con `fetch` stubbeado: se observan
 * los requests (URL, método, body). In-memory: lo que guarda. Azure DevOps y
 * Linear con fakes mínimos de sus APIs: lo que queda anotado y que un reintento
 * no duplica.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { annotationMarker, type TenantCtx } from '@sdlc/adapters-contracts';
import { GitHubPullRequestAdapter } from '../src/adapters/github-pr-adapter.js';
import { GitHubIssuesTaskSystemAdapter } from '../src/adapters/github-issues-task-system.js';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';
import { NoOpPullRequestAdapter } from '../src/adapters/pull-request-provider.js';
import { AzureDevOpsTaskSystemAdapter } from '../src/adapters/azure-devops-task-system.js';
import { AzureDevOpsPullRequestAdapter } from '../src/adapters/azure-devops-pull-request.js';
import { LinearTaskSystemAdapter } from '../src/adapters/linear-task-system.js';

const ctx: TenantCtx = { tenantId: 't1', userId: 'u', roles: [], resolveSecret: async () => '' };

const MARKER = annotationMarker('qa:default:sdlc-mcp:flow::24');
const BODY = `${MARKER}\n### QA propio — firmado por nico@example.org\n\n| Criterio | Resultado | Evidencia |`;
const ANNOTATION = { labels: ['sdlc:qa-propio'], body: BODY };

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/**
 * Fake mínimo de la API de issues de GitHub: labels del repo, labels por issue y
 * comentarios por issue. Alcanza para observar idempotencia sin acoplarse al
 * orden exacto de los requests.
 */
function fakeGitHub(
  opts: {
    existingLabels?: string[];
    comments?: Array<{ id: number; body: string }>;
    failOn?: RegExp;
  } = {},
) {
  const repoLabels = new Set(opts.existingLabels ?? []);
  const issueLabels = new Set<string>();
  const comments = [...(opts.comments ?? [])];
  let nextId = 1000;
  const calls: Call[] = [];

  const spy = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

    if (opts.failOn && opts.failOn.test(`${method} ${url}`)) return json({ message: 'boom' }, 500);

    const path = new URL(url).pathname;
    if (method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/labels$/.test(path)) {
      const name = (body as { name: string }).name;
      if (repoLabels.has(name)) return json({ message: 'Validation Failed' }, 422);
      repoLabels.add(name);
      return json({ name }, 201);
    }
    if (method === 'POST' && /\/issues\/\d+\/labels$/.test(path)) {
      for (const l of (body as { labels: string[] }).labels) {
        if (!repoLabels.has(l)) return json({ message: `label ${l} no existe` }, 422);
        issueLabels.add(l);
      }
      return json([...issueLabels].map((name) => ({ name })));
    }
    if (method === 'GET' && /\/issues\/\d+\/comments$/.test(path)) {
      const page = Number(new URL(url).searchParams.get('page') ?? '1');
      const perPage = Number(new URL(url).searchParams.get('per_page') ?? '30');
      return json(comments.slice((page - 1) * perPage, page * perPage));
    }
    if (method === 'POST' && /\/issues\/\d+\/comments$/.test(path)) {
      const c = { id: nextId++, body: (body as { body: string }).body };
      comments.push(c);
      return json(c, 201);
    }
    const patch = /\/issues\/comments\/(\d+)$/.exec(path);
    if (method === 'PATCH' && patch) {
      const c = comments.find((x) => x.id === Number(patch[1]));
      if (!c) return json({ message: 'Not Found' }, 404);
      c.body = (body as { body: string }).body;
      return json(c);
    }
    return json({ message: `ruta no simulada: ${method} ${path}` }, 501);
  });
  vi.stubGlobal('fetch', spy);
  return { calls, repoLabels, issueLabels, comments };
}

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// GitHub: issue y PR comparten la API de issues
// ---------------------------------------------------------------------------

const github = [
  {
    name: 'GitHubIssuesTaskSystemAdapter (issue)',
    issuePath: '/repos/acme/checkout/issues/24',
    annotate: (a: typeof ANNOTATION) =>
      new GitHubIssuesTaskSystemAdapter({ token: 't', owner: 'acme', repo: 'checkout' }).annotate(
        '24',
        a,
        ctx,
      ),
  },
  {
    name: 'GitHubPullRequestAdapter (PR)',
    issuePath: '/repos/acme/checkout/issues/31',
    annotate: (a: typeof ANNOTATION) => {
      const adapter = new GitHubPullRequestAdapter({ token: 't' });
      return adapter.annotate(
        adapter.parsePrUrl('https://github.com/acme/checkout/pull/31'),
        a,
        ctx,
      );
    },
  },
];

describe.each(github)('$name — annotate', ({ issuePath, annotate }) => {
  it('crea la etiqueta si no existe, la agrega y deja el comentario', async () => {
    const gh = fakeGitHub();
    await annotate(ANNOTATION);

    expect(gh.repoLabels.has('sdlc:qa-propio')).toBe(true);
    expect(gh.issueLabels.has('sdlc:qa-propio')).toBe(true);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]!.body).toBe(BODY);

    const labelPost = gh.calls.find(
      (c) => c.method === 'POST' && c.url.endsWith(`${issuePath}/labels`),
    );
    expect(labelPost?.body).toEqual({ labels: ['sdlc:qa-propio'] });
    const commentPost = gh.calls.find(
      (c) => c.method === 'POST' && c.url.endsWith(`${issuePath}/comments`),
    );
    expect(commentPost?.body).toEqual({ body: BODY });
  });

  it('una etiqueta que ya existe (422 al crearla) no es error', async () => {
    const gh = fakeGitHub({ existingLabels: ['sdlc:qa-propio'] });
    await annotate(ANNOTATION);
    expect(gh.issueLabels.has('sdlc:qa-propio')).toBe(true);
    expect(gh.comments).toHaveLength(1);
  });

  it('reanotar con el mismo marcador actualiza el comentario en vez de duplicarlo', async () => {
    const gh = fakeGitHub();
    await annotate(ANNOTATION);
    const updated = `${BODY}\n| AC-1 | passed | [corrida](https://ci.example.org/1) |`;
    await annotate({ ...ANNOTATION, body: updated });

    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]!.body).toBe(updated);
    expect(
      gh.calls.some((c) => c.method === 'PATCH' && /\/issues\/comments\/1000$/.test(c.url)),
    ).toBe(true);
  });

  it('encuentra el comentario con el marcador aunque esté en una página posterior', async () => {
    const others = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: `comentario ${i}` }));
    const gh = fakeGitHub({ comments: [...others, { id: 555, body: `${BODY}\nviejo` }] });
    await annotate(ANNOTATION);

    expect(gh.comments).toHaveLength(101);
    expect(gh.comments.find((c) => c.id === 555)!.body).toBe(BODY);
  });

  it('un comentario sin el marcador no se pisa: se agrega uno nuevo', async () => {
    const gh = fakeGitHub({ comments: [{ id: 1, body: 'LGTM' }] });
    await annotate(ANNOTATION);
    expect(gh.comments.map((c) => c.body)).toEqual(['LGTM', BODY]);
  });

  it('un reintento después de una falla parcial completa sin duplicar', async () => {
    // Primera vez: la etiqueta queda puesta, el comentario falla.
    const gh = fakeGitHub({ failOn: /^POST .*\/issues\/\d+\/comments$/ });
    await expect(annotate(ANNOTATION)).rejects.toThrow(/500/);
    expect(gh.comments).toHaveLength(0);

    // Reintento contra el mismo estado: ahora el comentario entra una sola vez.
    vi.unstubAllGlobals();
    const retry = fakeGitHub({ existingLabels: [...gh.repoLabels], comments: gh.comments });
    await annotate(ANNOTATION);
    await annotate(ANNOTATION);
    expect(retry.comments).toHaveLength(1);
  });

  it('propaga un error de la API al etiquetar (nunca silencioso)', async () => {
    fakeGitHub({ failOn: /^POST .*\/issues\/\d+\/labels$/ });
    await expect(annotate(ANNOTATION)).rejects.toThrow(/500/);
  });
});

// ---------------------------------------------------------------------------
// In-memory: guarda lo anotado para que los tests de las tools lo lean
// ---------------------------------------------------------------------------

describe('InMemoryTaskSystemAdapter — annotate', () => {
  it('guarda etiquetas y comentario, y los suma a las labels del item', async () => {
    const a = new InMemoryTaskSystemAdapter();
    const epic = await a.createEpic({ project_key: 'p', title: 'E', description: '' }, ctx);
    await a.annotate(epic.external_id, ANNOTATION, ctx);

    expect(a.annotationsOf(epic.external_id)).toEqual({
      labels: ['sdlc:qa-propio'],
      comments: [BODY],
    });
    expect((await a.getItem(epic.external_id, ctx)).labels).toContain('sdlc:qa-propio');
  });

  it('es idempotente por marcador', async () => {
    const a = new InMemoryTaskSystemAdapter();
    const epic = await a.createEpic({ project_key: 'p', title: 'E', description: '' }, ctx);
    await a.annotate(epic.external_id, ANNOTATION, ctx);
    await a.annotate(epic.external_id, { ...ANNOTATION, body: `${BODY}\nv2` }, ctx);

    const got = a.annotationsOf(epic.external_id);
    expect(got.labels).toEqual(['sdlc:qa-propio']);
    expect(got.comments).toEqual([`${BODY}\nv2`]);
  });

  it('falla con un work item desconocido', async () => {
    const a = new InMemoryTaskSystemAdapter();
    await expect(a.annotate('ADO-99', ANNOTATION, ctx)).rejects.toThrow(/Unknown work item/);
  });
});

describe('NoOpPullRequestAdapter — annotate', () => {
  it('guarda la anotación por URL del PR, idempotente por marcador', async () => {
    const a = new NoOpPullRequestAdapter();
    const ref = a.parsePrUrl('https://github.com/acme/checkout/pull/31');
    await a.annotate(ref, ANNOTATION, ctx);
    await a.annotate(ref, { ...ANNOTATION, body: `${BODY}\nv2` }, ctx);

    expect(a.annotationsOf(ref.url)).toEqual({
      labels: ['sdlc:qa-propio'],
      comments: [`${BODY}\nv2`],
    });
  });
});

// ---------------------------------------------------------------------------
// Azure DevOps: tag + comentario en el work item, label + thread en el PR
// ---------------------------------------------------------------------------

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

/** Fake de la API de work items: tags con rev y comentarios con continuation token. */
function fakeAdoWorkItems(
  opts: { tags?: string; comments?: Array<{ id: number; text: string }>; pageSize?: number } = {},
) {
  let tags = opts.tags ?? '';
  let rev = 7;
  const comments = [...(opts.comments ?? [])];
  let nextId = 500;
  const calls: Call[] = [];
  const spy = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });
    const u = new URL(url);
    if (/\/workitems\/\d+$/.test(u.pathname) && method === 'GET') {
      return json({ id: 1, rev, fields: { 'System.Tags': tags } });
    }
    if (/\/workitems\/\d+$/.test(u.pathname) && method === 'PATCH') {
      const ops = body as Array<{ op: string; path: string; value: unknown }>;
      const test = ops.find((o) => o.op === 'test');
      if (test && test.value !== rev) return json({ message: 'rev mismatch' }, 412);
      tags = String(ops.find((o) => o.path === '/fields/System.Tags')!.value);
      rev++;
      return json({ id: 1, rev });
    }
    if (/\/comments$/.test(u.pathname) && method === 'GET') {
      const size = opts.pageSize ?? 200;
      const from = Number(u.searchParams.get('continuationToken') ?? 0);
      const page = comments.slice(from, from + size);
      const next = from + size < comments.length ? String(from + size) : null;
      return json({ comments: page, continuationToken: next });
    }
    if (/\/comments$/.test(u.pathname) && method === 'POST') {
      const c = { id: nextId++, text: (body as { text: string }).text };
      comments.push(c);
      return json(c);
    }
    const m = /\/comments\/(\d+)$/.exec(u.pathname);
    if (m && method === 'PATCH') {
      const c = comments.find((x) => x.id === Number(m[1]))!;
      c.text = (body as { text: string }).text;
      return json(c);
    }
    return json({ message: `no fake for ${method} ${url}` }, 500);
  });
  return { spy, calls, state: () => ({ tags, comments }) };
}

describe('AzureDevOpsTaskSystemAdapter.annotate', () => {
  const adapter = () =>
    new AzureDevOpsTaskSystemAdapter({ org: 'acme', project: 'Demo', pat: 'x' });

  it('agrega el tag a los que ya tenía y deja un comentario en markdown', async () => {
    const fake = fakeAdoWorkItems({ tags: 'backend; sdlc:story' });
    vi.stubGlobal('fetch', fake.spy);
    await adapter().annotate('42', ANNOTATION, ctx);

    expect(fake.state().tags).toBe('backend; sdlc:story; sdlc:qa-propio');
    expect(fake.state().comments).toEqual([{ id: 500, text: BODY }]);
    const patch = fake.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toContainEqual({ op: 'test', path: '/rev', value: 7 });
    const post = fake.calls.find((c) => c.method === 'POST')!;
    expect(post.url).toMatch(
      /\/workItems\/42\/comments\?format=markdown&api-version=7\.1-preview\.4$/,
    );
  });

  it('reanotar no repite el tag ni el comentario: actualiza el que tiene el marcador', async () => {
    const fake = fakeAdoWorkItems({
      tags: 'sdlc:qa-propio',
      comments: [
        { id: 1, text: 'otro comentario' },
        { id: 2, text: `${BODY}\nviejo` },
      ],
      pageSize: 1,
    });
    vi.stubGlobal('fetch', fake.spy);
    await adapter().annotate('42', ANNOTATION, ctx);

    expect(fake.state().tags).toBe('sdlc:qa-propio');
    expect(fake.calls.some((c) => c.method === 'PATCH' && /\/workitems\/42\?/.test(c.url))).toBe(
      false,
    );
    expect(fake.state().comments).toEqual([
      { id: 1, text: 'otro comentario' },
      { id: 2, text: BODY },
    ]);
  });

  it('si el work item cambió entre la lectura y la escritura, falla en vez de pisarlo', async () => {
    const fake = fakeAdoWorkItems();
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const res = await fake.spy(url, init);
      if ((init?.method ?? 'GET') === 'GET' && /\/workitems\/\d+\?/.test(url)) {
        const b = (await res.json()) as { rev: number };
        return json({ ...b, rev: b.rev - 1 });
      }
      return res;
    });
    await expect(adapter().annotate('42', ANNOTATION, ctx)).rejects.toThrow(/412/);
    expect(fake.state().comments).toHaveLength(0);
  });

  it('rechaza un id que no es numérico sin tocar la red', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(adapter().annotate('1/../2', ANNOTATION, ctx)).rejects.toThrow(/inválido/);
    expect(spy).not.toHaveBeenCalled();
  });
});

/** Fake de la API de PRs: labels y threads. */
function fakeAdoPr(
  threads: Array<{ id: number; comments: Array<{ id: number; content: string }> }> = [],
) {
  const labels = new Set<string>();
  const state = { threads: [...threads] };
  let nextId = 900;
  const calls: Call[] = [];
  const spy = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });
    const path = new URL(url).pathname;
    if (path.endsWith('/labels') && method === 'POST') {
      labels.add((body as { name: string }).name);
      return json({ name: (body as { name: string }).name });
    }
    if (path.endsWith('/threads') && method === 'GET') return json({ value: state.threads });
    if (path.endsWith('/threads') && method === 'POST') {
      const b = body as { comments: Array<{ content: string }>; status: string };
      const t = {
        id: nextId++,
        status: b.status,
        comments: [{ id: 1, content: b.comments[0]!.content }],
      };
      state.threads.push(t);
      return json(t);
    }
    const m = /\/threads\/(\d+)\/comments\/(\d+)$/.exec(path);
    if (m && method === 'PATCH') {
      const c = state.threads
        .find((t) => t.id === Number(m[1]))!
        .comments.find((x) => x.id === Number(m[2]))!;
      c.content = (body as { content: string }).content;
      return json(c);
    }
    return json({ message: `no fake for ${method} ${url}` }, 500);
  });
  return { spy, calls, labels, state };
}

describe('AzureDevOpsPullRequestAdapter.annotate', () => {
  const PR = 'https://dev.azure.com/acme/Demo/_git/app/pullrequest/7';

  it('agrega el label y abre un thread cerrado con el detalle', async () => {
    const fake = fakeAdoPr();
    vi.stubGlobal('fetch', fake.spy);
    const a = new AzureDevOpsPullRequestAdapter({ pat: 'x' });
    await a.annotate(a.parsePrUrl(PR), ANNOTATION, ctx);

    expect([...fake.labels]).toEqual(['sdlc:qa-propio']);
    expect(fake.state.threads).toHaveLength(1);
    expect(fake.state.threads[0]).toMatchObject({
      status: 'closed',
      comments: [{ content: BODY }],
    });
  });

  it('reanotar edita el thread que tiene el marcador en vez de abrir otro', async () => {
    const fake = fakeAdoPr([
      { id: 3, comments: [{ id: 1, content: 'review de otra persona' }] },
      { id: 4, comments: [{ id: 1, content: `${BODY}\nviejo` }] },
    ]);
    vi.stubGlobal('fetch', fake.spy);
    const a = new AzureDevOpsPullRequestAdapter({ pat: 'x' });
    await a.annotate(a.parsePrUrl(PR), ANNOTATION, ctx);

    expect(fake.state.threads).toHaveLength(2);
    expect(fake.state.threads[1]!.comments[0]!.content).toBe(BODY);
    expect(fake.state.threads[0]!.comments[0]!.content).toBe('review de otra persona');
  });

  it('un 403 se propaga como error de auth', async () => {
    vi.stubGlobal('fetch', async () => json({}, 403));
    const a = new AzureDevOpsPullRequestAdapter({ pat: 'x' });
    await expect(a.annotate(a.parsePrUrl(PR), ANNOTATION, ctx)).rejects.toThrow(
      /auth failed \(403\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// Linear: label + comentario en el issue
// ---------------------------------------------------------------------------

/** Fake de la API GraphQL de Linear, por nombre de operación. */
function fakeLinear(
  opts: {
    teamLabels?: Array<{ id: string; name: string }>;
    comments?: Array<{ id: string; body: string }>;
  } = {},
) {
  const teamLabels = [...(opts.teamLabels ?? [])];
  const issueLabels = new Set<string>();
  const comments = [...(opts.comments ?? [])];
  const ops: string[] = [];
  let next = 1;
  const spy = vi.fn(async (_url: string, init: RequestInit = {}) => {
    const { query, variables } = JSON.parse(init.body as string) as {
      query: string;
      variables: Record<string, any>;
    };
    const op = /(?:query|mutation) (\w+)/.exec(query)![1]!;
    ops.push(op);
    const data = (d: unknown) => json({ data: d });
    switch (op) {
      case 'SdlcTeamLabels':
        return data({ team: { labels: { nodes: teamLabels } } });
      case 'SdlcCreateLabel': {
        const l = { id: `lbl-${next++}`, name: variables.input.name };
        teamLabels.push(l);
        return data({ issueLabelCreate: { success: true, issueLabel: l } });
      }
      case 'SdlcAddLabel':
        issueLabels.add(variables.labelId);
        return data({ issueAddLabel: { success: true } });
      case 'SdlcIssueComments': {
        const from = Number(variables.after ?? 0);
        const page = comments.slice(from, from + 100);
        return data({
          issue: {
            comments: {
              nodes: page,
              pageInfo: {
                hasNextPage: from + 100 < comments.length,
                endCursor: String(from + 100),
              },
            },
          },
        });
      }
      case 'SdlcCreateComment':
        comments.push({ id: `c-${next++}`, body: variables.input.body });
        return data({ commentCreate: { success: true } });
      case 'SdlcUpdateComment':
        comments.find((c) => c.id === variables.id)!.body = variables.input.body;
        return data({ commentUpdate: { success: true } });
    }
    return json({ errors: [{ message: `no fake for ${op}` }] });
  });
  return { spy, ops, teamLabels, issueLabels, comments };
}

describe('LinearTaskSystemAdapter.annotate', () => {
  const adapter = () => new LinearTaskSystemAdapter({ apiKey: 'lin_api_x', teamId: 'team' });

  it('crea la label si el team no la tiene, la agrega al issue y comenta', async () => {
    const fake = fakeLinear();
    vi.stubGlobal('fetch', fake.spy);
    await adapter().annotate('issue-1', ANNOTATION, ctx);

    expect(fake.teamLabels.map((l) => l.name)).toEqual(['sdlc:qa-propio']);
    expect([...fake.issueLabels]).toEqual([fake.teamLabels[0]!.id]);
    expect(fake.comments).toEqual([{ id: expect.any(String), body: BODY }]);
  });

  it('reanotar reusa la label y actualiza el comentario con el marcador', async () => {
    const fake = fakeLinear({
      teamLabels: [{ id: 'lbl-qa', name: 'SDLC:QA-PROPIO' }],
      comments: [
        { id: 'c-a', body: 'otro' },
        { id: 'c-b', body: `${BODY}\nviejo` },
      ],
    });
    vi.stubGlobal('fetch', fake.spy);
    await adapter().annotate('issue-1', ANNOTATION, ctx);

    expect(fake.ops).not.toContain('SdlcCreateLabel');
    expect(fake.ops).not.toContain('SdlcCreateComment');
    expect([...fake.issueLabels]).toEqual(['lbl-qa']);
    expect(fake.comments).toEqual([
      { id: 'c-a', body: 'otro' },
      { id: 'c-b', body: BODY },
    ]);
  });

  it('un error de GraphQL se propaga (no se toma como éxito)', async () => {
    vi.stubGlobal('fetch', async () => json({ errors: [{ message: 'Entity not found' }] }));
    await expect(adapter().annotate('nope', ANNOTATION, ctx)).rejects.toThrow(/Entity not found/);
  });
});
