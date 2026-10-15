import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { RoleId } from '@sdlc/core';
import { Catalog } from '@sdlc/catalog';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';
import { ConfigBackedTaskSystemProvider } from '../src/adapters/task-system-provider.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import type { DocStoreProvider } from '../src/adapters/doc-store-provider.js';
import { buildToolRegistry } from '../src/mcp/tools/index.js';
import { makeStartFlowTool } from '../src/mcp/tools/start-flow.js';
import { makeCreateEpicTool } from '../src/mcp/tools/create-epic.js';
import { makeCreateStoriesTool } from '../src/mcp/tools/create-stories.js';
import { makeLinkSubtasksTool } from '../src/mcp/tools/link-subtasks.js';
import { makeSyncBacklogTool } from '../src/mcp/tools/sync-backlog.js';
import { makeClaimStoryTool } from '../src/mcp/tools/claim-story.js';
import { makeReportProgressTool } from '../src/mcp/tools/report-progress.js';
import { makeBlockStoryTool } from '../src/mcp/tools/block-story.js';
import { makeGenerateQaPlanTool } from '../src/mcp/tools/generate-qa-plan.js';
import { makeProposeBreakdownTool } from '../src/mcp/tools/propose-breakdown.js';
import { makeSubmitPrdTool } from '../src/mcp/tools/submit-prd.js';
import { makeSubmitRfcTool } from '../src/mcp/tools/submit-rfc.js';
import { makeSubmitAdrTool } from '../src/mcp/tools/submit-adr.js';
import { makeAbortFlowTool } from '../src/mcp/tools/abort-flow.js';
import { testCtx, type TestCtxOptions } from './helpers/tenant-ctx.js';
import { seedFlowStatus } from './helpers/flow-status.js';

/**
 * Guardas de rol de las tools que mutan estado.
 *
 * La matriz sale del mapa de roles a fases de `packages/catalog/catalog.yaml`
 * (product-manager → prd-*, tech-lead → rfc-*, pmo → shaping, developer → implement,
 * qa → qa, reviewer → review), con `tech-lead` como break-glass donde ya lo usaban las
 * guardas que existían antes (submit_qa_results, request_code_review,
 * submit_review_outcome, discard_story).
 *
 * Cada tool se cubre dos veces: un rol equivocado que se rechaza **antes de cualquier
 * side-effect**, y un rol habilitado que pasa. Sin la mitad del rol habilitado una guarda
 * demasiado estricta pasaría inadvertida; sin la del rol equivocado, la guarda podría no
 * existir.
 *
 * Los ctx se construyen pasando los overrides *por* `testCtx`: las tools evalúan el rol
 * contra `ctx.workspaces[flow.project]`, y ese mapa se deriva de `roles`.
 *
 * **Esta tabla no es el inventario de las guardas de rol del server.** Son las 14 tools que
 * *no* tenían guarda antes de esta tanda; las cuatro que ya la tenían se cubren donde vive
 * el resto de su fixture, porque su seed es mucho más profundo que el de acá (una story en
 * `qa_passed` con `pr_url`, un `pr_provider` real —el no-op se rechaza— y, para el outcome,
 * un `review.requested` que coincida con el `pr_url` actual). Traerlas a la tabla obligaría
 * a deformarla; el mapa de dónde están, para no volver a leer "no está en la tabla" como
 * "no está cubierta":
 *
 *  - `request_code_review`  → review-tools.test.ts, describe('request_code_review'):
 *    'rechaza rol equivocado y nombra la salida', 'acepta tech-lead además de qa',
 *    'evalúa los roles contra el workspace del flow, no contra el tenant'.
 *  - `submit_review_outcome` → review-tools.test.ts, describe('submit_review_outcome'):
 *    'rechaza rol equivocado antes de tocar el proveedor' (+ el camino habilitado en
 *    describe('integration: full review loop')).
 *  - `submit_qa_results`    → implementation-qa.test.ts,
 *    describe('submit_qa_results: gate de evidencia y roles'): 'rechaza al rol equivocado y
 *    nombra quién puede firmar', 'acepta a tech-lead como firmante', 'evalúa los roles
 *    contra el workspace del flow, no contra el tenant'.
 *  - `discard_story`        → review-tools.test.ts, describe('D — una story abandonada no
 *    deja el flow abierto para siempre'): 'descartar requiere rol tech-lead: si no, el
 *    estado terminal sería un bypass del conteo'.
 *
 * Las cuatro se verificaron neutralizando su `assertRole` de a una: cada neutralización
 * hace caer los tests listados y ninguna deja la suite verde. Los rechazos de esos tests
 * asertan contra el texto que produce `assertRole` (`requiere rol X o Y`) y no contra
 * `ok === false`, que es lo que impide que pasen por otra guarda de la cadena.
 */

const CATALOG_ROOT = resolve(__dirname, '../../../packages/catalog');
const PROJECT = 'demo';

const ctxWith = (roles: RoleId[], overrides: Partial<TestCtxOptions> = {}): TenantCtx =>
  testCtx({
    tenantId: 't1',
    userId: 'someone',
    roles,
    workspaces: [PROJECT],
    // Estéril como el resto de los dobles de este archivo: si una tool llegara a
    // resolver un secreto, el mensaje no puede satisfacer ninguna aserción.
    resolveSecret: async () => {
      throw new Error('PROBE_SHOULD_NOT_RESOLVE_SECRET');
    },
    ...overrides,
  });

/**
 * Provider que explota al resolverse.
 *
 * Es lo que convierte "la guarda rechaza" en "la guarda rechaza **antes** del
 * side-effect": varias de estas tools escriben en el sistema externo de tareas o publican
 * en el doc store, y si la guarda corriera después de resolver el provider este objeto
 * tiraría y el test fallaría en vez de pasar.
 *
 * El mensaje es deliberadamente opaco y **sin palabras del dominio** — no lo mejores.
 * Las tools devuelven el error del provider como `{ok:false, error}`, así que un
 * mensaje que dijera "rol" satisfaría por sí solo una aserción `/rol/i` y la tabla
 * pasaría por el motivo equivocado. Estéril, el acoplamiento accidental no existe.
 */
const explodingProvider = {
  resolve() {
    throw new Error('PROBE_SHOULD_NOT_RESOLVE');
  },
} as never;

const catalogStub = {} as never;

async function seedFlow(store: InMemoryFlowStore, patch: Record<string, unknown> = {}) {
  const flow = await store.createFlow({
    tenant_id: 't1',
    project: PROJECT,
    slug: `s-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Flow',
    initiative_type: 'feature',
  });
  if (Object.keys(patch).length > 0) {
    return seedFlowStatus(store, flow.flow_id, { status: flow.status, ...patch } as never);
  }
  return flow;
}

async function seedStory(store: InMemoryFlowStore, flowId: string, patch: Record<string, unknown> = {}) {
  const story = await store.createStory({
    flow_id: flowId,
    external_id: 'WI-1',
    external_url: 'http://x/1',
    title: 'S',
    acceptance_criteria: ['ac1'],
    target_repo: 'https://github.com/acme/app',
  });
  if (Object.keys(patch).length > 0) {
    return store.updateStory(story.story_id, patch as never);
  }
  return story;
}

type Res = { ok: boolean; error?: string };

// ---------------------------------------------------------------------------
// Mitad 1: el rol equivocado se rechaza antes de cualquier side-effect.
//
// Se elige a propósito un rol que existe en el workspace pero no sirve para la tool, no un
// ctx sin roles: lo que se prueba es la separación de funciones, no el fail-closed (que ya
// cubre role-guard.test.ts).
// ---------------------------------------------------------------------------

interface DeniedCase {
  tool: string;
  /** Rol real del actor, habilitado para *otra* fase. */
  wrongRole: RoleId;
  /** Roles que la tool sí acepta; tienen que aparecer en el mensaje. */
  expected: readonly RoleId[];
  run: (store: InMemoryFlowStore, ctx: TenantCtx) => Promise<Res>;
}

const deniedCases: DeniedCase[] = [
  {
    tool: 'start_flow',
    wrongRole: 'developer',
    expected: ['product-manager', 'tech-lead', 'pmo'],
    run: async (store, ctx) =>
      (await makeStartFlowTool(store).handler(
        { project: PROJECT, title: 'Nueva iniciativa', initiative_type: 'feature' },
        ctx,
      )) as Res,
  },
  {
    tool: 'submit_prd',
    wrongRole: 'developer',
    expected: ['product-manager', 'tech-lead'],
    run: async (store, ctx) => {
      const flow = await seedFlow(store);
      return (await makeSubmitPrdTool(store, explodingProvider).handler(
        { flow_id: flow.flow_id, prd_markdown: 'x'.repeat(60) },
        ctx,
      )) as Res;
    },
  },
  {
    tool: 'submit_rfc',
    wrongRole: 'developer',
    expected: ['tech-lead'],
    run: async (store, ctx) => {
      const flow = await seedFlow(store, { status: 'prd_ready' });
      return (await makeSubmitRfcTool(store, explodingProvider).handler(
        { flow_id: flow.flow_id, rfc_markdown: 'x'.repeat(60), repo_path: 'docs/rfc.md' },
        ctx,
      )) as Res;
    },
  },
  {
    tool: 'submit_adr',
    wrongRole: 'developer',
    expected: ['tech-lead'],
    run: async (store, ctx) => {
      const flow = await seedFlow(store);
      return (await makeSubmitAdrTool(store, explodingProvider).handler(
        { flow_id: flow.flow_id, title: 'ADR', adr_markdown: 'x'.repeat(60) },
        ctx,
      )) as Res;
    },
  },
  {
    tool: 'propose_breakdown',
    wrongRole: 'developer',
    expected: ['pmo', 'tech-lead'],
    run: async (store, ctx) => {
      const flow = await seedFlow(store, { status: 'rfc_ready' });
      return (await makeProposeBreakdownTool(store, catalogStub).handler(
        { flow_id: flow.flow_id, rfc_markdown: 'x' },
        ctx,
      )) as Res;
    },
  },
  {
    tool: 'create_epic',
    wrongRole: 'developer',
    expected: ['pmo', 'tech-lead'],
    run: async (store, ctx) => {
      const flow = await seedFlow(store, { status: 'rfc_ready' });
      return (await makeCreateEpicTool(store, explodingProvider).handler(
        { flow_id: flow.flow_id, epic: { title: 'E', description: 'd' } },
        ctx,
      )) as Res;
    },
  },
  {
    tool: 'create_stories',
    wrongRole: 'developer',
    expected: ['pmo', 'tech-lead'],
    run: async (store, ctx) => {
      const flow = await seedFlow(store, { status: 'rfc_ready', epic_external_id: 'E-1' });
      return (await makeCreateStoriesTool(store, explodingProvider).handler(
        { flow_id: flow.flow_id, epic_id: 'E-1', stories: [{ title: 'S', description: 'd', acceptance_criteria: ['a'] }] },
        ctx,
      )) as Res;
    },
  },
  {
    tool: 'link_subtasks',
    wrongRole: 'developer',
    expected: ['pmo', 'tech-lead'],
    run: async (store, ctx) => {
      const flow = await seedFlow(store, { status: 'rfc_ready', epic_external_id: 'E-1' });
      return (await makeLinkSubtasksTool(store, explodingProvider).handler(
        { flow_id: flow.flow_id, story_id: 'WI-1', subtasks: [{ title: 'T' }] },
        ctx,
      )) as Res;
    },
  },
  {
    tool: 'sync_backlog',
    wrongRole: 'developer',
    expected: ['pmo', 'tech-lead'],
    run: async (store, ctx) => {
      const flow = await seedFlow(store, { status: 'rfc_ready', epic_external_id: 'E-1' });
      return (await makeSyncBacklogTool(store).handler({ flow_id: flow.flow_id }, ctx)) as Res;
    },
  },
  {
    tool: 'claim_story',
    // El pmo dueñea el backlog pero no implementa: es el rol que más plausiblemente
    // intentaría autoasignarse trabajo.
    wrongRole: 'pmo',
    expected: ['developer'],
    run: async (store, ctx) => {
      const flow = await seedFlow(store, { status: 'backlog_ready' });
      const story = await seedStory(store, flow.flow_id);
      return (await makeClaimStoryTool(store, explodingProvider, catalogStub).handler(
        { story_id: story.story_id, developer_id: ctx.userId },
        ctx,
      )) as Res;
    },
  },
  {
    tool: 'report_progress',
    wrongRole: 'pmo',
    expected: ['developer'],
    run: async (store, ctx) => {
      const flow = await seedFlow(store, { status: 'backlog_ready' });
      // La story ya está asignada al propio actor: sin la guarda de rol, el chequeo de
      // identidad de abajo lo dejaría pasar. Es justo el punto — atar no es autorizar.
      const story = await seedStory(store, flow.flow_id, { status: 'claimed', assignee: ctx.userId });
      return (await makeReportProgressTool(store, explodingProvider).handler(
        { story_id: story.story_id, status: 'in_progress' },
        ctx,
      )) as Res;
    },
  },
  {
    tool: 'generate_qa_plan',
    wrongRole: 'developer',
    expected: ['qa', 'tech-lead'],
    run: async (store, ctx) => {
      const flow = await seedFlow(store, { status: 'impl_in_review' });
      const story = await seedStory(store, flow.flow_id, { status: 'in_review', assignee: 'otro' });
      return (await makeGenerateQaPlanTool(store).handler({ story_id: story.story_id }, ctx)) as Res;
    },
  },
  {
    tool: 'block_story',
    wrongRole: 'developer',
    expected: ['qa', 'reviewer', 'tech-lead'],
    run: async (store, ctx) => {
      const flow = await seedFlow(store, { status: 'impl_in_review' });
      const story = await seedStory(store, flow.flow_id, { status: 'in_review', assignee: 'otro' });
      return (await makeBlockStoryTool(store, explodingProvider).handler(
        { story_id: story.story_id, reason: 'smoke falla' },
        ctx,
      )) as Res;
    },
  },
  {
    tool: 'abort_flow',
    wrongRole: 'developer',
    expected: ['tech-lead', 'pmo'],
    run: async (store, ctx) => {
      const flow = await seedFlow(store, { status: 'rfc_ready' });
      return (await makeAbortFlowTool(store).handler(
        { flow_id: flow.flow_id, reason: 'despriorizada' },
        ctx,
      )) as Res;
    },
  },
];

describe('guardas de rol: el rol equivocado se rechaza antes de cualquier side-effect', () => {
  for (const c of deniedCases) {
    it(`${c.tool} rechaza a un ${c.wrongRole} y nombra los roles que sirven`, async () => {
      const store = new InMemoryFlowStore();
      const res = await c.run(store, ctxWith([c.wrongRole]));

      expect(res.ok).toBe(false);
      // El mensaje tiene que nombrar la tool, el rol que falta y el rol propio.
      expect(res.error).toContain(c.tool);
      for (const role of c.expected) expect(res.error).toContain(role);
      expect(res.error).toContain(c.wrongRole);
    });

    it(`${c.tool} le dice al rechazado cómo salir (whoami)`, async () => {
      const store = new InMemoryFlowStore();
      const res = await c.run(store, ctxWith([c.wrongRole]));

      expect(res.ok).toBe(false);
      // Cada rechazo por rol nombra la salida ejecutable: `whoami` para ver los propios
      // roles. Sin esto el agente que recibe el error no sabe qué hacer con él.
      expect(res.error).toContain('whoami');
    });
  }

  // Cierra la tabla contra un olvido: una tool nueva en `deniedCases` sin su par en la
  // lista (o al revés) rompe acá. No afirma que el server tenga 14 guardas de rol —son 18;
  // las otras cuatro ya existían y se cubren donde dice el comentario de arriba.
  it('cubre las 14 tools que mutan estado y ahora piden rol', () => {
    expect(deniedCases.map((c) => c.tool).sort()).toEqual(
      [
        'abort_flow',
        'block_story',
        'claim_story',
        'create_epic',
        'create_stories',
        'generate_qa_plan',
        'link_subtasks',
        'propose_breakdown',
        'report_progress',
        'start_flow',
        'submit_adr',
        'submit_prd',
        'submit_rfc',
        'sync_backlog',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Mitad 2: el rol habilitado pasa.
//
// Se conduce un flow real de punta a punta con el ctx correcto en cada paso, que además es
// la prueba de que la matriz es transitable: si dos tools consecutivas pidieran roles
// incompatibles, el flujo entero se cortaría acá.
// ---------------------------------------------------------------------------

const PRD = `# PRD\n\n## Problem\nx problem here long enough to pass\n\n## Users\n- u\n\n## Success Metrics\n| m | b | t | p |\n\n## Scope\n- s\n\n## Out of Scope\n- o\n\n## Risks\n| r | p | i | m |`;

// Mismo fixture que shaping.test.ts: con `codebase_status: existing` el validador exige
// además las secciones de contexto de arquitectura.
const RFC = `---
architecture_mode: reuse
codebase_status: existing
existing_repo: https://github.com/acme/checkout
---

# RFC: Pago en cuotas

## Context
ctx

## Architecture context
### Architecture mode
reuse
### Existing components reused
- checkout
### Codebase context
mono
### Integration points
- evento

## Goals
- Pagos en cuotas.

## Non-goals
- nada

## Design
ddd
ddd
ddd

## Risks
| r | t | p | i | m |
| a | b | M | H | x |
| a | b | M | H | x |
| a | b | M | H | x |

## Rollout
- canary

## Rollback
1. flag off
`;

/** Doc store real (no el no-op), que es lo que `submit_adr` exige. */
const realDocStore: DocStoreProvider = {
  resolve: async () => ({
    publish: async () => ({ id: 'doc-1', url: 'https://docs.example.com/d/doc-1', gdoc_id: 'gd-1' }),
  }),
} as never;

async function driver() {
  const catalog = await Catalog.load(CATALOG_ROOT);
  const store = new InMemoryFlowStore();
  const taskSystem = new InMemoryTaskSystemAdapter();
  const taskSystemProvider = new ConfigBackedTaskSystemProvider({
    configStore: new InMemoryIntegrationConfigStore(),
    inMemory: taskSystem,
  });
  const registry = buildToolRegistry({
    catalog,
    store,
    taskSystemProvider,
    docStoreProvider: realDocStore,
  });
  const call = async <T>(name: string, input: unknown, ctx: TenantCtx) => {
    const tool = registry.get(name);
    if (!tool) throw new Error(`Unknown tool ${name}`);
    const parsed = tool.inputSchema.parse(input ?? {});
    const res = (await tool.handler(parsed, ctx)) as { ok: boolean; data?: T; error?: string };
    return res;
  };

  /**
   * Story sembrada en el store **y** registrada en el sistema de tareas.
   *
   * Las tools que mueven una story (claim_story, report_progress, block_story) llaman
   * `taskSystem.transition(story.external_id, ...)`, y el adapter in-memory tira si el
   * work item no existe. Sembrar sólo en el store dejaba tests que fallaban por el
   * fixture y no por la guarda.
   */
  const seedStoryWithWorkItem = async (flowId: string, patch: Record<string, unknown> = {}) => {
    const ref = await taskSystem.createStory(
      { project_key: PROJECT, epic_id: 'E-1', title: 'S', description: 'd', acceptance_criteria: ['ac1'] },
      pmoCtx,
    );
    const story = await store.createStory({
      flow_id: flowId,
      external_id: ref.external_id,
      external_url: ref.url,
      title: 'S',
      acceptance_criteria: ['ac1'],
      target_repo: 'https://github.com/acme/app',
    });
    if (Object.keys(patch).length > 0) return store.updateStory(story.story_id, patch as never);
    return story;
  };

  return { store, call, taskSystem, seedStoryWithWorkItem };
}

const pmCtx = ctxWith(['product-manager'], { userId: 'pam' });
const leadCtx = ctxWith(['tech-lead'], { userId: 'lee' });
const pmoCtx = ctxWith(['pmo'], { userId: 'pat' });
const devCtx = ctxWith(['developer'], { userId: 'alice' });
const qaCtx = ctxWith(['qa'], { userId: 'quinn' });
const reviewerCtx = ctxWith(['reviewer'], { userId: 'rita' });

describe('guardas de rol: el rol habilitado pasa (flow conducido de punta a punta)', () => {
  it('cada fase la conduce su rol del catálogo, sin break-glass', async () => {
    const { call } = await driver();

    // start_flow → product-manager
    const start = await call<{ flow_id: string }>(
      'start_flow',
      { project: PROJECT, title: 'Pago en cuotas', initiative_type: 'feature' },
      pmCtx,
    );
    expect(start.ok, start.error).toBe(true);
    const flow_id = start.data!.flow_id;

    // submit_prd → product-manager
    const prd = await call('submit_prd', { flow_id, prd_markdown: PRD }, pmCtx);
    expect(prd.ok, prd.error).toBe(true);

    // submit_rfc → tech-lead (y sólo tech-lead: es lo que ata el repo declarado)
    const rfc = await call('submit_rfc', { flow_id, rfc_markdown: RFC, repo_path: 'docs/rfc.md' }, leadCtx);
    expect(rfc.ok, rfc.error).toBe(true);

    // submit_adr → tech-lead
    const adr = await call('submit_adr', { flow_id, title: 'Usar Postgres', adr_markdown: 'x'.repeat(60) }, leadCtx);
    expect(adr.ok, adr.error).toBe(true);

    // shaping → pmo
    const proposed = await call('propose_breakdown', { flow_id, rfc_markdown: RFC }, pmoCtx);
    expect(proposed.ok, proposed.error).toBe(true);

    const epic = await call<{ epic_ref: { external_id: string } }>(
      'create_epic',
      { flow_id, epic: { title: 'Cuotas', description: 'd' } },
      pmoCtx,
    );
    expect(epic.ok, epic.error).toBe(true);
    const epic_id = epic.data!.epic_ref.external_id;

    const stories = await call<{ story_refs: { external_id: string }[] }>(
      'create_stories',
      { flow_id, epic_id, stories: [{ title: 'S1', description: 'd', acceptance_criteria: ['ac1'] }] },
      pmoCtx,
    );
    expect(stories.ok, stories.error).toBe(true);

    const subs = await call(
      'link_subtasks',
      { flow_id, story_id: stories.data!.story_refs[0]!.external_id, subtasks: [{ title: 'T1' }] },
      pmoCtx,
    );
    expect(subs.ok, subs.error).toBe(true);

    const synced = await call('sync_backlog', { flow_id }, pmoCtx);
    expect(synced.ok, synced.error).toBe(true);
  });

  it('claim_story y report_progress los conduce el developer', async () => {
    const { store, call, seedStoryWithWorkItem } = await driver();
    const flow = await seedFlow(store, { status: 'backlog_ready', current_phase: 'implementation' });
    const story = await seedStoryWithWorkItem(flow.flow_id);

    const claimed = await call('claim_story', { story_id: story.story_id, developer_id: 'alice' }, devCtx);
    expect(claimed.ok, claimed.error).toBe(true);

    const progress = await call('report_progress', { story_id: story.story_id, status: 'in_progress' }, devCtx);
    expect(progress.ok, progress.error).toBe(true);

    const review = await call(
      'report_progress',
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://github.com/acme/app/pull/1' },
      devCtx,
    );
    expect(review.ok, review.error).toBe(true);
  });

  it('generate_qa_plan lo conduce qa, y también el tech-lead (break-glass)', async () => {
    for (const ctx of [qaCtx, leadCtx]) {
      const { store, call } = await driver();
      const flow = await seedFlow(store, { status: 'impl_in_review' });
      const story = await seedStory(store, flow.flow_id, { status: 'in_review', assignee: 'alice' });

      const res = await call('generate_qa_plan', { story_id: story.story_id }, ctx);
      expect(res.ok, `${ctx.roles?.join(',')}: ${res.error}`).toBe(true);
    }
  });

  it('block_story lo conducen qa, reviewer y tech-lead', async () => {
    for (const ctx of [qaCtx, reviewerCtx, leadCtx]) {
      const { store, call, seedStoryWithWorkItem } = await driver();
      const flow = await seedFlow(store, { status: 'impl_in_review' });
      const story = await seedStoryWithWorkItem(flow.flow_id, { status: 'in_review', assignee: 'alice' });

      const res = await call('block_story', { story_id: story.story_id, reason: 'smoke falla' }, ctx);
      expect(res.ok, `${ctx.roles?.join(',')}: ${res.error}`).toBe(true);
    }
  });

  it('las tools de shaping también las puede conducir el tech-lead (break-glass)', async () => {
    const { store, call } = await driver();
    const flow = await seedFlow(store, { status: 'rfc_ready' });

    const epic = await call('create_epic', { flow_id: flow.flow_id, epic: { title: 'E', description: 'd' } }, leadCtx);
    expect(epic.ok, epic.error).toBe(true);
  });

  it('start_flow lo puede abrir el pmo además del product-manager', async () => {
    const { call } = await driver();
    const res = await call('start_flow', { project: PROJECT, title: 'Iniciativa del pmo', initiative_type: 'feature' }, pmoCtx);
    expect(res.ok, res.error).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Separación de funciones en block_story.
// ---------------------------------------------------------------------------

describe('block_story: separación de funciones', () => {
  it('el assignee no puede bloquear su propia story aunque tenga rol qa', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, { status: 'impl_in_review' });
    const story = await seedStory(store, flow.flow_id, { status: 'in_review', assignee: 'alice' });

    // alice tiene el rol qa en el workspace: pasa la guarda de rol y cae en la de
    // separación de funciones. Es el caso que importa — el rol solo no alcanza.
    const alice = ctxWith(['qa'], { userId: 'alice' });
    const tool = makeBlockStoryTool(store, explodingProvider);
    const res = (await tool.handler({ story_id: story.story_id, reason: 'me falla a mí' }, alice)) as Res;

    expect(res.ok).toBe(false);
    expect(res.error).toContain('alice');
    expect(res.error).toContain(story.story_id);
    // La story no se movió: la guarda corre antes del side-effect (si el task system se
    // hubiera resuelto, explodingProvider tiraba).
    expect((await store.getStory(story.story_id))!.status).toBe('in_review');
  });

  it('otra persona con rol qa sí la puede bloquear', async () => {
    const { store, call, seedStoryWithWorkItem } = await driver();
    const flow = await seedFlow(store, { status: 'impl_in_review' });
    const story = await seedStoryWithWorkItem(flow.flow_id, { status: 'in_review', assignee: 'alice' });

    const res = await call('block_story', { story_id: story.story_id, reason: 'smoke falla' }, qaCtx);
    expect(res.ok, res.error).toBe(true);
    expect((await store.getStory(story.story_id))!.status).toBe('blocked');
  });

  it('una story sin assignee no se bloquea por separación de funciones', async () => {
    const { store, call, seedStoryWithWorkItem } = await driver();
    const flow = await seedFlow(store, { status: 'impl_in_review' });
    const story = await seedStoryWithWorkItem(flow.flow_id, { status: 'in_review' });

    const res = await call('block_story', { story_id: story.story_id, reason: 'smoke falla' }, qaCtx);
    expect(res.ok, res.error).toBe(true);
  });

  it('reason vacío se rechaza nombrando la salida ejecutable', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, { status: 'impl_in_review' });
    const story = await seedStory(store, flow.flow_id, { status: 'in_review', assignee: 'alice' });

    const tool = makeBlockStoryTool(store, explodingProvider);
    const res = (await tool.handler({ story_id: story.story_id, reason: '   ' }, qaCtx)) as Res;

    expect(res.ok).toBe(false);
    expect(res.error).toContain('block_story');
    expect(res.error).toContain('reason');
  });
});
