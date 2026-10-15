import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { Catalog } from '@sdlc/catalog';
import { resolve } from 'node:path';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';
import { ConfigBackedTaskSystemProvider } from '../src/adapters/task-system-provider.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import {
  ConfigBackedPullRequestProvider,
  NoOpPullRequestAdapter,
  isNoOpPullRequestAdapter,
} from '../src/adapters/pull-request-provider.js';
import {
  adoRepoIdentity,
  assertPrTargetsStoryRepo,
  githubRepoIdentity,
  normalizePrState,
  prRepoIdentity,
} from '../src/mcp/tools/submit-review-outcome.js';
import { findAuthorAmongReviewers } from '../src/mcp/tools/request-code-review.js';
import { buildToolRegistry } from '../src/mcp/tools/index.js';
import { testCtx, type TestCtxOptions } from './helpers/tenant-ctx.js';
import { seedFlowStatus } from './helpers/flow-status.js';
import { REVIEW_ENVELOPE_SCHEMA } from '@sdlc/core';
import { reviewOk, reviewConHallazgos } from './helpers/review-envelope.js';

const PR_URL = 'https://github.com/owner/repo/pull/99';

// ---------------------------------------------------------------------------
// Contextos por rol. submit_review_outcome pide reviewer|tech-lead;
// request_code_review pide qa|tech-lead. Cada test usa el rol que corresponde
// para que un cambio en las guardas no pase inadvertido.
//
// El claim `workspaces` va explícito: las guardas de workspace ya no dejan pasar
// un ctx sin él. alice es miembro de los tres workspaces que usan los flows de
// este archivo. `resolveSecret` devuelve un token de mentira porque los tests de
// abajo ejercitan el adapter real de GitHub contra un `fetch` stubbeado.
//
// Los overrides entran *por* `testCtx` en vez de spreadearse encima del ctx ya
// construido: las tools evalúan el rol contra `ctx.workspaces[flow.project]`, así
// que un override de `roles` tiene que rederivar el mapa del claim. Un test que
// necesite roles distintos por workspace pasa el mapa completo en `workspaces`.
// ---------------------------------------------------------------------------

const ctx = (overrides: Partial<TestCtxOptions> = {}): TenantCtx =>
  testCtx({
    tenantId: 't1',
    userId: 'alice',
    roles: ['reviewer'],
    workspaces: ['demo', 'demo2', 'p'],
    resolveSecret: async () => 'dummy-gh-token',
    ...overrides,
  });

/** Rol habilitado para pedir el review (el paso posterior a que QA apruebe). */
const qaCtx = (overrides: Partial<TestCtxOptions> = {}): TenantCtx =>
  ctx({ userId: 'quincy', roles: ['qa'], ...overrides });

/** Rol habilitado para firmar el outcome. */
const reviewerCtx = (overrides: Partial<TestCtxOptions> = {}): TenantCtx =>
  ctx({ userId: 'bob', roles: ['reviewer'], ...overrides });

// ---------------------------------------------------------------------------
// Stub de fetch para el adapter real de GitHub.
// ---------------------------------------------------------------------------

type GhStubOpts = {
  /** `state` que devuelve GET /pulls/:n — 'open' | 'closed' | lo que se quiera probar. */
  state?: string;
  /** Devuelve el PR **sin** el campo `state`, como un provider que cambió el contrato. */
  omitState?: boolean;
  /** Cuando está seteado, el GET del PR falla con ese status HTTP. */
  getStatus?: number;
};

function ghFetchStub(opts: GhStubOpts = {}) {
  return (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET') {
      if (opts.getStatus) {
        return Promise.resolve(new Response('upstream exploded', { status: opts.getStatus }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            number: 99,
            title: 'PR de prueba',
            ...(opts.omitState ? {} : { state: opts.state ?? 'open' }),
            user: { login: 'alice' },
          }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
}

const mockFetch = vi.fn();
beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(ghFetchStub());
  vi.stubGlobal('fetch', mockFetch);
});
afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// Registries. El default trae un pr_provider real (GitHub) porque las tools de
// review ahora rechazan el no-op; `makeNoOpRegistry` existe justamente para
// probar ese rechazo.
// ---------------------------------------------------------------------------

async function buildRegistry(configStore: InMemoryIntegrationConfigStore) {
  const catalog = await Catalog.load(resolve(__dirname, '../../../packages/catalog'));
  const store = new InMemoryFlowStore();
  const taskSystem = new InMemoryTaskSystemAdapter();
  const taskSystemProvider = new ConfigBackedTaskSystemProvider({
    configStore: new InMemoryIntegrationConfigStore(),
    inMemory: taskSystem,
  });
  const pullRequestProvider = new ConfigBackedPullRequestProvider({
    configStore,
    noOp: new NoOpPullRequestAdapter(),
  });
  const registry = buildToolRegistry({ catalog, store, taskSystemProvider, pullRequestProvider });
  return { store, taskSystem, registry };
}

async function makeRegistry() {
  const configStore = new InMemoryIntegrationConfigStore();
  // project '' = default del tenant: cualquier proyecto resuelve a GitHub.
  configStore.seed('t1', '', {
    pr_provider: { kind: 'github', secret_ref: 'aws-sm://gh#token', settings: {} },
  });
  return buildRegistry(configStore);
}

/** Sin pr_provider configurado → el provider cae al NoOpPullRequestAdapter. */
async function makeNoOpRegistry() {
  return buildRegistry(new InMemoryIntegrationConfigStore());
}

/**
 * Emite el `review.requested` de una story, como lo haría request_code_review.
 *
 * submit_review_outcome ahora exige ese evento para *esta* story **y para el PR
 * que la story tiene ahora**: sin él, `request_code_review` sería opcional y
 * todas sus guardas se evitarían con sólo no llamarla; sin el `pr_url`, el
 * evento sería un token permanente que sobrevive a un cambio de PR. Por eso el
 * seed lleva el `pr_url` en el payload igual que la tool real. Los tests que
 * ejercitan submit_review_outcome de forma aislada lo siembran explícitamente
 * (`reviewRequested: true`) en vez de que el seed lo haga siempre, porque hay
 * tests que justamente verifican que el evento NO exista.
 */
async function seedReviewRequested(
  store: InMemoryFlowStore,
  flowId: string,
  storyId: string,
  prUrl?: string,
) {
  await store.appendEvent({
    flow_id: flowId,
    type: 'review.requested',
    actor: 'quincy',
    payload: { story_id: storyId, reviewer_ids: ['bob'], ...(prUrl ? { pr_url: prUrl } : {}) },
  });
}

async function seedQaPassed(
  store: InMemoryFlowStore,
  taskSystem: InMemoryTaskSystemAdapter,
  opts: {
    project?: string;
    slug?: string;
    prUrl?: string | null;
    assignee?: string;
    /** Siembra el `review.requested` de la story (lo que hace request_code_review). */
    reviewRequested?: boolean;
    /**
     * Repo declarado de la story (lo que denormaliza create_stories del componente).
     * `null` = la story NO declara repo, que es el flow greenfield del hallazgo A.
     */
    targetRepo?: string | null;
    /** Stories hermanas del mismo flow, creadas en `created` (flow multi-story). */
    siblings?: number;
  } = {},
) {
  const project = opts.project ?? 'demo';
  const flow = await store.createFlow({
    tenant_id: 't1', project, slug: opts.slug ?? `login-${Math.random().toString(36).slice(2)}`,
    title: 'Login feature',
  });
  await seedFlowStatus(store, flow.flow_id, {
    status: 'qa_passed', current_phase: 'qa',
    epic_external_id: 'ADO-1', architecture_mode: 'new', codebase_status: 'greenfield',
  });
  const epicRef = await taskSystem.createEpic(
    { project_key: project, title: 'Login', description: 'x' }, ctx(),
  );
  const storyRef = await taskSystem.createStory({
    project_key: project, epic_id: epicRef.external_id, title: 'User logs in',
    description: 'happy login', acceptance_criteria: ['email/password works'],
  }, ctx());
  const prUrl = opts.prUrl === null ? undefined : (opts.prUrl ?? PR_URL);
  // Toda story nace con repo declarado: `create_stories` lo exige y el gate del
  // review falla cerrado sin él. El default se deriva del propio pr_url para que
  // el camino legítimo del seed sea coherente; los tests que quieren el caso
  // "sin repo declarado" (el flow greenfield del hallazgo A) pasan `targetRepo: null`.
  const defaultRepo = prUrl ? prUrl.replace(/\/pull\/.*$/, '') : 'https://github.com/owner/repo';
  const targetRepo = opts.targetRepo === null ? undefined : (opts.targetRepo ?? defaultRepo);
  const story = await store.createStory({
    flow_id: flow.flow_id, external_id: storyRef.external_id, external_url: storyRef.url,
    title: 'User logs in', acceptance_criteria: ['email/password works'],
    ...(targetRepo ? { target_repo: targetRepo } : {}),
  });
  // manually advance story to qa_passed (mirrors what submit_qa_results does)
  const updatedStory = await store.updateStory(story.story_id, {
    status: 'qa_passed',
    ...(prUrl !== undefined ? { pr_url: prUrl } : {}),
    ...(opts.assignee !== undefined ? { assignee: opts.assignee } : {}),
  });
  const siblings = [];
  for (let i = 0; i < (opts.siblings ?? 0); i++) {
    // Las hermanas también se crean en el task system: `discard_story` transiciona
    // el work item externo, así que una story que sólo existe en el flow store
    // haría fallar la tool por un hueco del seed y no por lo que se está probando.
    const sibRef = await taskSystem.createStory({
      project_key: project, epic_id: epicRef.external_id, title: `Story hermana ${i}`,
      description: 'x', acceptance_criteria: ['x'],
    }, ctx());
    siblings.push(
      await store.createStory({
        flow_id: flow.flow_id, external_id: sibRef.external_id,
        external_url: sibRef.url, title: `Story hermana ${i}`, acceptance_criteria: ['x'],
        ...(targetRepo ? { target_repo: targetRepo } : {}),
      }),
    );
  }
  if (opts.reviewRequested) await seedReviewRequested(store, flow.flow_id, story.story_id, prUrl);
  return { flow, story: updatedStory, siblings };
}

type ToolOut = {
  ok: boolean;
  error?: string;
  data?: {
    story: { status: string };
    flow: { status: string; current_phase: string };
  };
};

describe('request_code_review', () => {
  it('calls adapter requestReview, advances flow to review phase, emits event', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem);

    const tool = registry.get('request_code_review');
    expect(tool).toBeDefined();

    const out = (await tool!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'], message: 'please review' },
      qaCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(true);
    expect(out.data?.flow.current_phase).toBe('review');
    expect(out.data?.flow.status).toBe('impl_in_review');

    const events = await store.listEvents(flow.flow_id);
    expect(events.some((e) => e.type === 'review.requested')).toBe(true);
  });

  it('rejects story not in qa_passed', async () => {
    const { store, registry } = await makeRegistry();
    const flow = await store.createFlow({ tenant_id: 't1', project: 'demo', slug: 'other', title: 'x' });
    const story = await store.createStory({
      flow_id: flow.flow_id, external_id: 'ext-1', external_url: 'https://example.com',
      title: 't', acceptance_criteria: [],
    });
    const out = (await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] },
      qaCtx(),
    )) as ToolOut;
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/qa_passed/);
  });

  it('rejects story with no pr_url', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem, { project: 'demo2', prUrl: null });

    const out = (await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] },
      qaCtx(),
    )) as ToolOut;
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/pr_url/);
  });

  it('rechaza rol equivocado y nombra la salida', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem);

    const out = (await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] },
      ctx({ userId: 'dan', roles: ['developer'] }),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/requiere rol qa o tech-lead/);
    expect(out.error).toMatch(/request_code_review/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('acepta tech-lead además de qa', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem);

    const out = (await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] },
      ctx({ userId: 'tina', roles: ['tech-lead'] }),
    )) as ToolOut;
    expect(out.ok).toBe(true);
  });

  it('evalúa los roles contra el workspace del flow, no contra el tenant', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem, { project: 'demo' });

    // qa en "otro", nada en "demo" → no puede pedir el review acá.
    const out = (await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] },
      ctx({ userId: 'quincy', roles: ['qa'], workspaces: { otro: ['qa'], demo: [] } }),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/demo/);
  });

  it('rechaza reviewer_ids que incluyan al assignee de la story', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem, { assignee: 'alice' });

    const out = (await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob', 'Alice'] },
      qaCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no puede revisar su propio cambio|propio cambio/i);
    expect(out.error).toMatch(/request_code_review/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rechaza reviewer_ids que incluyan a quien llama', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem);

    const out = (await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['quincy'] },
      qaCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/propio cambio/i);
  });

  it('rechaza el NoOpPullRequestAdapter y dice qué configurar', async () => {
    const { store, taskSystem, registry } = await makeNoOpRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem);

    const out = (await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] },
      qaCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/pr_provider/);
    expect(out.error).toMatch(/tenant_integrations/);
    expect(out.error).toMatch(/request_code_review/);
    // El flow NO avanzó a review.
    const after = await store.getFlow(flow.flow_id);
    expect(after?.current_phase).toBe('qa');
    const events = await store.listEvents(flow.flow_id);
    expect(events.some((e) => e.type === 'review.requested')).toBe(false);
  });
});

describe('submit_review_outcome', () => {
  it('approved: advances story to merged and flow to done', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem, { reviewRequested: true });
    // Advance flow to review phase first
    await seedFlowStatus(store, flow.flow_id, { current_phase: 'review', status: 'impl_in_review' });

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(true);
    expect(out.data?.story.status).toBe('merged');
    expect(out.data?.flow.status).toBe('merged');
    expect(out.data?.flow.current_phase).toBe('done');

    const events = await store.listEvents(flow.flow_id);
    expect(events.some((e) => e.type === 'review.outcome.submitted')).toBe(true);
  });

  it('changes_requested: returns story to in_progress and flow to implementation', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem, { reviewRequested: true });
    await seedFlowStatus(store, flow.flow_id, { current_phase: 'review', status: 'impl_in_review' });

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'changes_requested', comment: 'please fix X' , review: reviewConHallazgos() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(true);
    expect(out.data?.story.status).toBe('in_progress');
    expect(out.data?.flow.current_phase).toBe('implementation');
  });

  it('rejects changes_requested without comment', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem);
    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'changes_requested' , review: reviewConHallazgos() },
      reviewerCtx(),
    )) as ToolOut;
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/comment.*required|required.*comment/i);
  });

  it('rejects story not in qa_passed', async () => {
    const { store, registry } = await makeRegistry();
    const flow = await store.createFlow({ tenant_id: 't1', project: 'p', slug: 's', title: 't' });
    const story = await store.createStory({
      flow_id: flow.flow_id, external_id: 'x', external_url: 'https://example.com',
      title: 't', acceptance_criteria: [],
    });
    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/qa_passed/);
  });

  it('rechaza rol equivocado antes de tocar el proveedor', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem);

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved' , review: reviewOk() },
      ctx({ userId: 'dan', roles: ['developer'] }),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/requiere rol reviewer o tech-lead/);
    expect(out.error).toMatch(/submit_review_outcome/);
    expect(mockFetch).not.toHaveBeenCalled();
    expect((await store.getStory(story.story_id))?.status).toBe('qa_passed');
  });

  it('el assignee no puede firmar su propio review', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem, { assignee: 'alice' });

    // alice tiene rol reviewer, pero es la dueña de la story.
    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      ctx({ userId: 'alice', roles: ['reviewer', 'tech-lead'] }),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no puede firmar/);
    expect(out.error).toMatch(/submit_review_outcome/);
    expect(mockFetch).not.toHaveBeenCalled();
    expect((await store.getStory(story.story_id))?.status).toBe('qa_passed');
  });

  it('rechaza el NoOpPullRequestAdapter en vez de fabricar el merge', async () => {
    const { store, taskSystem, registry } = await makeNoOpRegistry();
    const { story } = await seedQaPassed(store, taskSystem, { reviewRequested: true });

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/pr_provider/);
    expect(out.error).toMatch(/tenant_integrations/);
    expect(out.error).toMatch(/submit_review_outcome/);
    expect((await store.getStory(story.story_id))?.status).toBe('qa_passed');
  });
});

// ---------------------------------------------------------------------------
// Verificación del PR antes de firmarlo
// ---------------------------------------------------------------------------

describe('normalizePrState', () => {
  it('mapea el vocabulario de ADO', () => {
    expect(normalizePrState('active')).toBe('open');
    expect(normalizePrState('completed')).toBe('closed');
    expect(normalizePrState('abandoned')).toBe('closed');
  });

  it('mapea el vocabulario de GitHub', () => {
    expect(normalizePrState('open')).toBe('open');
    expect(normalizePrState('closed')).toBe('closed');
  });

  it('ignora caja y espacios', () => {
    expect(normalizePrState('  ACTIVE ')).toBe('open');
    expect(normalizePrState('Open')).toBe('open');
    expect(normalizePrState('Abandoned')).toBe('closed');
  });

  it('un estado desconocido no cuenta como abierto', () => {
    expect(normalizePrState('draft-ish')).toBe('unknown');
    expect(normalizePrState('')).toBe('unknown');
  });

  it('un estado ausente cae en unknown en vez de tirar', () => {
    // Un provider que devuelve el PR sin `state` hacía explotar `.trim()` fuera de
    // los try/catch del handler: el agente recibía un TypeError, no {ok:false}.
    expect(() => normalizePrState(undefined)).not.toThrow();
    expect(normalizePrState(undefined)).toBe('unknown');
    expect(normalizePrState(null)).toBe('unknown');
    expect(normalizePrState(42 as unknown as string)).toBe('unknown');
  });
});

describe('submit_review_outcome — verificación del PR', () => {
  it('trae el PR antes de firmarlo', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem, { reviewRequested: true });

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(true);
    // El primer request al proveedor es el GET del PR, no el POST del review.
    const [firstUrl, firstInit] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(firstInit.method).toBe('GET');
    expect(firstUrl).toContain('/pulls/99');
  });

  it('rechaza un PR cerrado (GitHub closed) y no postea el review', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem, { reviewRequested: true });
    mockFetch.mockImplementation(ghFetchStub({ state: 'closed' }));

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no está abierto/);
    expect(out.error).toMatch(/report_progress|request_code_review/);
    expect((await store.getStory(story.story_id))?.status).toBe('qa_passed');
    const posted = mockFetch.mock.calls.some(
      (c) => ((c as [string, RequestInit])[1]?.method ?? 'GET') === 'POST',
    );
    expect(posted).toBe(false);
  });

  it('rechaza un PR abandonado (vocabulario de ADO)', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem, { reviewRequested: true });
    mockFetch.mockImplementation(ghFetchStub({ state: 'Abandoned' }));

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no está abierto/);
  });

  it('rechaza un estado desconocido en vez de asumir que está abierto', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem, { reviewRequested: true });
    mockFetch.mockImplementation(ghFetchStub({ state: 'quién-sabe' }));

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/desconocido/);
  });

  it('un PR cerrado también bloquea changes_requested', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem, { reviewRequested: true });
    mockFetch.mockImplementation(ghFetchStub({ state: 'closed' }));

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'changes_requested', comment: 'fix X' , review: reviewConHallazgos() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect((await store.getStory(story.story_id))?.status).toBe('qa_passed');
  });

  it('un error del proveedor trayendo el PR aborta la operación', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem, { reviewRequested: true });
    mockFetch.mockImplementation(ghFetchStub({ getStatus: 500 }));

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/No se pudo verificar el PR/);
    expect(out.error).toMatch(/submit_review_outcome/);
    expect((await store.getStory(story.story_id))?.status).toBe('qa_passed');
    const events = await store.listEvents(flow.flow_id);
    expect(events.some((e) => e.type === 'review.outcome.submitted')).toBe(false);
  });

  it('un PR inexistente (404) aborta la operación', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem, { reviewRequested: true });
    mockFetch.mockImplementation(ghFetchStub({ getStatus: 404 }));

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/No se pudo verificar el PR/);
    expect((await store.getStory(story.story_id))?.status).toBe('qa_passed');
  });
});

// ---------------------------------------------------------------------------
// request_code_review es obligatorio
// ---------------------------------------------------------------------------

describe('submit_review_outcome — el review tiene que haber sido pedido', () => {
  it('sin review.requested rechaza y nombra request_code_review', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem); // sin reviewRequested

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/review\.requested/);
    expect(out.error).toMatch(/request_code_review/);
    expect((await store.getStory(story.story_id))?.status).toBe('qa_passed');
    // Antes del proveedor: ni el GET del PR se hizo.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('un review.requested de OTRA story del mismo flow no habilita a ésta', async () => {
    // El corazón de por qué chequeamos el evento y no `flow.current_phase`: la
    // fase la deja puesta cualquier story del flow.
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story, siblings } = await seedQaPassed(store, taskSystem, { siblings: 1 });
    await seedReviewRequested(store, flow.flow_id, siblings[0]!.story_id);
    await seedFlowStatus(store, flow.flow_id, { current_phase: 'review', status: 'impl_in_review' });

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/request_code_review/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('changes_requested también exige el review pedido', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem);

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'changes_requested', comment: 'fix X' , review: reviewConHallazgos() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/request_code_review/);
  });
});

// ---------------------------------------------------------------------------
// El PR tiene que ser el de la story
// ---------------------------------------------------------------------------

describe('submit_review_outcome — el PR tiene que pertenecer al repo de la story', () => {
  it('rechaza un pr_url de otro repo y no postea el APPROVE', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem, {
      targetRepo: 'https://github.com/acme/checkout',
      prUrl: 'https://github.com/mallory/scratch/pull/1',
      reviewRequested: true,
    });

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/mallory\/scratch/);
    expect(out.error).toMatch(/acme\/checkout/);
    expect(out.error).toMatch(/report_progress/);
    expect((await store.getStory(story.story_id))?.status).toBe('qa_passed');
    // Guarda antes de cualquier side-effect: ni el GET del PR llegó a salir.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('request_code_review rechaza el mismo pr_url ajeno antes de tocar el repo', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem, {
      targetRepo: 'https://github.com/acme/checkout',
      prUrl: 'https://github.com/mallory/scratch/pull/1',
    });

    const out = (await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] },
      qaCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/mallory\/scratch/);
    expect(mockFetch).not.toHaveBeenCalled();
    const events = await store.listEvents(flow.flow_id);
    expect(events.some((e) => e.type === 'review.requested')).toBe(false);
  });

  it('una diferencia cosmética (.git, barra final, mayúsculas) no rompe el camino legítimo', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem, {
      targetRepo: 'https://github.com/Acme/Checkout.git/',
      prUrl: 'https://github.com/acme/checkout/pull/99',
      reviewRequested: true,
    });

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(true);
    expect(out.data?.story.status).toBe('merged');
  });

  it('un repo declarado que no se puede interpretar falla cerrado y lo dice', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem, {
      // Un identificador suelto: no hay forma confiable de compararlo con un PR de GitHub.
      targetRepo: 'checkout',
      prUrl: 'https://github.com/acme/checkout/pull/99',
      reviewRequested: true,
    });

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no se puede verificar de forma confiable/);
    expect(out.error).toMatch(/submit_rfc|report_progress/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sin repo declarado en ningún lado falla cerrado: "no hay contra qué comparar" no es "pasá"', async () => {
    // Este test decía lo contrario y era el hallazgo A: el `return null` que
    // cubría supuestamente el "legacy single-repo" desactivaba el gate para todo
    // flow greenfield, presente y futuro.
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem, { targetRepo: null, reviewRequested: true });

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no declara ningún repo/i);
    expect((await store.getStory(story.story_id))?.status).toBe('qa_passed');
  });
});

describe('identidad de repo por proveedor', () => {
  it('GitHub: normaliza esquema, credencial, .git, barra final y caja', () => {
    expect(githubRepoIdentity('https://github.com/acme/checkout')).toBe('acme/checkout');
    expect(githubRepoIdentity('https://github.com/Acme/Checkout.git/')).toBe('acme/checkout');
    expect(githubRepoIdentity('git@github.com:acme/checkout.git')).toBe('acme/checkout');
    expect(githubRepoIdentity('acme/checkout')).toBe('acme/checkout');
    expect(githubRepoIdentity('http://user@github.com/acme/checkout')).toBe('acme/checkout');
  });

  it('GitHub: lo que no puede interpretar da null (no comparable → fail closed)', () => {
    expect(githubRepoIdentity('https://gitlab.com/acme/checkout')).toBeNull();
    expect(githubRepoIdentity('checkout')).toBeNull();
    expect(githubRepoIdentity('')).toBeNull();
    // El host sigue siendo estricto: es lo único que no se afloja.
    expect(githubRepoIdentity('https://github.com.evil.io/acme/checkout')).toBeNull();
    expect(githubRepoIdentity('https://evil.com/acme/checkout')).toBeNull();
  });

  it('GitHub: un sufijo de path SÍ se tolera (hallazgo E)', () => {
    // Antes esto daba null y frenaba el review semanas después de escrito el RFC,
    // siendo que es lo que sale de copiar la barra del navegador.
    expect(githubRepoIdentity('https://github.com/acme/checkout/tree/main/pkg')).toBe('acme/checkout');
  });

  it('ADO: dev.azure.com y el host legacy visualstudio.com', () => {
    expect(adoRepoIdentity('https://dev.azure.com/MyOrg/MyProject/_git/MyRepo')).toBe('myorg/myproject/myrepo');
    expect(adoRepoIdentity('https://myorg@dev.azure.com/myorg/proj/_git/repo.git')).toBe('myorg/proj/repo');
    expect(adoRepoIdentity('https://myorg.visualstudio.com/proj/_git/repo')).toBe('myorg/proj/repo');
    expect(adoRepoIdentity('https://github.com/acme/checkout')).toBeNull();
  });

  it('prRepoIdentity lee el _parsed del adapter y decodifica lo que parsePrUrl encodeó', () => {
    expect(prRepoIdentity('github', { url: 'u', pr_id: '1', _parsed: { owner: 'Acme', repo: 'check%2Dout' } }))
      .toBe('acme/check-out');
    expect(prRepoIdentity('azure-devops-repos', { url: 'u', pr_id: '1', _parsed: { org: 'O', project: 'P', repo: 'R' } }))
      .toBe('o/p/r');
    // Un adapter que no llena `_parsed` no es comparable.
    expect(prRepoIdentity('github', { url: 'u', pr_id: '1', _parsed: {} })).toBeNull();
    expect(prRepoIdentity('otro-proveedor', { url: 'u', pr_id: '1', _parsed: { owner: 'a', repo: 'b' } })).toBeNull();
  });

  it('assertPrTargetsStoryRepo: sin repo declarado BLOQUEA; con mismatch también', () => {
    const ref = { url: 'https://github.com/mallory/scratch/pull/1', pr_id: '1', _parsed: { owner: 'mallory', repo: 'scratch' } };

    // Hallazgo A: acá antes se devolvía null (pasá). Un PR que se va a verificar
    // tiene que tener un repo declarado contra el cual verificarlo.
    const sinRepo = assertPrTargetsStoryRepo('github', ref, undefined, 'submit_review_outcome');
    expect(sinRepo).toMatch(/no declara ningún repo/i);
    expect(sinRepo).toMatch(/submit_rfc/);

    expect(assertPrTargetsStoryRepo('github', ref, 'https://github.com/mallory/scratch', 'submit_review_outcome')).toBeNull();
    const err = assertPrTargetsStoryRepo('github', ref, 'https://github.com/acme/checkout', 'submit_review_outcome');
    expect(err).toMatch(/acme\/checkout/);
    expect(err).toMatch(/submit_review_outcome/);
  });
});

// ---------------------------------------------------------------------------
// Una story aprobada no cierra el flow entero
// ---------------------------------------------------------------------------

describe('submit_review_outcome — cierre del flow', () => {
  it('con stories pendientes, aprobar la primera NO deja el flow en done', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem, { siblings: 2, reviewRequested: true });

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(true);
    expect(out.data?.story.status).toBe('merged');
    expect(out.data?.flow.current_phase).not.toBe('done');
    expect(out.data?.flow.status).not.toBe('merged');

    const persisted = await store.getFlow(flow.flow_id);
    expect(persisted?.current_phase).toBe('qa'); // el flow se quedó donde estaba
    expect(persisted?.status).toBe('qa_passed');
  });

  it('el flow sí cierra cuando se aprueba la última story pendiente', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story, siblings } = await seedQaPassed(store, taskSystem, { siblings: 2, reviewRequested: true });

    // Las hermanas ya se mergearon por su propio camino.
    for (const s of siblings) await store.updateStory(s.story_id, { status: 'merged' });

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(true);
    expect(out.data?.flow.status).toBe('merged');
    expect(out.data?.flow.current_phase).toBe('done');
    expect((await store.getFlow(flow.flow_id))?.current_phase).toBe('done');
  });

  it('una story única sigue cerrando el flow al aprobarse', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem, { reviewRequested: true });

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(true);
    expect(out.data?.flow.status).toBe('merged');
    expect(out.data?.flow.current_phase).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// El PR sin estado no puede tirar
// ---------------------------------------------------------------------------

describe('submit_review_outcome — PR sin campo de estado', () => {
  it('un provider que devuelve el PR sin state da {ok:false} con mensaje, no una excepción', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem, { reviewRequested: true });
    mockFetch.mockImplementation(ghFetchStub({ omitState: true }));

    // La promesa no rechaza: el contrato de las tools es {ok:false, error}.
    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/desconocido/);
    expect(out.error).toMatch(/request_code_review|report_progress/);
    expect((await store.getStory(story.story_id))?.status).toBe('qa_passed');
    // Fail-closed: el APPROVE nunca se posteó.
    const posted = mockFetch.mock.calls.some(
      (c) => ((c as [string, RequestInit])[1]?.method ?? 'GET') === 'POST',
    );
    expect(posted).toBe(false);
  });
});

describe('isNoOpPullRequestAdapter', () => {
  it('reconoce el no-op', () => {
    expect(isNoOpPullRequestAdapter(new NoOpPullRequestAdapter())).toBe(true);
  });

  it('no marca a un adapter real', async () => {
    const { GitHubPullRequestAdapter } = await import('../src/adapters/github-pr-adapter.js');
    expect(isNoOpPullRequestAdapter(new GitHubPullRequestAdapter({ token: 'x' }))).toBe(false);
  });
});

describe('findAuthorAmongReviewers', () => {
  it('devuelve el reviewer que coincide con el autor, sin importar la caja', () => {
    expect(findAuthorAmongReviewers([' Alice '], ['alice', undefined])).toBe(' Alice ');
  });

  it('devuelve undefined cuando ninguno coincide', () => {
    expect(findAuthorAmongReviewers(['bob', 'carol'], ['alice', 'dan'])).toBeUndefined();
  });

  it('ignora autores ausentes', () => {
    expect(findAuthorAmongReviewers(['bob'], [undefined, undefined])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tool-seam tests using a real GitHub adapter (fetch stubbed)
// ---------------------------------------------------------------------------

async function makeGitHubRegistry() {
  const ghConfigStore = new InMemoryIntegrationConfigStore();
  ghConfigStore.seed('t1', 'demo', {
    pr_provider: { kind: 'github', secret_ref: 'aws-sm://gh#token', settings: {} },
  });
  return buildRegistry(ghConfigStore);
}

async function seedQaPassedGh(
  store: InMemoryFlowStore,
  taskSystem: InMemoryTaskSystemAdapter,
  prUrl: string,
  opts: { reviewRequested?: boolean } = {},
) {
  return seedQaPassed(store, taskSystem, {
    project: 'demo',
    slug: `gh-${Date.now()}`,
    prUrl,
    ...(opts.reviewRequested ? { reviewRequested: true } : {}),
  });
}

describe('real GitHub adapter — tool-seam tests', () => {
  it('Test A: valid GitHub PR URL → request_code_review returns ok:true and fetch is called', async () => {
    const { store, taskSystem, registry } = await makeGitHubRegistry();
    const { story } = await seedQaPassedGh(store, taskSystem, 'https://github.com/o/r/pull/1');

    const out = (await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] },
      qaCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(true);
    expect(out.data?.flow.current_phase).toBe('review');
    expect(out.data?.flow.status).toBe('impl_in_review');
    // fetch must have been called for the reviewers endpoint
    expect(mockFetch).toHaveBeenCalled();
    const calledUrl = (mockFetch.mock.calls[0] as [string, ...unknown[]])[0];
    expect(calledUrl).toContain('requested_reviewers');
  });

  it('Test A (cont): submit_review_outcome(approved) → story merged, flow done, ok:true', async () => {
    const { store, taskSystem, registry } = await makeGitHubRegistry();
    const { flow, story } = await seedQaPassedGh(store, taskSystem, 'https://github.com/o/r/pull/1');

    // First request review
    await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] },
      qaCtx(),
    );

    // Then submit approved outcome
    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(true);
    expect(out.data?.story.status).toBe('merged');
    expect(out.data?.flow.status).toBe('merged');
    expect(out.data?.flow.current_phase).toBe('done');

    // Verify events were recorded
    const events = await store.listEvents(flow.flow_id);
    expect(events.some((e) => e.type === 'review.requested')).toBe(true);
    expect(events.some((e) => e.type === 'review.outcome.submitted')).toBe(true);
  });

  it('Test B: valid-URL-but-not-a-PR → request_code_review returns ok:false with Invalid PR URL (Fix 1)', async () => {
    const { store, taskSystem, registry } = await makeGitHubRegistry();
    const { story } = await seedQaPassedGh(store, taskSystem, 'https://github.com/o/r');

    // This must NOT throw — it must return {ok:false} with an error message
    const out = (await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] },
      qaCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Invalid PR URL/i);
    // fetch must NOT have been called
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('Test C: changes_requested from qa_passed → story in_progress, flow implementation (Fix 2)', async () => {
    const { store, taskSystem, registry } = await makeGitHubRegistry();
    const { flow, story } = await seedQaPassedGh(store, taskSystem, 'https://github.com/o/r/pull/1', {
      reviewRequested: true,
    });

    // Advance flow to review phase (as request_code_review would do)
    await seedFlowStatus(store, flow.flow_id, { current_phase: 'review', status: 'impl_in_review' });

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'changes_requested', comment: 'please fix X' , review: reviewConHallazgos() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(true);
    expect(out.data?.story.status).toBe('in_progress');
    expect(out.data?.flow.current_phase).toBe('implementation');
  });

  it('un proyecto de integración sin pr_provider seeded no cae al no-op', async () => {
    const { store, taskSystem, registry } = await makeGitHubRegistry();
    // project "otro" no está seeded y no hay default de tenant → NoOp.
    const { story } = await seedQaPassed(store, taskSystem, { project: 'otro', reviewRequested: true });

    // El ctx declara membresía en "otro": lo que se prueba acá es la resolución del
    // pr_provider, no la guarda de workspace. Sin la membresía la tool cortaría antes
    // y el test pasaría a verde por el motivo equivocado.
    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx({ workspaces: ['demo', 'demo2', 'p', 'otro'] }),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/pr_provider/);
  });
});

describe('integration: full review loop', () => {
  it('qa_passed → request_code_review → submit_review_outcome(approved) → merged', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem);

    await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] },
      qaCtx(),
    );
    const finalOut = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'Approved!' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(finalOut.ok).toBe(true);
    expect(finalOut.data?.story.status).toBe('merged');
    expect(finalOut.data?.flow.status).toBe('merged');

    const events = await store.listEvents(flow.flow_id);
    const types = events.map((e) => e.type);
    expect(types).toContain('review.requested');
    expect(types).toContain('review.outcome.submitted');
  });

  it('changes_requested loop: dev fixes → qa_passed again → approved', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem);

    // Request review
    await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] },
      qaCtx(),
    );
    // Reviewer requests changes
    await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'changes_requested', comment: 'fix X please' , review: reviewConHallazgos() },
      reviewerCtx(),
    );
    // Check story is back to in_progress
    const reworked = await store.getStory(story.story_id);
    expect(reworked?.status).toBe('in_progress');

    // Simulate re-QA by manually resetting to qa_passed
    await store.updateStory(story.story_id, { status: 'qa_passed' });
    await seedFlowStatus(store, flow.flow_id, { current_phase: 'review', status: 'impl_in_review' });

    // Y se vuelve a pedir el review. Este paso es nuevo y es el punto del
    // hallazgo B: el `review.requested` de la primera vuelta quedó consumido por
    // el changes_requested, así que no habilita la firma de la segunda. Es el
    // paso que el flujo documentado ya prescribe (qa → request_code_review →
    // submit_review_outcome), no un rodeo.
    const reRequest = (await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] },
      qaCtx(),
    )) as ToolOut;
    expect(reRequest.ok).toBe(true);

    // Final approval
    const approved = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'Now LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;
    expect(approved.ok).toBe(true);
    expect(approved.data?.story.status).toBe('merged');
  });
});

// ===========================================================================
// Reproducción de los ataques que encontró el review adversarial (A, B, D).
//
// Cada test de acá abajo falla contra el código previo al arreglo: son la
// prueba de que el agujero existía, no sólo de que la guarda está escrita.
// ===========================================================================

/** URLs de los APPROVE realmente posteados al proveedor (POST .../reviews). */
function approvesPosted(): string[] {
  return mockFetch.mock.calls
    .filter((c) => ((c as [string, RequestInit])[1]?.method ?? 'GET').toUpperCase() === 'POST')
    .map((c) => (c as [string])[0])
    .filter((u) => u.includes('/reviews'));
}

describe('A — un flow greenfield sin repo declarado no desactiva el gate', () => {
  it('submit_review_outcome no firma un PR de un repo ajeno cuando la story no declara repo', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    // El seed replica un RFC greenfield válido: sin `components` y sin
    // `existing_repo`, que es exactamente lo que `codebase_status: greenfield`
    // permite hoy en la validación del frontmatter.
    const { story } = await seedQaPassed(store, taskSystem, {
      targetRepo: null,
      prUrl: 'https://github.com/mallory/scratch/pull/1',
      reviewRequested: true,
    });
    expect((await store.getStory(story.story_id))?.target_repo).toBeUndefined();

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    // El ataque muere: ni la story avanza ni sale el APPROVE.
    expect(out.ok).toBe(false);
    expect((await store.getStory(story.story_id))?.status).toBe('qa_passed');
    expect(approvesPosted()).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('el rechazo nombra la salida ejecutable para un equipo greenfield', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem, { targetRepo: null, reviewRequested: true });

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no declara ningún repo/i);
    expect(out.error).toMatch(/submit_rfc/);
    expect(out.error).toMatch(/components/);
  });

  it('request_code_review corta la cadena un paso antes y no emite review.requested', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem, {
      targetRepo: null,
      prUrl: 'https://github.com/mallory/scratch/pull/1',
    });

    const out = (await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] },
      qaCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no declara ningún repo/i);
    expect(mockFetch).not.toHaveBeenCalled();
    const events = await store.listEvents(flow.flow_id);
    expect(events.some((e) => e.type === 'review.requested')).toBe(false);
  });

  it('create_stories rechaza derivar el backlog sin repo declarado, cuando submit_rfc todavía es posible', async () => {
    const { store, registry } = await makeRegistry();
    const flow = await store.createFlow({ tenant_id: 't1', project: 'demo', slug: 'gf', title: 'Greenfield' });
    // Estado real de un flow greenfield al terminar el shaping: rfc_ready + epic,
    // sin components. En ese punto submit_rfc sigue abierto (acepta rfc_ready),
    // así que la salida que nombra el error es ejecutable de verdad.
    await seedFlowStatus(store, flow.flow_id, {
      status: 'rfc_ready', current_phase: 'shaping',
      codebase_status: 'greenfield', architecture_mode: 'new', epic_external_id: 'ADO-9',
    });

    const out = (await registry.get('create_stories')!.handler(
      {
        flow_id: flow.flow_id, epic_id: 'ADO-9',
        stories: [{ title: 'User logs in', description: 'x', acceptance_criteria: ['ac'] }],
      },
      ctx({ userId: 'tina', roles: ['tech-lead'] }),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no declara ningún repo/i);
    expect(out.error).toMatch(/submit_rfc/);
    expect(await store.listStoriesByFlow(flow.flow_id)).toEqual([]);
  });
});

describe('B — review.requested no es un token permanente', () => {
  it('cambiar el pr_url después de un changes_requested no deja firmar el PR nuevo', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem, {
      targetRepo: 'https://github.com/acme/checkout',
      prUrl: 'https://github.com/acme/checkout/pull/1',
      assignee: 'dev',
    });

    // 1. Camino legítimo: se pide el review del PR #1.
    const req = (await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] },
      qaCtx(),
    )) as ToolOut;
    expect(req.ok).toBe(true);

    // 2. El reviewer pide cambios → la story vuelve a in_progress.
    const changes = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'changes_requested', comment: 'fix X' , review: reviewConHallazgos() },
      reviewerCtx(),
    )) as ToolOut;
    expect(changes.ok).toBe(true);
    expect((await store.getStory(story.story_id))?.status).toBe('in_progress');

    // 3. El dev registra OTRO PR, que nunca pasó por request_code_review.
    const prog = (await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://github.com/acme/checkout/pull/999' },
      ctx({ userId: 'dev', roles: ['developer'] }),
    )) as ToolOut;
    expect(prog.ok).toBe(true);
    expect((await store.getStory(story.story_id))?.pr_url).toContain('/pull/999');

    // 4. QA vuelve a pasar.
    await store.updateStory(story.story_id, { status: 'qa_passed' });
    mockFetch.mockClear();

    // 5. La firma sobre el PR #999, sin haber pedido su review.
    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/request_code_review/);
    expect(out.error).toMatch(/pull\/999/);
    expect((await store.getStory(story.story_id))?.status).toBe('qa_passed');
    expect(approvesPosted()).toEqual([]);
  });

  it('un review.requested ya consumido por un outcome no vuelve a habilitar la firma', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem, {
      targetRepo: 'https://github.com/acme/checkout',
      prUrl: 'https://github.com/acme/checkout/pull/1',
      assignee: 'dev',
    });

    await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] }, qaCtx(),
    );
    await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'changes_requested', comment: 'fix X' , review: reviewConHallazgos() }, reviewerCtx(),
    );
    // Mismo PR, rework, QA de nuevo — pero sin volver a pedir el review.
    await store.updateStory(story.story_id, { status: 'qa_passed' });
    mockFetch.mockClear();

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/request_code_review/);
    expect(approvesPosted()).toEqual([]);
  });

  it('el camino legítimo (volver a pedir el review) sí firma', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem, {
      targetRepo: 'https://github.com/acme/checkout',
      prUrl: 'https://github.com/acme/checkout/pull/1',
      assignee: 'dev',
    });

    await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] }, qaCtx(),
    );
    await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'changes_requested', comment: 'fix X' , review: reviewConHallazgos() }, reviewerCtx(),
    );
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://github.com/acme/checkout/pull/999' },
      ctx({ userId: 'dev', roles: ['developer'] }),
    );
    await store.updateStory(story.story_id, { status: 'qa_passed' });
    // Se pide el review del PR nuevo, que es lo que el gate exige.
    const req2 = (await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] }, qaCtx(),
    )) as ToolOut;
    expect(req2.ok).toBe(true);

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(true);
    expect(out.data?.story.status).toBe('merged');
  });
});

describe('D — una story abandonada no deja el flow abierto para siempre', () => {
  it('discard_story está registrada y descarta la story de más', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story, siblings } = await seedQaPassed(store, taskSystem, { siblings: 1, reviewRequested: true });

    // La story duplicada por error se descarta.
    const tool = registry.get('discard_story');
    expect(tool).toBeDefined();
    const discarded = (await tool!.handler(
      { story_id: siblings[0]!.story_id, reason: 'duplicada por error en create_stories' },
      ctx({ userId: 'tina', roles: ['tech-lead'] }),
    )) as ToolOut;
    expect(discarded.ok).toBe(true);
    expect(discarded.data?.story.status).toBe('discarded');

    // Y ahora el flow sí puede cerrar al aprobar la story real.
    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(true);
    expect(out.data?.flow.status).toBe('merged');
    expect(out.data?.flow.current_phase).toBe('done');

    const events = await store.listEvents(flow.flow_id);
    expect(events.some((e) => e.type === 'story.discarded')).toBe(true);
  });

  it('sin discard_story el flow no puede cerrar: la story de más lo deja abierto', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem, { siblings: 1, reviewRequested: true });

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(true);
    expect((await store.getFlow(flow.flow_id))?.current_phase).not.toBe('done');
  });

  it('descartar requiere rol tech-lead: si no, el estado terminal sería un bypass del conteo', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { siblings } = await seedQaPassed(store, taskSystem, { siblings: 1 });

    const out = (await registry.get('discard_story')!.handler(
      { story_id: siblings[0]!.story_id, reason: 'no la quiero hacer' },
      ctx({ userId: 'dan', roles: ['developer'] }),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/requiere rol tech-lead/);
    expect(out.error).toMatch(/discard_story/);
    expect((await store.getStory(siblings[0]!.story_id))?.status).toBe('created');
  });

  it('una story ya mergeada no se puede descartar por atrás', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { siblings } = await seedQaPassed(store, taskSystem, { siblings: 1 });
    await store.updateStory(siblings[0]!.story_id, { status: 'merged' });

    const out = (await registry.get('discard_story')!.handler(
      { story_id: siblings[0]!.story_id, reason: 'ups' },
      ctx({ userId: 'tina', roles: ['tech-lead'] }),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/merged/);
  });

  it('una story descartada no cuenta como pendiente para cerrar el flow', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story, siblings } = await seedQaPassed(store, taskSystem, { siblings: 2, reviewRequested: true });
    await store.updateStory(siblings[0]!.story_id, { status: 'merged' });
    await store.updateStory(siblings[1]!.story_id, { status: 'discarded' });

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(true);
    expect(out.data?.flow.current_phase).toBe('done');
    expect((await store.getFlow(flow.flow_id))?.status).toBe('merged');
  });
});

// ---------------------------------------------------------------------------
// F — el descarte también tiene que poder cerrar el flow
//
// El cierre se evaluaba sólo dentro de submit_review_outcome, así que el orden
// natural de trabajo —mergear lo real primero, descartar lo sobrante después—
// dejaba el flow abierto sin ninguna tool capaz de volver a evaluarlo.
// ---------------------------------------------------------------------------

describe('F — discard_story re-evalúa el cierre del flow', () => {
  it('descartar la última pendiente después de mergear la real cierra el flow', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story, siblings } = await seedQaPassed(store, taskSystem, {
      siblings: 1,
      reviewRequested: true,
    });

    // 1. Se mergea la story real. El flow NO cierra: queda la sobrante.
    const merge = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;
    expect(merge.ok).toBe(true);
    expect(merge.data?.flow.current_phase).not.toBe('done');

    // 2. Recién ahí el tech-lead descarta la story creada de más.
    const discarded = (await registry.get('discard_story')!.handler(
      { story_id: siblings[0]!.story_id, reason: 'creada de más en create_stories' },
      ctx({ userId: 'tina', roles: ['tech-lead'] }),
    )) as ToolOut;
    expect(discarded.ok).toBe(true);

    // 3. Ya no queda nada pendiente y hay trabajo entregado: el flow cierra.
    expect(discarded.data?.flow?.status).toBe('merged');
    expect(discarded.data?.flow?.current_phase).toBe('done');
    const persisted = await store.getFlow(flow.flow_id);
    expect(persisted?.status).toBe('merged');
    expect(persisted?.current_phase).toBe('done');
  });

  it('un flow donde se descartan TODAS las stories no cierra como merged', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story, siblings } = await seedQaPassed(store, taskSystem, { siblings: 1 });
    const techLead = ctx({ userId: 'tina', roles: ['tech-lead'] });

    await registry.get('discard_story')!.handler(
      { story_id: siblings[0]!.story_id, reason: 'no va' }, techLead,
    );
    const last = (await registry.get('discard_story')!.handler(
      { story_id: story.story_id, reason: 'tampoco va' }, techLead,
    )) as ToolOut;

    expect(last.ok).toBe(true);
    // No se entregó nada: marcar el flow como merged/done sería mentir en el log.
    const persisted = await store.getFlow(flow.flow_id);
    expect(persisted?.status).not.toBe('merged');
    expect(persisted?.current_phase).not.toBe('done');
    // Y la salida ejecutable está nombrada.
    expect((last as { next_actions?: string[] }).next_actions?.join(' ')).toMatch(/create_stories/);
  });
});

// ---------------------------------------------------------------------------
// G — el review.requested tampoco sobrevive un retroceso vía report_progress
//
// `qa_passed → in_progress` también se alcanza con report_progress, que no emite
// ningún outcome. El PR sigue siendo el mismo, pero su contenido cambió —para eso
// retrocedió la story— y request_code_review nunca volvió a correr.
// ---------------------------------------------------------------------------

describe('G — un retroceso con report_progress consume el review.requested', () => {
  it('volver a in_progress y re-subir el MISMO PR no deja firmar sin re-pedir el review', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem, {
      targetRepo: 'https://github.com/acme/checkout',
      prUrl: 'https://github.com/acme/checkout/pull/1',
      assignee: 'dev',
    });
    const devCtx = ctx({ userId: 'dev', roles: ['developer'] });

    const req = (await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] }, qaCtx(),
    )) as ToolOut;
    expect(req.ok).toBe(true);

    // El dev retrocede la story y vuelve a subir el mismo PR con otro contenido.
    const back = (await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_progress' }, devCtx,
    )) as ToolOut;
    expect(back.ok).toBe(true);
    const again = (await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://github.com/acme/checkout/pull/1' },
      devCtx,
    )) as ToolOut;
    expect(again.ok).toBe(true);

    await store.updateStory(story.story_id, { status: 'qa_passed' });
    mockFetch.mockClear();

    // La firma, sin haber vuelto a llamar request_code_review.
    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/request_code_review/);
    expect((await store.getStory(story.story_id))?.status).toBe('qa_passed');
    expect(approvesPosted()).toEqual([]);
  });

  it('el camino feliz no se rompe: el progress.reported es anterior al review.requested', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem, {
      targetRepo: 'https://github.com/acme/checkout',
      prUrl: 'https://github.com/acme/checkout/pull/1',
      assignee: 'dev',
    });
    const devCtx = ctx({ userId: 'dev', roles: ['developer'] });

    // El dev retrocede, re-sube, QA vuelve a pasar y SE VUELVE A PEDIR el review.
    await registry.get('report_progress')!.handler({ story_id: story.story_id, status: 'in_progress' }, devCtx);
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://github.com/acme/checkout/pull/1' },
      devCtx,
    );
    await store.updateStory(story.story_id, { status: 'qa_passed' });
    const req = (await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] }, qaCtx(),
    )) as ToolOut;
    expect(req.ok).toBe(true);

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(true);
    expect(out.data?.story.status).toBe('merged');
  });
});

describe('E — formas normales de escribir un repo de GitHub', () => {
  // Lo que una persona copia de la barra del navegador o escribe en el RFC.
  const ACEPTADAS: [string, string][] = [
    ['https://github.com/acme/checkout', 'acme/checkout'],
    ['https://github.com/acme/checkout/', 'acme/checkout'],
    ['https://github.com/acme/checkout.git', 'acme/checkout'],
    ['git@github.com:acme/checkout.git', 'acme/checkout'],
    ['acme/checkout', 'acme/checkout'],
    ['github.com/acme/checkout', 'acme/checkout'],
    ['https://github.com/acme/checkout/tree/main', 'acme/checkout'],
    ['https://github.com/acme/checkout/blob/main/README.md', 'acme/checkout'],
    ['https://github.com/acme/checkout?tab=readme', 'acme/checkout'],
    ['https://github.com/acme/checkout#readme', 'acme/checkout'],
    ['https://github.com/acme/checkout/tree/main/pkg/api', 'acme/checkout'],
    ['https://github.com/Acme/Checkout/tree/main', 'acme/checkout'],
    ['https://github.com/acme/checkout.git/tree/main', 'acme/checkout'],
  ];

  it.each(ACEPTADAS)('acepta %s', (raw, esperado) => {
    expect(githubRepoIdentity(raw)).toBe(esperado);
  });

  // El host se compara igual de estricto que antes: aflojarlo sería el bypass.
  const RECHAZADAS = [
    'https://github.com.evil.io/acme/checkout',
    'https://evil.com/acme/checkout',
    'https://gitlab.com/acme/checkout',
    'https://notgithub.com/acme/checkout',
    'checkout',
    '',
    'https://github.com/acme',
    'https://github.com/',
    // Sin host, `owner/repo` es exactamente dos segmentos. Con tres o más no
    // sabemos qué escribió el autor, y truncar a los dos primeros daba un falso
    // verde: el RFC pasaba y el review frenaba semanas después comparando contra
    // "monorepo/services", una identidad que nadie declaró.
    'monorepo/services/checkout',
    'internal-git/acme/checkout',
    'acme/checkout/tree/main',
  ];

  it.each(RECHAZADAS)('rechaza %s', (raw) => {
    expect(githubRepoIdentity(raw)).toBeNull();
  });

  it('con el host explícito el sufijo de path sigue siendo ruido, no un rechazo', () => {
    // La contracara del rechazo de arriba: lo que se endurece es la forma corta.
    expect(githubRepoIdentity('github.com/monorepo/services/checkout')).toBe('monorepo/services');
    expect(githubRepoIdentity('https://github.com/acme/checkout/tree/main')).toBe('acme/checkout');
  });
});

// ---------------------------------------------------------------------------
// El review en dos ejes, a través de la tool
// ---------------------------------------------------------------------------

describe('submit_review_outcome — los dos ejes son un gate, no un adorno', () => {
  const bloqueante = {
    schema: REVIEW_ENVELOPE_SCHEMA,
    standards: { verdict: 'ok' as const, findings: [] },
    spec: {
      verdict: 'blocking' as const,
      findings: [{ file: 'src/pay.ts', line: 42, why: 'El RFC pide 3 reintentos; hace 1.' }],
    },
  };

  it('un approved sobre un eje que bloquea se rechaza, y no toca nada', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem, { reviewRequested: true });
    await seedFlowStatus(store, flow.flow_id, { current_phase: 'review', status: 'impl_in_review' });

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', review: bloqueante },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toContain('No se puede aprobar');
    // La story no se mergeó: la firma no puede decir lo contrario que la evidencia.
    expect((await store.getStory(story.story_id))?.status).toBe('qa_passed');
  });

  it('un envelope incoherente se rechaza antes de hablar con el proveedor de PRs', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem, { reviewRequested: true });
    await seedFlowStatus(store, flow.flow_id, { current_phase: 'review', status: 'impl_in_review' });

    const out = (await registry.get('submit_review_outcome')!.handler(
      {
        story_id: story.story_id,
        outcome: 'approved',
        // "ok" con hallazgos: se contradice solo.
        review: {
          schema: REVIEW_ENVELOPE_SCHEMA,
          standards: { verdict: 'ok', findings: [{ file: 'a.ts', why: 'algo' }] },
          spec: { verdict: 'ok', findings: [] },
        },
      },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(false);
    expect(out.error).toContain('validación');
    // El template va en el error: el agente tiene que poder corregir sin adivinar.
    expect(out.error).toContain('sdlc.review/v1');
    expect((await store.getStory(story.story_id))?.status).toBe('qa_passed');
  });

  it('los dos ejes quedan persistidos en la story y en el evento', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem, { reviewRequested: true });
    await seedFlowStatus(store, flow.flow_id, { current_phase: 'review', status: 'impl_in_review' });

    const conAdvisory = {
      schema: REVIEW_ENVELOPE_SCHEMA,
      standards: {
        verdict: 'advisory' as const,
        findings: [{ file: 'src/pay.ts', why: 'Nombre poco claro para el retry.' }],
      },
      spec: { verdict: 'ok' as const, findings: [] },
    };

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', review: conAdvisory },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(true);

    const guardada = await store.getStory(story.story_id);
    expect(guardada?.review_envelope?.standards.verdict).toBe('advisory');
    expect(guardada?.review_envelope?.standards.findings).toHaveLength(1);
    expect(guardada?.review_envelope?.submitted_at).toBeTruthy();

    // Y en el log, para que un replay recupere qué se miró y no sólo el veredicto.
    const evento = (await store.listEvents(flow.flow_id)).find(
      (e) => e.type === 'review.outcome.submitted',
    );
    expect((evento?.payload as { review?: { spec?: unknown } })?.review?.spec).toBeTruthy();
  });

  it('un advisory no bloquea: los smells son juicios, no violaciones', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem, { reviewRequested: true });
    await seedFlowStatus(store, flow.flow_id, { current_phase: 'review', status: 'impl_in_review' });

    const out = (await registry.get('submit_review_outcome')!.handler(
      {
        story_id: story.story_id,
        outcome: 'approved',
        review: {
          schema: REVIEW_ENVELOPE_SCHEMA,
          standards: {
            verdict: 'advisory',
            findings: [{ file: 'src/pay.ts', why: 'Data clump en los params.' }],
          },
          spec: { verdict: 'advisory', findings: [{ file: 'src/pay.ts', why: 'Nombre del flag.' }] },
        },
      },
      reviewerCtx(),
    )) as ToolOut;

    expect(out.ok).toBe(true);
    expect((await store.getStory(story.story_id))?.status).toBe('merged');
  });
});
