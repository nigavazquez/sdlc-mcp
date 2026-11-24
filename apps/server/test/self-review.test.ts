import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { Catalog } from '@sdlc/catalog';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';
import { ConfigBackedTaskSystemProvider } from '../src/adapters/task-system-provider.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import {
  ConfigBackedPullRequestProvider,
  NoOpPullRequestAdapter,
} from '../src/adapters/pull-request-provider.js';
import { InMemoryAdminStore } from '../src/admin/in-memory.js';
import { buildToolRegistry } from '../src/mcp/tools/index.js';
import { SELF_SIGNOFF_LABELS } from '../src/signoff/self-signoff-comment.js';
import { testCtx } from './helpers/tenant-ctx.js';
import { seedFlowStatus } from './helpers/flow-status.js';
import { reviewConHallazgos, reviewOk } from './helpers/review-envelope.js';

// Historia #27 (épica #20): review propio en request_code_review y submit_review_outcome.
// Seam: las dos tools vía registry, con el adapter real de GitHub contra un fetch
// stubbeado (para ver qué llega a GitHub) y el task system in-memory (para ver qué
// quedó anotado en el issue).

const PR_URL = 'https://github.com/owner/repo/pull/99';
const LABEL = SELF_SIGNOFF_LABELS.review;

/** alice implementa, pide y firma su propio review: el equipo de una persona. */
const alice = (): TenantCtx =>
  testCtx({
    tenantId: 't1',
    userId: 'alice',
    roles: ['developer', 'qa', 'reviewer', 'tech-lead'],
    workspaces: ['demo'],
    resolveSecret: async () => 'dummy-gh-token',
  });

const bob = (): TenantCtx =>
  testCtx({
    tenantId: 't1',
    userId: 'bob',
    roles: ['reviewer'],
    workspaces: ['demo'],
    resolveSecret: async () => 'dummy-gh-token',
  });

// ---------------------------------------------------------------------------
// fetch de GitHub: GET del PR abierto, listado de comentarios vacío, el resto 200.
// `failOn` hace fallar con 500 los requests cuya URL lo contenga.
// ---------------------------------------------------------------------------

type Call = { method: string; url: string; body?: Record<string, unknown> };

const mockFetch = vi.fn();
let failOn: string | undefined;

function calls(): Call[] {
  return mockFetch.mock.calls.map(([url, init]) => ({
    method: ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase(),
    url: String(url),
    ...((init as RequestInit | undefined)?.body
      ? { body: JSON.parse((init as RequestInit).body as string) as Record<string, unknown> }
      : {}),
  }));
}

const reviewsPosted = () =>
  calls().filter((c) => c.method === 'POST' && c.url.endsWith('/pulls/99/reviews'));
const reviewersRequested = () => calls().filter((c) => c.url.endsWith('/requested_reviewers'));

beforeEach(() => {
  failOn = undefined;
  mockFetch.mockReset();
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (failOn && url.includes(failOn)) {
      return Promise.resolve(new Response('upstream exploded', { status: 500 }));
    }
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && url.includes('/comments')) {
      return Promise.resolve(new Response('[]', { status: 200 }));
    }
    if (method === 'GET') {
      return Promise.resolve(
        new Response(
          JSON.stringify({ number: 99, title: 'PR', state: 'open', user: { login: 'alice' } }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
  vi.stubGlobal('fetch', mockFetch);
});
afterEach(() => vi.unstubAllGlobals());

async function makeRegistry(opts: { selfSignoff?: boolean; noOp?: boolean } = {}) {
  const catalog = await Catalog.load(resolve(__dirname, '../../../packages/catalog'));
  const store = new InMemoryFlowStore();
  const taskSystem = new InMemoryTaskSystemAdapter();
  const taskSystemProvider = new ConfigBackedTaskSystemProvider({
    configStore: new InMemoryIntegrationConfigStore(),
    inMemory: taskSystem,
  });
  const configStore = new InMemoryIntegrationConfigStore();
  if (!opts.noOp) {
    configStore.seed('t1', '', {
      pr_provider: { kind: 'github', secret_ref: 'aws-sm://gh#token', settings: {} },
    });
  }
  const pullRequestProvider = new ConfigBackedPullRequestProvider({
    configStore,
    noOp: new NoOpPullRequestAdapter(),
  });
  const adminStore = new InMemoryAdminStore();
  if (opts.selfSignoff === false) {
    await adminStore.createWorkspace({ workspace_id: 'demo', name: 'Demo' });
    await adminStore.setSelfSignoff('demo', false, 'admin@example.com');
  }
  const logs: Array<Record<string, unknown>> = [];
  const signoffLogger = {
    info: (obj: Record<string, unknown>) => logs.push({ level: 'info', ...obj }),
    warn: (obj: Record<string, unknown>) => logs.push({ level: 'warn', ...obj }),
  };
  const registry = buildToolRegistry({
    catalog,
    store,
    taskSystemProvider,
    pullRequestProvider,
    adminStore,
    signoffLogger,
  });
  return { store, taskSystem, registry, logs };
}

/** Story de alice en qa_passed con PR, como la deja submit_qa_results. */
async function seedQaPassed(
  store: InMemoryFlowStore,
  taskSystem: InMemoryTaskSystemAdapter,
  opts: { reviewRequested?: boolean } = {},
) {
  const flow = await store.createFlow({
    tenant_id: 't1',
    project: 'demo',
    slug: 'login',
    title: 'Login',
  });
  await seedFlowStatus(store, flow.flow_id, {
    status: 'qa_passed',
    current_phase: 'qa',
    epic_external_id: 'E-1',
    architecture_mode: 'new',
    codebase_status: 'greenfield',
  });
  const epic = await taskSystem.createEpic(
    { project_key: 'demo', title: 'Login', description: 'x' },
    alice(),
  );
  const ref = await taskSystem.createStory(
    {
      project_key: 'demo',
      epic_id: epic.external_id,
      title: 'User logs in',
      description: 'x',
      acceptance_criteria: ['email/password works'],
    },
    alice(),
  );
  const created = await store.createStory({
    flow_id: flow.flow_id,
    external_id: ref.external_id,
    external_url: ref.url,
    title: 'User logs in',
    acceptance_criteria: ['email/password works'],
    target_repo: 'https://github.com/owner/repo',
  });
  const story = await store.updateStory(created.story_id, {
    status: 'qa_passed',
    pr_url: PR_URL,
    assignee: 'alice',
  });
  if (opts.reviewRequested) {
    await store.appendEvent({
      flow_id: flow.flow_id,
      type: 'review.requested',
      actor: 'alice',
      payload: {
        story_id: story.story_id,
        pr_url: PR_URL,
        reviewer_ids: ['alice'],
        self_review: true,
      },
    });
  }
  return { flow, story };
}

type Out = {
  ok: boolean;
  error?: string;
  data?: { story: { status: string }; flow: { current_phase: string } };
};

// ---------------------------------------------------------------------------
// request_code_review
// ---------------------------------------------------------------------------

describe('request_code_review — review propio', () => {
  it('el autor como reviewer en un workspace permitido: no se pide review en GitHub, self_review:true y avanza', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem);

    const out = (await registry
      .get('request_code_review')!
      .handler({ story_id: story.story_id, reviewer_ids: ['alice'] }, alice())) as Out;

    expect(out.ok).toBe(true);
    expect(out.data?.flow.current_phase).toBe('review');
    expect(reviewersRequested()).toHaveLength(0);
    const ev = (await store.listEvents(flow.flow_id)).find((e) => e.type === 'review.requested');
    expect(ev?.payload).toMatchObject({
      story_id: story.story_id,
      pr_url: PR_URL,
      self_review: true,
    });
  });

  it('con otros reviewers además del autor, a ellos sí se les pide y al autor no', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem);

    const out = (await registry
      .get('request_code_review')!
      .handler({ story_id: story.story_id, reviewer_ids: ['bob', 'Alice'] }, alice())) as Out;

    expect(out.ok).toBe(true);
    const requested = reviewersRequested();
    expect(requested).toHaveLength(1);
    expect(requested[0]!.body).toEqual({ reviewers: ['bob'] });
    const ev = (await store.listEvents(flow.flow_id)).find((e) => e.type === 'review.requested');
    expect(ev?.payload).toMatchObject({ reviewer_ids: ['bob', 'Alice'], self_review: true });
  });

  it('con reviewers ajenos el camino es el de siempre: self_review:false', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem);

    const out = (await registry
      .get('request_code_review')!
      .handler({ story_id: story.story_id, reviewer_ids: ['bob'] }, alice())) as Out;

    expect(out.ok).toBe(true);
    expect(reviewersRequested()).toHaveLength(1);
    const ev = (await store.listEvents(flow.flow_id)).find((e) => e.type === 'review.requested');
    expect(ev?.payload).toMatchObject({ self_review: false });
  });

  it('workspace con self_signoff=false: se rechaza como hoy y no toca GitHub ni el flow', async () => {
    const { store, taskSystem, registry } = await makeRegistry({ selfSignoff: false });
    const { flow, story } = await seedQaPassed(store, taskSystem);

    const out = (await registry
      .get('request_code_review')!
      .handler({ story_id: story.story_id, reviewer_ids: ['alice'] }, alice())) as Out;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no permite la firma propia/);
    expect(out.error).toMatch(/demo/);
    expect(mockFetch).not.toHaveBeenCalled();
    expect((await store.getFlow(flow.flow_id))?.current_phase).toBe('qa');
    expect((await store.listEvents(flow.flow_id)).some((e) => e.type === 'review.requested')).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// submit_review_outcome
// ---------------------------------------------------------------------------

describe('submit_review_outcome — review propio', () => {
  it('approved por el autor: review COMMENT con el detalle, etiqueta en issue y PR, merged con self_signed:true', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem, { reviewRequested: true });

    const out = (await registry
      .get('submit_review_outcome')!
      .handler(
        {
          story_id: story.story_id,
          outcome: 'approved',
          comment: 'Todo en orden',
          review: reviewOk(),
        },
        alice(),
      )) as Out;

    expect(out.ok).toBe(true);
    expect(out.data?.story.status).toBe('merged');

    // GitHub: COMMENT, nunca APPROVE, con el detalle.
    const reviews = reviewsPosted();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.body?.event).toBe('COMMENT');
    expect(String(reviews[0]!.body?.body)).toMatch(/Review propio/);
    expect(String(reviews[0]!.body?.body)).toMatch(/Todo en orden/);
    expect(String(reviews[0]!.body?.body)).toMatch(/standards/);

    // Etiqueta y comentario en el PR (por la API de issues de GitHub).
    const prLabels = calls().find(
      (c) => c.method === 'POST' && c.url.endsWith('/issues/99/labels'),
    );
    expect(prLabels?.body).toEqual({ labels: [LABEL] });
    const prComment = calls().find(
      (c) => c.method === 'POST' && c.url.endsWith('/issues/99/comments'),
    );
    expect(String(prComment?.body?.body)).toMatch(/Review propio — firmado por alice/);

    // Etiqueta y comentario en el issue de la story.
    const issue = taskSystem.annotationsOf(story.external_id);
    expect(issue.labels).toEqual([LABEL]);
    expect(issue.comments[0]).toMatch(/Review propio — firmado por alice/);
    expect(issue.comments[0]).toMatch(/email\/password works/);

    const ev = (await store.listEvents(flow.flow_id)).find(
      (e) => e.type === 'review.outcome.submitted',
    );
    expect(ev?.payload).toMatchObject({ outcome: 'approved', self_signed: true });
  });

  it('changes_requested por el autor: también COMMENT, con el comentario', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem, { reviewRequested: true });

    const out = (await registry
      .get('submit_review_outcome')!
      .handler(
        {
          story_id: story.story_id,
          outcome: 'changes_requested',
          comment: 'Renombrar el retry',
          review: reviewConHallazgos(),
        },
        alice(),
      )) as Out;

    expect(out.ok).toBe(true);
    expect(out.data?.story.status).toBe('in_progress');
    const reviews = reviewsPosted();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.body?.event).toBe('COMMENT');
    expect(String(reviews[0]!.body?.body)).toMatch(/Renombrar el retry/);
    expect(String(reviews[0]!.body?.body)).toMatch(/src\/checkout\/pay\.ts:42/);
  });

  it('firma ajena: camino de siempre (APPROVE), sin anotación y self_signed:false', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem, { reviewRequested: true });

    const out = (await registry
      .get('submit_review_outcome')!
      .handler(
        { story_id: story.story_id, outcome: 'approved', comment: 'LGTM', review: reviewOk() },
        bob(),
      )) as Out;

    expect(out.ok).toBe(true);
    expect(reviewsPosted()[0]!.body?.event).toBe('APPROVE');
    expect(calls().some((c) => c.url.includes('/labels'))).toBe(false);
    expect(taskSystem.annotationsOf(story.external_id).labels).toEqual([]);
    const ev = (await store.listEvents(flow.flow_id)).find(
      (e) => e.type === 'review.outcome.submitted',
    );
    expect(ev?.payload).toMatchObject({ self_signed: false });
  });

  it('workspace con self_signoff=false: se rechaza como hoy, sin tocar GitHub ni la story', async () => {
    const { store, taskSystem, registry } = await makeRegistry({ selfSignoff: false });
    const { story } = await seedQaPassed(store, taskSystem, { reviewRequested: true });

    const out = (await registry
      .get('submit_review_outcome')!
      .handler(
        { story_id: story.story_id, outcome: 'approved', review: reviewOk() },
        alice(),
      )) as Out;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no permite la firma propia/);
    expect(out.error).toMatch(/submit_review_outcome/);
    expect(mockFetch).not.toHaveBeenCalled();
    expect((await store.getStory(story.story_id))?.status).toBe('qa_passed');
  });

  it('sin un PR provider real (no-op) se rechaza explícitamente: la marca no quedaría visible', async () => {
    const { store, taskSystem, registry } = await makeRegistry({ noOp: true });
    const { flow, story } = await seedQaPassed(store, taskSystem, { reviewRequested: true });

    const out = (await registry
      .get('submit_review_outcome')!
      .handler(
        { story_id: story.story_id, outcome: 'approved', review: reviewOk() },
        alice(),
      )) as Out;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/review propio/i);
    expect(out.error).toMatch(/pr_provider/);
    expect(taskSystem.annotationsOf(story.external_id).labels).toEqual([]);
    expect((await store.getStory(story.story_id))?.status).toBe('qa_passed');
    expect(
      (await store.listEvents(flow.flow_id)).some((e) => e.type === 'review.outcome.submitted'),
    ).toBe(false);
  });

  it('si anotar el PR falla, rechaza y no escribe nada: ni review en GitHub, ni story, ni evento; queda en el log', async () => {
    const { store, taskSystem, registry, logs } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem, { reviewRequested: true });
    failOn = '/issues/99/labels';

    const out = (await registry
      .get('submit_review_outcome')!
      .handler(
        { story_id: story.story_id, outcome: 'approved', review: reviewOk() },
        alice(),
      )) as Out;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/anotar/i);
    expect(out.error).toMatch(/submit_review_outcome/);
    expect(reviewsPosted()).toHaveLength(0);
    expect((await store.getStory(story.story_id))?.status).toBe('qa_passed');
    expect(
      (await store.listEvents(flow.flow_id)).some((e) => e.type === 'review.outcome.submitted'),
    ).toBe(false);
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        evt: 'signoff.annotate_failed',
        tool: 'submit_review_outcome',
        target: 'pr',
      }),
    );
  });

  it('si anotar el issue falla, rechaza antes de tocar el PR', async () => {
    const { store, taskSystem, registry, logs } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem, { reviewRequested: true });
    taskSystem.annotate = async () => {
      throw new Error('task system caído');
    };

    const out = (await registry
      .get('submit_review_outcome')!
      .handler(
        { story_id: story.story_id, outcome: 'approved', review: reviewOk() },
        alice(),
      )) as Out;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/task system caído/);
    expect(reviewsPosted()).toHaveLength(0);
    expect(calls().some((c) => c.url.includes('/labels'))).toBe(false);
    expect((await store.getStory(story.story_id))?.status).toBe('qa_passed');
    expect(logs).toContainEqual(
      expect.objectContaining({ evt: 'signoff.annotate_failed', target: 'issue' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Ciclo completo del equipo de una persona
// ---------------------------------------------------------------------------

describe('review propio — ciclo completo', () => {
  it('qa_passed → request_code_review(alice) → submit_review_outcome(alice) → merged', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem);

    const req = (await registry
      .get('request_code_review')!
      .handler({ story_id: story.story_id, reviewer_ids: ['alice'] }, alice())) as Out;
    expect(req.ok).toBe(true);

    const sub = (await registry
      .get('submit_review_outcome')!
      .handler(
        { story_id: story.story_id, outcome: 'approved', review: reviewOk() },
        alice(),
      )) as Out;
    expect(sub.ok).toBe(true);
    expect(sub.data?.story.status).toBe('merged');
    expect((await store.getFlow(flow.flow_id))?.current_phase).toBe('done');
  });
});
