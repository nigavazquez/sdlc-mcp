/**
 * Seam bajo test: `annotate` de los contratos `PullRequestAdapter` y
 * `TaskSystemAdapter`, en cada adapter. GitHub con `fetch` stubbeado: se observan
 * los requests (URL, método, body). In-memory: lo que guarda. Azure DevOps y
 * Linear: que fallen explícito.
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
import { AnnotationNotSupportedError } from '../src/adapters/annotation-errors.js';

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
// Providers que todavía no anotan: error explícito, sin tocar la red
// ---------------------------------------------------------------------------

describe('providers sin soporte de anotación', () => {
  const unsupported = [
    {
      name: 'azure-devops (task system)',
      provider: 'azure-devops',
      run: () =>
        new AzureDevOpsTaskSystemAdapter({ org: 'o', project: 'p', pat: 'x' }).annotate(
          '1',
          ANNOTATION,
          ctx,
        ),
    },
    {
      name: 'azure-devops-repos (PR)',
      provider: 'azure-devops-repos',
      run: () => {
        const a = new AzureDevOpsPullRequestAdapter({ pat: 'x' });
        return a.annotate(
          a.parsePrUrl('https://dev.azure.com/o/p/_git/r/pullrequest/1'),
          ANNOTATION,
          ctx,
        );
      },
    },
    {
      name: 'linear',
      provider: 'linear',
      run: () =>
        new LinearTaskSystemAdapter({ apiKey: 'k', teamId: 'team' }).annotate(
          'ENG-1',
          ANNOTATION,
          ctx,
        ),
    },
  ];

  it.each(unsupported)('$name falla con AnnotationNotSupportedError', async ({ provider, run }) => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const err = await run().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AnnotationNotSupportedError);
    expect((err as Error).message).toMatch(new RegExp(`anotación no soportada por ${provider}`));
    expect((err as Error).message).toMatch(/#25/);
    expect(spy).not.toHaveBeenCalled();
  });
});
