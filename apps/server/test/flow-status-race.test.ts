import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Flow, FlowEvent, FlowStatus, Story } from '@sdlc/core';
import type { PullRequestAdapter, TenantCtx } from '@sdlc/adapters-contracts';
import { Catalog } from '@sdlc/catalog';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';
import { ConfigBackedTaskSystemProvider } from '../src/adapters/task-system-provider.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import type { PullRequestProvider } from '../src/adapters/pull-request-provider.js';
import type {
  AppendEventInput,
  CreateFlowInput,
  CreateStoryInput,
  FlowStatusTransition,
  FlowStatusWriteResult,
  FlowStore,
  UpdateFlowInput,
  UpdateStoryInput,
} from '../src/state/index.js';
import { buildToolRegistry } from '../src/mcp/tools/index.js';
import { updateFlowUnlessAborted } from '../src/mcp/tools/abort-flow.js';
import { testCtx, type TestCtxOptions } from './helpers/tenant-ctx.js';
import { seedFlowStatus } from './helpers/flow-status.js';
import { reviewOk } from './helpers/review-envelope.js';

/**
 * La carrera del chokepoint: dos requests concurrentes sobre el mismo flow.
 *
 * Es el hallazgo de la tercera pasada del reviewer. `updateFlowUnlessAborted` había
 * cerrado la ventana grande —la fase entera de side-effects— re-leyendo el flow
 * antes de escribir, pero la re-lectura **no es una escritura condicional**:
 *
 *     const current = await store.getFlow(id);   // ← lee
 *     if (current.status === 'aborted') return;  //   decide
 *     return store.updateFlow(id, patch);        // ← escribe, sobre un status que
 *                                                //   pudo cambiar en el medio
 *
 * Entre el `await` de la lectura y el de la escritura hay un punto de suspensión, y
 * el `abort_flow` de al lado tiene la misma forma. Gana el último que escribe, en
 * las dos direcciones:
 *
 *  - **A.** El abort se pisa y el flow resucita: el chokepoint devuelve `ok:true` y
 *    el flow termina en el status que el chokepoint escribió, aunque el abort ya lo
 *    había dejado en `aborted`.
 *  - **B.** `submit_review_outcome(approved)` cierra el flow en `merged/done` y el
 *    `abort_flow` concurrente lo pisa con `aborted`, dejándolo **a la vez abandonado
 *    y terminado** (`status: aborted` + `current_phase: done` + story `merged`) y
 *    escribiendo sobre un flow `merged`, que es justo lo que su guarda existe para
 *    impedir. Los dos devuelven `ok:true`.
 *
 * No hace falta concurrencia exótica: las dos operaciones son `async`, así que dos
 * requests MCP en el mismo proceso Node alcanzan. `LatentFlowStore` no espía nada
 * —es un `FlowStore` que delega en el de memoria— y sólo agrega la latencia que
 * cualquier store real tiene: Postgres hace ida y vuelta en cada operación. Es lo
 * que abre la ventana de forma reproducible en vez de depender del scheduler.
 *
 * El arreglo es que la invariante se evalúe **en el mismo statement que escribe**:
 * `store.updateFlowStatus(id, transition, blockedFrom)` (`UPDATE ... WHERE status
 * NOT IN (...)`, y su equivalente sincrónico en memoria). Los tests de abajo barren
 * todos los desfasajes de arranque, así que no dependen de acertar un timing: si
 * *alguna* intercalación rompe la invariante, el barrido la encuentra.
 */

const PROJECT = 'demo';
const REPO = 'https://github.com/owner/repo';
const PR_URL = 'https://github.com/owner/repo/pull/99';
const CATALOG_ROOT = resolve(__dirname, '../../../packages/catalog');

/** Un turno del event loop. `setImmediate` es FIFO, así que las intercalaciones son deterministas. */
const tick = () => new Promise<void>((r) => setImmediate(r));
async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}

/** Cuántos turnos del event loop cuesta cada operación del store. */
const LATENCIA: Record<string, number> = {
  getFlow: 1,
  updateFlow: 2,
  updateFlowStatus: 2,
  listStoriesByFlow: 1,
  getStory: 1,
  updateStory: 2,
  appendEvent: 1,
  listEvents: 1,
  createFlow: 1,
  createStory: 1,
  listFlows: 1,
};

/**
 * `FlowStore` con latencia: delega todo en el store de memoria, pero cada operación
 * cuesta unos turnos del event loop antes de tocar los datos.
 *
 * No es un espía ni un mock: no intercepta decisiones ni cambia resultados. Lo único
 * que hace es dejar de ser instantáneo, que es la única diferencia relevante entre el
 * store de memoria y Postgres — y la que decide si la carrera existe o no. Sin esto,
 * las intercalaciones dependen de cuántos `await` haya de casualidad en cada camino.
 */
class LatentFlowStore implements FlowStore {
  constructor(private readonly inner: FlowStore) {}

  private async latencia(op: string): Promise<void> {
    await ticks(LATENCIA[op] ?? 1);
  }

  async createFlow(input: CreateFlowInput): Promise<Flow> {
    await this.latencia('createFlow');
    return this.inner.createFlow(input);
  }
  async getFlow(flowId: string): Promise<Flow | undefined> {
    await this.latencia('getFlow');
    return this.inner.getFlow(flowId);
  }
  async updateFlow(flowId: string, patch: UpdateFlowInput): Promise<Flow> {
    await this.latencia('updateFlow');
    return this.inner.updateFlow(flowId, patch);
  }
  async updateFlowStatus(
    flowId: string,
    transition: FlowStatusTransition,
    blockedFrom: readonly FlowStatus[],
  ): Promise<FlowStatusWriteResult> {
    await this.latencia('updateFlowStatus');
    return this.inner.updateFlowStatus(flowId, transition, blockedFrom);
  }
  async listFlows(tenantId: string, project?: string): Promise<Flow[]> {
    await this.latencia('listFlows');
    return this.inner.listFlows(tenantId, project);
  }
  async appendEvent(input: AppendEventInput): Promise<FlowEvent> {
    await this.latencia('appendEvent');
    return this.inner.appendEvent(input);
  }
  async listEvents(flowId: string): Promise<FlowEvent[]> {
    await this.latencia('listEvents');
    return this.inner.listEvents(flowId);
  }
  async createStory(input: CreateStoryInput): Promise<Story> {
    await this.latencia('createStory');
    return this.inner.createStory(input);
  }
  async getStory(storyId: string): Promise<Story | undefined> {
    await this.latencia('getStory');
    return this.inner.getStory(storyId);
  }
  async listStoriesByFlow(flowId: string): Promise<Story[]> {
    await this.latencia('listStoriesByFlow');
    return this.inner.listStoriesByFlow(flowId);
  }
  async updateStory(storyId: string, patch: UpdateStoryInput): Promise<Story> {
    await this.latencia('updateStory');
    return this.inner.updateStory(storyId, patch);
  }
}

// Los overrides entran *por* `testCtx`: los roles se evalúan contra
// `ctx.workspaces[flow.project]`, así que pisarlos con un spread encima del ctx ya
// construido dejaría el mapa del claim derivado de los roles anteriores.
const ctx = (overrides: Partial<TestCtxOptions> = {}): TenantCtx =>
  testCtx({
    tenantId: 't1',
    userId: 'alice',
    roles: ['developer'],
    workspaces: [PROJECT],
    resolveSecret: async () => 'dummy-token',
    ...overrides,
  });

const devCtx = ctx();
const qaCtx = ctx({ userId: 'quinn', roles: ['qa'] });
const leadCtx = ctx({ userId: 'lee', roles: ['tech-lead'] });
const reviewerCtx = ctx({ userId: 'bob', roles: ['reviewer'] });

type Res<T = unknown> = { ok: boolean; error?: string; data?: T };

/** PR real, abierto, del repo de la story. Sin red y sin latencia: no es lo que se prueba acá. */
function fakePrAdapter(): PullRequestAdapter {
  return {
    kind: 'github',
    parsePrUrl: (url: string) => {
      const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i.exec(url);
      if (!m) throw new Error(`fakePrAdapter: cannot parse PR URL: ${url}`);
      return { url, pr_id: m[3]!, _parsed: { owner: m[1]!, repo: m[2]!, number: m[3]! } };
    },
    requestReview: async () => {},
    submitOutcome: async () => {},
    getPullRequest: async (ref) => ({
      pr_id: ref.pr_id,
      url: ref.url,
      title: 'PR',
      status: 'open',
      created_by: 'alice',
    }),
  };
}

async function makeHarness() {
  const catalog = await Catalog.load(CATALOG_ROOT);
  const inner = new InMemoryFlowStore();
  const store = new LatentFlowStore(inner);
  const taskSystem = new InMemoryTaskSystemAdapter();
  const pullRequestProvider: PullRequestProvider = { resolve: async () => fakePrAdapter() };
  const registry = buildToolRegistry({
    catalog,
    store,
    taskSystemProvider: new ConfigBackedTaskSystemProvider({
      configStore: new InMemoryIntegrationConfigStore(),
      inMemory: taskSystem,
    }),
    pullRequestProvider,
  });
  return { store, registry };
}

/** Flow vivo en implementación, con una story lista para que la firme el reviewer. */
async function seedListoParaFirmar() {
  const { store, registry } = await makeHarness();
  const flow = await store.createFlow({
    tenant_id: 't1',
    project: PROJECT,
    slug: `login-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Login feature',
  });
  await seedFlowStatus(store, flow.flow_id, {
    status: 'backlog_ready',
    current_phase: 'implementation',
    epic_external_id: 'ADO-1',
    architecture_mode: 'new',
    codebase_status: 'existing',
    existing_repo: REPO,
  });
  const story = await store.createStory({
    flow_id: flow.flow_id,
    external_id: 'WI-1',
    external_url: 'http://x/1',
    title: 'User logs in',
    acceptance_criteria: ['email/password works', 'failure shows error'],
    target_repo: REPO,
  });
  await store.updateStory(story.story_id, {
    status: 'qa_passed',
    assignee: 'alice',
    pr_url: PR_URL,
  });
  // El review se pide por el camino legítimo: el gate de `submit_review_outcome` es
  // el evento `review.requested`, no la fase del flow.
  const req = (await registry.get('request_code_review')!.handler(
    { story_id: story.story_id, reviewer_ids: ['bob'] },
    qaCtx,
  )) as Res;
  expect(req.ok, req.error).toBe(true);
  return { store, registry, flow, story };
}

// ---------------------------------------------------------------------------
// Dirección A: el abort no se pisa
// ---------------------------------------------------------------------------

describe('carrera del chokepoint: el abort no se pisa (dirección A)', () => {
  // Barrido de desfasajes: cuántos turnos de ventaja le damos al `abort_flow`
  // antes de arrancar el chokepoint. Cubre el caso donde el abort escribe justo
  // entre la lectura y la escritura del chokepoint, que es el único que rompía.
  const DESFASAJES = [0, 1, 2, 3, 4, 5, 6, 7];

  it('ninguna intercalación deja el flow fuera de aborted si el abort dijo ok', async () => {
    const resultados: { desfasaje: number; abortOk: boolean; chokepointOk: boolean }[] = [];

    for (const desfasaje of DESFASAJES) {
      const { store, registry, flow } = await seedListoParaFirmar();
      const snapshot = (await store.getFlow(flow.flow_id))!;
      expect(snapshot.status).toBe('impl_in_review');

      // Las dos operaciones arrancan sin esperarse: es lo que pasa con dos
      // requests MCP concurrentes sobre el mismo flow.
      const abortP = registry.get('abort_flow')!.handler(
        { flow_id: flow.flow_id, reason: 'la iniciativa se despriorizó' },
        leadCtx,
      ) as Promise<Res>;
      await ticks(desfasaje);
      const chokeP = updateFlowUnlessAborted(
        store,
        snapshot,
        { status: 'merged', current_phase: 'done' },
        'closeFlowIfSettled',
      );
      const [abort, choke] = await Promise.all([abortP, chokeP]);

      const final = (await store.getFlow(flow.flow_id))!;
      resultados.push({ desfasaje, abortOk: abort.ok, chokepointOk: choke.ok });

      // La invariante: si el abort escribió, nadie lo pisa. Ni el chokepoint ni nadie.
      if (abort.ok) {
        expect(final.status, `desfasaje ${desfasaje}: el abort se pisó`).toBe('aborted');
        expect(choke.ok, `desfasaje ${desfasaje}: el chokepoint escribió sobre un flow aborted`).toBe(
          false,
        );
      } else {
        // El otro orden: el chokepoint llegó primero y cerró el flow, así que el
        // abort se rechaza — no se aborta un flow ya merged.
        expect(choke.ok, `desfasaje ${desfasaje}`).toBe(true);
        expect(final.status, `desfasaje ${desfasaje}`).toBe('merged');
      }
      // Y en ningún orden queda el estado imposible: abandonado y terminado a la vez.
      expect(final.status === 'aborted' && final.current_phase === 'done').toBe(false);
    }

    // El barrido tiene que haber explorado la ventana de verdad: si todas las
    // corridas dieran el mismo orden, el test pasaría sin probar nada.
    const ordenes = new Set(resultados.map((r) => `${r.abortOk}/${r.chokepointOk}`));
    expect(ordenes.size, `el barrido no intercaló: ${JSON.stringify(resultados)}`).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Dirección B: dos requests reales en paralelo
// ---------------------------------------------------------------------------

describe('carrera del chokepoint: submit_review_outcome || abort_flow (dirección B)', () => {
  const DESFASAJES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it('el flow nunca queda abandonado y terminado a la vez, y el abort no pisa un merged', async () => {
    const resultados: { desfasaje: number; abortOk: boolean; outcomeOk: boolean; final: string }[] =
      [];

    for (const desfasaje of DESFASAJES) {
      const { store, registry, flow, story } = await seedListoParaFirmar();

      // Dos requests MCP concurrentes, los dos por su handler real: el reviewer
      // firma el approve (que mergea la story y cierra el flow, porque es la única)
      // mientras el tech-lead abandona la iniciativa.
      const outcomeP = registry.get('submit_review_outcome')!.handler(
        { story_id: story.story_id, outcome: 'approved' , review: reviewOk() },
        reviewerCtx,
      ) as Promise<Res>;
      await ticks(desfasaje);
      const abortP = registry.get('abort_flow')!.handler(
        { flow_id: flow.flow_id, reason: 'la iniciativa se despriorizó' },
        leadCtx,
      ) as Promise<Res>;
      const [outcome, abort] = await Promise.all([outcomeP, abortP]);

      const final = (await store.getFlow(flow.flow_id))!;
      const eventos = await store.listEvents(flow.flow_id);
      resultados.push({
        desfasaje,
        abortOk: abort.ok,
        outcomeOk: outcome.ok,
        final: `${final.status}/${final.current_phase}`,
      });
      const donde = `desfasaje ${desfasaje} (final ${final.status}/${final.current_phase})`;

      // 1) El estado imposible: `aborted` con la fase en `done` es un flow
      //    simultáneamente abandonado y terminado.
      expect(final.status === 'aborted' && final.current_phase === 'done', donde).toBe(false);

      // 2) Los dos sentidos de "una sola de las dos escrituras de status se aplicó".
      if (abort.ok) {
        expect(final.status, donde).toBe('aborted');
        expect(final.current_phase, donde).not.toBe('done');
      } else {
        // El abort se rechazó porque el flow ya estaba merged: su guarda de `merged`
        // vale también contra la escritura concurrente, no sólo contra la secuencial.
        expect(final.status, donde).toBe('merged');
        expect(final.current_phase, donde).toBe('done');
        expect(abort.error, donde).toContain('merged');
        expect(abort.error, donde).toContain('start_flow');
        // Y no se emitió el evento de un abandono que no ocurrió.
        expect(eventos.some((e) => e.type === 'flow.aborted'), donde).toBe(false);
      }

      // 3) El approve no falla por la carrera: la story se mergeó igual (el PR se
      //    firmó de verdad), lo único que puede no aplicarse es el cierre del flow.
      expect(outcome.ok, `${donde}: ${outcome.error}`).toBe(true);
      expect((await store.getStory(story.story_id))!.status, donde).toBe('merged');
    }

    const ordenes = new Set(resultados.map((r) => r.final));
    expect(ordenes.size, `el barrido no intercaló: ${JSON.stringify(resultados)}`).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// La escritura condicional, sola
// ---------------------------------------------------------------------------

describe('updateFlowStatus: escritura condicional', () => {
  it('aplica cuando el status no está bloqueado', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({
      tenant_id: 't1',
      project: PROJECT,
      slug: 'a',
      title: 'T',
    });

    const res = await store.updateFlowStatus(
      flow.flow_id,
      { status: 'prd_ready', current_phase: 'rfc' },
      ['aborted'],
    );

    expect(res.applied).toBe(true);
    expect(res.applied && res.flow.status).toBe('prd_ready');
    expect((await store.getFlow(flow.flow_id))!.current_phase).toBe('rfc');
  });

  it('no aplica —ni el status ni el resto del patch— cuando el status está bloqueado', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({
      tenant_id: 't1',
      project: PROJECT,
      slug: 'b',
      title: 'T',
    });
    await seedFlowStatus(store, flow.flow_id, { status: 'aborted', current_phase: 'implementation' });

    const res = await store.updateFlowStatus(
      flow.flow_id,
      { status: 'merged', current_phase: 'done' },
      ['aborted'],
    );

    expect(res.applied).toBe(false);
    // Devuelve el estado real, para que el caller pueda decir por qué no escribió
    // sin volver a leer (una re-lectura sería otra carrera).
    expect(!res.applied && res.flow?.status).toBe('aborted');
    const after = (await store.getFlow(flow.flow_id))!;
    expect(after.status).toBe('aborted');
    expect(after.current_phase).toBe('implementation');
  });

  it('un flow inexistente es un "no escribí", no una excepción', async () => {
    const store = new InMemoryFlowStore();

    const res = await store.updateFlowStatus('t1:demo:no-existe', { status: 'merged' }, ['aborted']);

    expect(res.applied).toBe(false);
    expect(!res.applied && res.flow).toBeUndefined();
  });

  it('el chokepoint nunca devuelve ok:true sin haber escrito', async () => {
    // El "no escribí" no puede ser indistinguible de un éxito: el flow desapareció,
    // así que no hay nada que afirmar y sale ok:false nombrando la salida.
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({
      tenant_id: 't1',
      project: PROJECT,
      slug: 'c',
      title: 'T',
    });
    const snapshot = (await store.getFlow(flow.flow_id))!;
    const vacio = new InMemoryFlowStore(); // el mismo flow_id no existe acá

    const res = await updateFlowUnlessAborted(
      vacio,
      snapshot,
      { status: 'merged', current_phase: 'done' },
      'closeFlowIfSettled',
    );

    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain('get_flow_state');
  });
});
