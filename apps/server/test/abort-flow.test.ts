import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStatus, RoleId } from '@sdlc/core';
import { Catalog } from '@sdlc/catalog';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';
import { ConfigBackedTaskSystemProvider } from '../src/adapters/task-system-provider.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import { buildToolRegistry } from '../src/mcp/tools/index.js';
import {
  makeAbortFlowTool,
  assertFlowNotAborted,
  updateFlowUnlessAborted,
} from '../src/mcp/tools/abort-flow.js';
import { makeSubmitPrdTool } from '../src/mcp/tools/submit-prd.js';
import { makeSubmitChangeNoteTool } from '../src/mcp/tools/submit-change-note.js';
import { makeSubmitRfcTool } from '../src/mcp/tools/submit-rfc.js';
import { makeSubmitAdrTool } from '../src/mcp/tools/submit-adr.js';
import { makeCreateStoriesTool } from '../src/mcp/tools/create-stories.js';
import { makeLinkSubtasksTool } from '../src/mcp/tools/link-subtasks.js';
import { makeSyncBacklogTool } from '../src/mcp/tools/sync-backlog.js';
import { makeClaimStoryTool } from '../src/mcp/tools/claim-story.js';
import { makeReportProgressTool } from '../src/mcp/tools/report-progress.js';
import { makeGenerateQaPlanTool } from '../src/mcp/tools/generate-qa-plan.js';
import { makeBlockStoryTool } from '../src/mcp/tools/block-story.js';
import { makeCreateEpicTool } from '../src/mcp/tools/create-epic.js';
import { makeProposeBreakdownTool } from '../src/mcp/tools/propose-breakdown.js';
import { makeSubmitQaResultsTool } from '../src/mcp/tools/submit-qa-results.js';
import { makeRequestCodeReviewTool } from '../src/mcp/tools/request-code-review.js';
import { makeSubmitReviewOutcomeTool } from '../src/mcp/tools/submit-review-outcome.js';
import { makeDiscardStoryTool } from '../src/mcp/tools/discard-story.js';
import { makeRequestApprovalTool } from '../src/mcp/tools/request-approval.js';
import { approvalPolicyFrom } from '../src/approvals/policy.js';
import { testCtx, type TestCtxOptions } from './helpers/tenant-ctx.js';
import { seedFlowStatus } from './helpers/flow-status.js';
import { reviewOk } from './helpers/review-envelope.js';

/**
 * `abort_flow` y el estado terminal `aborted`.
 *
 * `FlowStatus.aborted` vivía en el enum desde el principio y ninguna de las tools lo
 * seteaba, así que un flow abandonado no tenía salida. Este archivo cubre las dos mitades
 * del arreglo: la tool que produce el estado (con sus bordes) y el hecho de que el resto
 * del flujo lo respete — que es lo que evita que `aborted` sea un estado de mentira.
 */

const PROJECT = 'demo';
const CATALOG_ROOT = resolve(__dirname, '../../../packages/catalog');

const ctxWith = (roles: RoleId[], overrides: Partial<TestCtxOptions> = {}): TenantCtx =>
  testCtx({
    tenantId: 't1',
    userId: 'lee',
    roles,
    workspaces: [PROJECT],
    // Estéril como el resto de los dobles de este archivo: si una tool llegara a
    // resolver un secreto, el mensaje no puede satisfacer ninguna aserción.
    resolveSecret: async () => {
      throw new Error('PROBE_SHOULD_NOT_RESOLVE_SECRET');
    },
    ...overrides,
  });

const leadCtx = ctxWith(['tech-lead']);
const pmoCtx = ctxWith(['pmo'], { userId: 'pat' });

/**
 * Explota si se resuelve: prueba que la guarda corre antes del side-effect.
 *
 * El mensaje es deliberadamente opaco y **no tiene ni una palabra del vocabulario
 * del dominio** — no dice "aborted", ni "guarda", ni "terminal". No lo mejores.
 *
 * Varias tools envuelven `provider.resolve()` en un try/catch y devuelven el error
 * del proveedor como `{ok:false, error}`, así que cualquier palabra del dominio en
 * este mensaje puede satisfacer por sí sola la aserción de la tabla y hacerla pasar
 * por el motivo equivocado: la tool falló por el doble, no por la guarda. Ya pasó
 * —un mensaje con "aborted" adentro dejaba la tabla verde con la guarda de
 * `request_code_review` neutralizada a mano— y el arreglo no puede depender de que
 * cada aserción futura sea lo bastante específica. Con el mensaje estéril, el
 * acoplamiento accidental deja de ser posible.
 */
const explodingProvider = {
  resolve() {
    throw new Error('PROBE_SHOULD_NOT_RESOLVE');
  },
} as never;
const catalogStub = {} as never;

type Res<T = unknown> = { ok: boolean; data?: T; error?: string };

async function seedFlow(store: InMemoryFlowStore, patch: Record<string, unknown> = {}) {
  const flow = await store.createFlow({
    tenant_id: 't1',
    project: PROJECT,
    slug: `s-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Iniciativa',
    initiative_type: 'feature',
  });
  if (Object.keys(patch).length > 0) {
    // `status` ya no entra por `updateFlow`: el seed lo pone con la escritura
    // condicional, sin precondición (ver `helpers/flow-status.ts`).
    return seedFlowStatus(store, flow.flow_id, { status: flow.status, ...patch } as never);
  }
  return flow;
}

async function seedStory(store: InMemoryFlowStore, flowId: string, patch: Record<string, unknown> = {}) {
  const story = await store.createStory({
    flow_id: flowId,
    external_id: `WI-${Math.random().toString(36).slice(2, 8)}`,
    external_url: 'http://x/1',
    title: 'S',
    acceptance_criteria: ['ac1'],
    target_repo: 'https://github.com/acme/app',
  });
  if (Object.keys(patch).length > 0) return store.updateStory(story.story_id, patch as never);
  return story;
}

// ---------------------------------------------------------------------------
// La tool
// ---------------------------------------------------------------------------

describe('abort_flow', () => {
  it('lleva el flow a aborted y emite flow.aborted con el motivo', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, { status: 'rfc_ready', current_phase: 'shaping' });

    const res = (await makeAbortFlowTool(store).handler(
      { flow_id: flow.flow_id, reason: 'la iniciativa se despriorizó para el Q3' },
      leadCtx,
    )) as Res;

    expect(res.ok, res.error).toBe(true);
    expect((await store.getFlow(flow.flow_id))!.status).toBe('aborted');

    const events = await store.listEvents(flow.flow_id);
    const aborted = events.find((e) => e.type === 'flow.aborted');
    expect(aborted).toBeDefined();
    expect(aborted!.actor).toBe('lee');
    expect(aborted!.payload.reason).toBe('la iniciativa se despriorizó para el Q3');
    expect(aborted!.payload.previous_status).toBe('rfc_ready');
  });

  it('deja current_phase en la fase donde el flow se abandonó', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, { status: 'rfc_ready', current_phase: 'shaping' });

    await makeAbortFlowTool(store).handler({ flow_id: flow.flow_id, reason: 'x' }, leadCtx);

    // El status es el terminal; la fase es el dato de auditoría que dice hasta dónde
    // llegó. Mandarla a `done` afirmaría que se completó.
    const after = (await store.getFlow(flow.flow_id))!;
    expect(after.status).toBe('aborted');
    expect(after.current_phase).toBe('shaping');
  });

  it('lo puede abortar el pmo además del tech-lead', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, { status: 'prd_ready' });

    const res = (await makeAbortFlowTool(store).handler(
      { flow_id: flow.flow_id, reason: 'el epic se replantea de cero' },
      pmoCtx,
    )) as Res;

    expect(res.ok, res.error).toBe(true);
  });

  it('rechaza reason vacío sin tocar el flow', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, { status: 'rfc_ready' });

    const res = (await makeAbortFlowTool(store).handler(
      { flow_id: flow.flow_id, reason: '   ' },
      leadCtx,
    )) as Res;

    expect(res.ok).toBe(false);
    expect(res.error).toContain('abort_flow');
    expect(res.error).toContain('reason');
    expect((await store.getFlow(flow.flow_id))!.status).toBe('rfc_ready');
  });

  it('BORDE: un flow merged no se aborta — el trabajo se integró', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, { status: 'merged', current_phase: 'done' });

    const res = (await makeAbortFlowTool(store).handler(
      { flow_id: flow.flow_id, reason: 'me arrepentí' },
      leadCtx,
    )) as Res;

    expect(res.ok).toBe(false);
    expect(res.error).toContain('merged');
    expect(res.error).toContain('start_flow');
    // El flow queda intacto y no se emite el evento.
    expect((await store.getFlow(flow.flow_id))!.status).toBe('merged');
    expect((await store.listEvents(flow.flow_id)).some((e) => e.type === 'flow.aborted')).toBe(false);
  });

  it('BORDE: un flow ya aborted no se re-aborta (el segundo motivo no se guardaría)', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, { status: 'rfc_ready' });
    const tool = makeAbortFlowTool(store);

    const first = (await tool.handler({ flow_id: flow.flow_id, reason: 'motivo original' }, leadCtx)) as Res;
    expect(first.ok, first.error).toBe(true);

    const second = (await tool.handler({ flow_id: flow.flow_id, reason: 'otro motivo' }, leadCtx)) as Res;
    expect(second.ok).toBe(false);
    expect(second.error).toContain('ya está aborted');

    // Sigue habiendo un solo evento, con el motivo original.
    const eventos = (await store.listEvents(flow.flow_id)).filter((e) => e.type === 'flow.aborted');
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.payload.reason).toBe('motivo original');
  });

  it('BORDE: las stories en vuelo no bloquean el abort, pero quedan contadas en el evento', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, { status: 'impl_in_review', current_phase: 'implementation' });
    const enVuelo = await seedStory(store, flow.flow_id, { status: 'in_review', assignee: 'alice' });
    const yaMergeada = await seedStory(store, flow.flow_id, { status: 'merged' });
    const descartada = await seedStory(store, flow.flow_id, { status: 'discarded' });

    const res = (await makeAbortFlowTool(store).handler(
      { flow_id: flow.flow_id, reason: 'el resto no se hace' },
      leadCtx,
    )) as Res<{ abandoned_story_count: number; abandoned_story_ids: string[] }>;

    expect(res.ok, res.error).toBe(true);
    // Sólo la viva cuenta como abandonada: la merged se entregó y la discarded ya estaba
    // fuera del conteo.
    expect(res.data!.abandoned_story_count).toBe(1);
    expect(res.data!.abandoned_story_ids).toEqual([enVuelo.story_id]);

    const evento = (await store.listEvents(flow.flow_id)).find((e) => e.type === 'flow.aborted')!;
    expect(evento.payload.abandoned_story_count).toBe(1);
    expect(evento.payload.merged_story_count).toBe(1);

    // Las stories no se tocan: el flow abortado es lo que las saca de circulación.
    expect((await store.getStory(enVuelo.story_id))!.status).toBe('in_review');
    expect((await store.getStory(yaMergeada.story_id))!.status).toBe('merged');
    expect((await store.getStory(descartada.story_id))!.status).toBe('discarded');
  });

  it('BORDE: se puede abortar un flow recién creado, todavía en draft', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store);
    expect(flow.status).toBe('draft');

    const res = (await makeAbortFlowTool(store).handler(
      { flow_id: flow.flow_id, reason: 'el PRD resultó inviable' },
      leadCtx,
    )) as Res;

    expect(res.ok, res.error).toBe(true);
  });

  it('está registrada en el registry', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const registry = buildToolRegistry({
      catalog,
      store: new InMemoryFlowStore(),
      taskSystemProvider: new ConfigBackedTaskSystemProvider({
        configStore: new InMemoryIntegrationConfigStore(),
        inMemory: new InMemoryTaskSystemAdapter(),
      }),
    });
    expect(registry.get('abort_flow')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// El estado terminal lo respeta el resto del flujo.
//
// Sin esto `aborted` sería decorativo: `submit_prd` y `sync_backlog` no miraban el status y
// lo pisaban con `prd_ready` / `backlog_ready`, o sea que resucitar un flow abortado costaba
// una llamada.
//
// La primera vuelta de la guarda dejó afuera la mitad de QA/review —`submit_qa_results`,
// `request_code_review`, `submit_review_outcome`— y `discard_story`, y con eso la promesa
// volvía a ser falsa: un reviewer adversarial llevó un flow aborted hasta merged/done
// encadenando esas tres. La tabla de abajo las incluye; la cadena completa está en
// `aborted-flow-writes.test.ts`, junto al censo de escrituras de `flow.status`.
// ---------------------------------------------------------------------------

interface TerminalCase {
  tool: string;
  /** Status que hace falta en el flow *además* de aborted para llegar a la guarda. */
  run: (store: InMemoryFlowStore) => Promise<Res>;
}

const terminalCases: TerminalCase[] = [
  {
    tool: 'request_approval',
    run: async (store) => {
      const flow = await seedFlow(store, { status: 'aborted', prd_ref: { sha256: 'a'.repeat(64) } });
      return (await makeRequestApprovalTool(store, approvalPolicyFrom(['*'])).handler(
        { flow_id: flow.flow_id, artifact: 'prd' },
        ctxWith(['developer']),
      )) as Res;
    },
  },
  {
    tool: 'submit_prd',
    run: async (store) => {
      const flow = await seedFlow(store, { status: 'aborted' });
      return (await makeSubmitPrdTool(store, explodingProvider).handler(
        { flow_id: flow.flow_id, prd_markdown: 'x'.repeat(60) },
        ctxWith(['product-manager']),
      )) as Res;
    },
  },
  {
    tool: 'submit_change_note',
    run: async (store) => {
      // El flow queda `feature` (el default del seed) a propósito: la guarda de
      // terminal corre antes que la de track, así que un aborted tiene que
      // rechazarse por abortado y no por el track. Si algún día se invirtiera el
      // orden, este caso lo caza.
      const flow = await seedFlow(store, { status: 'aborted' });
      return (await makeSubmitChangeNoteTool(store, explodingProvider, explodingProvider).handler(
        {
          flow_id: flow.flow_id,
          change_note_markdown: 'x'.repeat(60),
          stories: [{ title: 't', description: 'd', acceptance_criteria: ['ac'] }],
        },
        ctxWith(['developer']),
      )) as Res;
    },
  },
  {
    tool: 'submit_rfc',
    run: async (store) => {
      const flow = await seedFlow(store, { status: 'aborted' });
      return (await makeSubmitRfcTool(store, explodingProvider).handler(
        { flow_id: flow.flow_id, rfc_markdown: 'x'.repeat(60), repo_path: 'docs/rfc.md' },
        leadCtx,
      )) as Res;
    },
  },
  {
    tool: 'submit_adr',
    run: async (store) => {
      const flow = await seedFlow(store, { status: 'aborted' });
      return (await makeSubmitAdrTool(store, explodingProvider).handler(
        { flow_id: flow.flow_id, title: 'ADR', adr_markdown: 'x'.repeat(60) },
        leadCtx,
      )) as Res;
    },
  },
  {
    tool: 'propose_breakdown',
    run: async (store) => {
      const flow = await seedFlow(store, { status: 'aborted' });
      return (await makeProposeBreakdownTool(store, catalogStub).handler(
        { flow_id: flow.flow_id, rfc_markdown: 'x' },
        pmoCtx,
      )) as Res;
    },
  },
  {
    tool: 'create_epic',
    run: async (store) => {
      const flow = await seedFlow(store, { status: 'aborted' });
      return (await makeCreateEpicTool(store, explodingProvider).handler(
        { flow_id: flow.flow_id, epic: { title: 'E', description: 'd' } },
        pmoCtx,
      )) as Res;
    },
  },
  {
    tool: 'create_stories',
    run: async (store) => {
      const flow = await seedFlow(store, { status: 'aborted', epic_external_id: 'E-1' });
      return (await makeCreateStoriesTool(store, explodingProvider).handler(
        { flow_id: flow.flow_id, epic_id: 'E-1', stories: [{ title: 'S', description: 'd', acceptance_criteria: ['a'] }] },
        pmoCtx,
      )) as Res;
    },
  },
  {
    tool: 'link_subtasks',
    run: async (store) => {
      const flow = await seedFlow(store, { status: 'aborted', epic_external_id: 'E-1' });
      return (await makeLinkSubtasksTool(store, explodingProvider).handler(
        { flow_id: flow.flow_id, story_id: 'WI-1', subtasks: [{ title: 'T' }] },
        pmoCtx,
      )) as Res;
    },
  },
  {
    tool: 'sync_backlog',
    run: async (store) => {
      const flow = await seedFlow(store, { status: 'aborted', epic_external_id: 'E-1' });
      return (await makeSyncBacklogTool(store).handler({ flow_id: flow.flow_id }, pmoCtx)) as Res;
    },
  },
  {
    tool: 'claim_story',
    run: async (store) => {
      const flow = await seedFlow(store, { status: 'aborted' });
      const story = await seedStory(store, flow.flow_id);
      return (await makeClaimStoryTool(store, explodingProvider, catalogStub).handler(
        { story_id: story.story_id, developer_id: 'alice' },
        ctxWith(['developer'], { userId: 'alice' }),
      )) as Res;
    },
  },
  {
    tool: 'report_progress',
    run: async (store) => {
      const flow = await seedFlow(store, { status: 'aborted' });
      const story = await seedStory(store, flow.flow_id, { status: 'claimed', assignee: 'alice' });
      return (await makeReportProgressTool(store, explodingProvider).handler(
        { story_id: story.story_id, status: 'in_progress' },
        ctxWith(['developer'], { userId: 'alice' }),
      )) as Res;
    },
  },
  {
    tool: 'generate_qa_plan',
    run: async (store) => {
      const flow = await seedFlow(store, { status: 'aborted' });
      const story = await seedStory(store, flow.flow_id, { status: 'in_review', assignee: 'alice' });
      return (await makeGenerateQaPlanTool(store).handler(
        { story_id: story.story_id },
        ctxWith(['qa'], { userId: 'quinn' }),
      )) as Res;
    },
  },
  {
    tool: 'block_story',
    run: async (store) => {
      const flow = await seedFlow(store, { status: 'aborted' });
      const story = await seedStory(store, flow.flow_id, { status: 'in_review', assignee: 'alice' });
      return (await makeBlockStoryTool(store, explodingProvider).handler(
        { story_id: story.story_id, reason: 'x' },
        ctxWith(['qa'], { userId: 'quinn' }),
      )) as Res;
    },
  },
  // Las tres mitades del review/QA que NO tenían la guarda: con ellas alcanzaba
  // para llevar un flow aborted hasta merged/done. Ver `aborted-flow-writes.test.ts`
  // para la cadena completa; acá se prueba cada una contra la guarda.
  {
    tool: 'submit_qa_results',
    run: async (store) => {
      const flow = await seedFlow(store, { status: 'aborted' });
      const story = await seedStory(store, flow.flow_id, { status: 'in_review', assignee: 'alice' });
      return (await makeSubmitQaResultsTool(store, explodingProvider).handler(
        { story_id: story.story_id, results: [], verdict: 'passed' },
        ctxWith(['qa'], { userId: 'quinn' }),
      )) as Res;
    },
  },
  {
    tool: 'request_code_review',
    run: async (store) => {
      const flow = await seedFlow(store, { status: 'aborted' });
      const story = await seedStory(store, flow.flow_id, {
        status: 'qa_passed',
        assignee: 'alice',
        pr_url: 'https://github.com/acme/app/pull/1',
      });
      return (await makeRequestCodeReviewTool(store, explodingProvider).handler(
        { story_id: story.story_id, reviewer_ids: ['bob'] },
        ctxWith(['qa'], { userId: 'quinn' }),
      )) as Res;
    },
  },
  {
    tool: 'submit_review_outcome',
    run: async (store) => {
      const flow = await seedFlow(store, { status: 'aborted' });
      const story = await seedStory(store, flow.flow_id, {
        status: 'qa_passed',
        assignee: 'alice',
        pr_url: 'https://github.com/acme/app/pull/1',
      });
      return (await makeSubmitReviewOutcomeTool(store, explodingProvider).handler(
        { story_id: story.story_id, outcome: 'approved' , review: reviewOk() },
        ctxWith(['reviewer'], { userId: 'bob' }),
      )) as Res;
    },
  },
  {
    tool: 'discard_story',
    run: async (store) => {
      const flow = await seedFlow(store, { status: 'aborted' });
      const story = await seedStory(store, flow.flow_id, { status: 'created' });
      return (await makeDiscardStoryTool(store, explodingProvider).handler(
        { story_id: story.story_id, reason: 'ya no se hace' },
        leadCtx,
      )) as Res;
    },
  },
];

/**
 * Tools que **no** escriben nada: leen catálogo, validan un markdown o devuelven
 * estado. No tienen por qué rechazar un flow aborted —consultar en qué quedó una
 * iniciativa abandonada es exactamente lo que hay que poder hacer— así que están
 * fuera de la tabla a propósito y con nombre y apellido.
 */
const SOLO_LECTURA = [
  'whoami',
  'list_roles',
  'get_role_prompt',
  'get_flow_state',
  'get_implementation_context',
  'generate_rfc_skeleton',
  'validate_prd',
  'validate_rfc',
  'verify_artifact',
];

/**
 * Los dos exentos, y por qué:
 *  - `abort_flow` es el productor del terminal y el dueño del chokepoint.
 *  - `start_flow` crea un flow nuevo, no escribe sobre uno existente — es justamente
 *    la salida que nombran todos los mensajes de la guarda.
 */
const EXENTAS = ['abort_flow', 'start_flow'];

describe('la tabla del terminal cubre todas las tools de escritura', () => {
  it('cada tool del registry está en la tabla, en solo-lectura, o exenta', async () => {
    // Esto es lo que hace que la tabla valga para las tools que se agreguen, y
    // reemplaza al `source.includes('assertFlowNotAborted(')` que había antes: ese
    // predicado se satisfacía con la guarda llamada y el retorno ignorado, con la
    // guarda nombrada en un comentario o dentro de un string, y con un
    // `flow.status === 'merged'` que no excluye `aborted`. Una tool nueva que
    // escriba sin guarda ahora no tiene dónde esconderse: o aparece en la tabla —y
    // el caso corre de verdad contra un flow aborted— o hay que declararla de
    // lectura, que es una afirmación que se lee y se discute en el review.
    const catalog = await Catalog.load(CATALOG_ROOT);
    const registry = buildToolRegistry({
      catalog,
      store: new InMemoryFlowStore(),
      taskSystemProvider: new ConfigBackedTaskSystemProvider({
        configStore: new InMemoryIntegrationConfigStore(),
        inMemory: new InMemoryTaskSystemAdapter(),
      }),
    });

    const registradas = registry.list().map((t) => t.name).sort();
    const cubiertas = [...terminalCases.map((c) => c.tool), ...SOLO_LECTURA, ...EXENTAS].sort();

    expect(registradas).toEqual(cubiertas);
  });

  it('la tabla no declara tools que no existen', () => {
    // El otro lado: una entrada podrida (tool renombrada, typo) haría que el caso
    // nunca corriera y la cobertura fuera falsa.
    expect(new Set(terminalCases.map((c) => c.tool)).size).toBe(terminalCases.length);
  });
});

describe('un flow aborted no acepta escrituras (y no se resucita)', () => {
  for (const c of terminalCases) {
    it(`${c.tool} rechaza el flow aborted antes de cualquier side-effect`, async () => {
      const store = new InMemoryFlowStore();
      const res = await c.run(store);

      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/aborted/i);
    });
  }

  it('el flow sigue aborted después de que todas lo rechacen', async () => {
    // El caso concreto que motivó la guarda: sync_backlog movía un flow aborted a
    // backlog_ready sin mirar el status.
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, { status: 'aborted', epic_external_id: 'E-1' });
    await seedStory(store, flow.flow_id);

    await makeSyncBacklogTool(store).handler({ flow_id: flow.flow_id }, pmoCtx);
    await makeSubmitPrdTool(store, explodingProvider).handler(
      { flow_id: flow.flow_id, prd_markdown: 'x'.repeat(60) },
      ctxWith(['product-manager']),
    );

    expect((await store.getFlow(flow.flow_id))!.status).toBe('aborted');
  });

  it('el mensaje nombra la única salida: un flow nuevo con start_flow', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, { status: 'aborted' });

    const res = (await makeSubmitPrdTool(store, explodingProvider).handler(
      { flow_id: flow.flow_id, prd_markdown: 'x'.repeat(60) },
      ctxWith(['product-manager']),
    )) as Res;

    expect(res.error).toContain('start_flow');
  });
});

describe('updateFlowUnlessAborted (el chokepoint de flow.status)', () => {
  it('escribe el patch cuando el flow está vivo', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, { status: 'backlog_ready', current_phase: 'implementation' });

    const res = await updateFlowUnlessAborted(
      store,
      flow,
      { status: 'impl_in_review', current_phase: 'review' },
      'request_code_review',
    );

    expect(res.ok).toBe(true);
    expect(res.ok && res.flow.status).toBe('impl_in_review');
    expect((await store.getFlow(flow.flow_id))!.current_phase).toBe('review');
  });

  it('rechaza y no escribe nada sobre un flow aborted', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, { status: 'aborted', current_phase: 'implementation' });

    const res = await updateFlowUnlessAborted(
      store,
      flow,
      { status: 'merged', current_phase: 'done' },
      'closeFlowIfSettled',
    );

    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/aborted/i);
    const after = (await store.getFlow(flow.flow_id))!;
    expect(after.status).toBe('aborted');
    expect(after.current_phase).toBe('implementation');
  });

  it('ignora el snapshot del caller: un abort que aterrizó antes de la escritura igual frena', async () => {
    // La ventana real: el handler leyó el flow al principio, corrieron sus
    // side-effects (proveedor de PR, task system, doc store) y recién ahí escribe.
    // Un `abort_flow` en el medio dejaba ese `flow` stale y la guarda temprana ya
    // había pasado. El chokepoint decide sobre el status del momento en que escribe,
    // no sobre el del principio del handler. La carrera de las dos operaciones
    // concurrentes —que la re-lectura no cerraba— está en `flow-status-race.test.ts`.
    const store = new InMemoryFlowStore();
    const stale = await seedFlow(store, { status: 'backlog_ready', current_phase: 'implementation' });
    expect(stale.status).toBe('backlog_ready');

    await makeAbortFlowTool(store).handler(
      { flow_id: stale.flow_id, reason: 'se abandonó mientras corría el otro handler' },
      leadCtx,
    );

    const res = await updateFlowUnlessAborted(
      store,
      stale, // el snapshot viejo, que todavía dice backlog_ready
      { status: 'impl_in_review', current_phase: 'review' },
      'request_code_review',
    );

    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/aborted/i);
    expect((await store.getFlow(stale.flow_id))!.status).toBe('aborted');
  });
});

describe('assertFlowNotAborted', () => {
  const flowConStatus = (status: FlowStatus) =>
    ({ flow_id: 'f-1', status, project: PROJECT, current_phase: 'rfc' }) as never;

  it('deja pasar cualquier status que no sea aborted', () => {
    const statuses: FlowStatus[] = [
      'draft',
      'prd_ready',
      'rfc_ready',
      'backlog_ready',
      'impl_in_review',
      'qa_passed',
      'merged',
    ];
    for (const s of statuses) {
      expect(assertFlowNotAborted(flowConStatus(s), 'x')).toBeNull();
    }
  });

  it('bloquea aborted y nombra la tool y la salida', () => {
    const err = assertFlowNotAborted(flowConStatus('aborted'), 'submit_prd');
    expect(err).toBeTypeOf('string');
    expect(err).toContain('submit_prd');
    expect(err).toContain('aborted');
    expect(err).toContain('start_flow');
  });
});
