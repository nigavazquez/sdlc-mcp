import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { Catalog } from '@sdlc/catalog';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { PostgresFlowStore } from '../src/state/postgres.js';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';
import { ConfigBackedTaskSystemProvider } from '../src/adapters/task-system-provider.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import {
  ConfigBackedPullRequestProvider,
  NoOpPullRequestAdapter,
} from '../src/adapters/pull-request-provider.js';
import { buildToolRegistry } from '../src/mcp/tools/index.js';
import { testCtx, type TestCtxOptions } from './helpers/tenant-ctx.js';
import { seedFlowStatus } from './helpers/flow-status.js';
import { reviewOk, reviewConHallazgos } from './helpers/review-envelope.js';

/**
 * Un flow `aborted` no se resucita — la cadena completa, no tool por tool.
 *
 * `abort-flow.test.ts` cubre cada tool contra la guarda por separado. Este archivo
 * cubre lo que el reviewer adversarial encontró y que ninguna prueba unitaria veía:
 * la mitad del flujo que **no** tenía la guarda (`submit_qa_results`,
 * `request_code_review`, `submit_review_outcome`) alcanzaba para llevar un flow
 * abortado hasta `merged/done`, y una vez resucitado las diez tools que sí tenían
 * la guarda volvían a pasar. La cadena exacta que reprodujo:
 *
 *     abort_flow          ok  -> aborted
 *     submit_qa_results   ok  -> story qa_passed
 *     request_code_review ok  -> flow impl_in_review   (acá resucita)
 *     submit_review_outcome ok -> flow merged / done
 *
 * Además del recorrido, acá vive el **censo de escrituras** de `flow.status`, que es
 * lo que hace verdadera la promesa de la description de `abort_flow` en vez de
 * mantenerla por inventario: alcanza una escritura incondicional en cualquier tool
 * para que la guarda vuelva a ser decorativa.
 *
 * Qué cubre el censo, exactamente:
 *
 *  - Que `updateFlow` **no escriba `status`**, con el patch armado de cualquier forma
 *    (literal, variable, `buildPatch()`, spread, clave computada, `Object.assign`,
 *    ternario, cast, método destructurado). Es una prueba de **comportamiento** sobre
 *    las dos implementaciones del store, no un escaneo de texto.
 *  - Que el único identificador que mueve el status —`updateFlowStatus`— aparezca
 *    sólo en la capa de store y en el chokepoint, escaneando `src/` recursivo.
 *
 * Qué **no** cubre, y dónde está: que cada tool de escritura rechace el flow aborted
 * *antes* de sus side-effects. Eso es una tabla de comportamiento y vive en
 * `abort-flow.test.ts`, junto al chequeo de que la tabla esté completa contra el
 * registry. La versión anterior de este archivo lo intentaba con un `source.includes`
 * y era teatro: pasaba con la guarda llamada y el retorno ignorado, con la guarda
 * mencionada en un comentario, y con un `flow.status === 'merged'` que no excluye
 * `aborted`.
 */

const PROJECT = 'demo';
const PR_URL = 'https://github.com/owner/repo/pull/99';
const REPO = 'https://github.com/owner/repo';
const CATALOG_ROOT = resolve(__dirname, '../../../packages/catalog');
const SRC_DIR = resolve(__dirname, '../src');

// Los overrides entran *por* `testCtx` y no spreadeados encima del ctx ya
// construido: las tools evalúan el rol contra `ctx.workspaces[flow.project]`, así
// que un override de `roles` tiene que rederivar el mapa del claim.
const ctx = (overrides: Partial<TestCtxOptions> = {}): TenantCtx =>
  testCtx({
    tenantId: 't1',
    userId: 'alice',
    roles: ['developer'],
    workspaces: [PROJECT],
    resolveSecret: async () => 'dummy-gh-token',
    ...overrides,
  });

const devCtx = ctx();
const qaCtx = ctx({ userId: 'quinn', roles: ['qa'] });
const leadCtx = ctx({ userId: 'lee', roles: ['tech-lead'] });
const reviewerCtx = ctx({ userId: 'bob', roles: ['reviewer'] });

type Res<T = unknown> = { ok: boolean; error?: string; data?: T };

/** El adapter real de GitHub contra un `fetch` stubbeado: el PR existe y está abierto. */
const mockFetch = vi.fn();
beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
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

async function makeRegistry() {
  const catalog = await Catalog.load(CATALOG_ROOT);
  const store = new InMemoryFlowStore();
  const taskSystem = new InMemoryTaskSystemAdapter();
  const configStore = new InMemoryIntegrationConfigStore();
  // project '' = default del tenant: cualquier proyecto resuelve a GitHub.
  configStore.seed('t1', '', {
    pr_provider: { kind: 'github', secret_ref: 'aws-sm://gh#token', settings: {} },
  });
  const registry = buildToolRegistry({
    catalog,
    store,
    taskSystemProvider: new ConfigBackedTaskSystemProvider({
      configStore: new InMemoryIntegrationConfigStore(),
      inMemory: taskSystem,
    }),
    pullRequestProvider: new ConfigBackedPullRequestProvider({
      configStore,
      noOp: new NoOpPullRequestAdapter(),
    }),
  });
  return { store, taskSystem, registry };
}

/**
 * Deja una story lista para que QA la firme: claimeada por alice, en `in_review`
 * con el PR real y con `qa_plan` generado. Todo por el camino legítimo, con el
 * flow todavía vivo — abortarlo es el primer paso de la cadena, no del seed.
 */
async function seedReadyForQa() {
  const { store, taskSystem, registry } = await makeRegistry();
  const flow = await store.createFlow({
    tenant_id: 't1',
    project: PROJECT,
    slug: 'login',
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
  const epicRef = await taskSystem.createEpic(
    { project_key: PROJECT, title: 'Login', description: 'x' },
    devCtx,
  );
  const storyRef = await taskSystem.createStory(
    {
      project_key: PROJECT,
      epic_id: epicRef.external_id,
      title: 'User logs in',
      description: 'happy login',
      acceptance_criteria: ['email/password works', 'failure shows error'],
    },
    devCtx,
  );
  const story = await store.createStory({
    flow_id: flow.flow_id,
    external_id: storyRef.external_id,
    external_url: storyRef.url,
    title: 'User logs in',
    acceptance_criteria: ['email/password works', 'failure shows error'],
    target_repo: REPO,
  });

  const claim = (await registry.get('claim_story')!.handler(
    { story_id: story.story_id, developer_id: 'alice' },
    devCtx,
  )) as Res;
  expect(claim.ok, claim.error).toBe(true);
  const progress = (await registry.get('report_progress')!.handler(
    { story_id: story.story_id, status: 'in_review', pr_url: PR_URL },
    devCtx,
  )) as Res;
  expect(progress.ok, progress.error).toBe(true);
  const plan = (await registry.get('generate_qa_plan')!.handler(
    { story_id: story.story_id },
    qaCtx,
  )) as Res;
  expect(plan.ok, plan.error).toBe(true);

  return { store, taskSystem, registry, flow, story };
}

const qaResults = () =>
  ['AC-1', 'AC-2', 'EDGE-1', 'EDGE-2'].map((case_id) => ({
    case_id,
    status: 'passed',
    evidence_url: `https://ci.acme-corp.dev/${case_id.toLowerCase()}`,
  }));

const envelope = (overrides: Record<string, unknown> = {}) => ({
  schema: 'sdlc.qa-result/v1',
  test_command: 'pnpm --filter @sdlc/server test',
  test_exit_code: 0,
  test_output_hash: `sha256:${'a'.repeat(64)}`,
  acceptance_criteria: '2/2',
  ...overrides,
});

// ---------------------------------------------------------------------------
// La cadena del reviewer
// ---------------------------------------------------------------------------

describe('la cadena que resucitaba un flow aborted', () => {
  it('abort_flow → submit_qa_results → request_code_review → submit_review_outcome: el flow sigue aborted', async () => {
    const { store, registry, flow, story } = await seedReadyForQa();

    const abort = (await registry.get('abort_flow')!.handler(
      { flow_id: flow.flow_id, reason: 'la iniciativa se despriorizó' },
      leadCtx,
    )) as Res;
    expect(abort.ok, abort.error).toBe(true);
    expect((await store.getFlow(flow.flow_id))!.status).toBe('aborted');

    // 1) QA no firma sobre un flow abandonado.
    const qa = (await registry.get('submit_qa_results')!.handler(
      { story_id: story.story_id, results: qaResults(), envelope: envelope(), verdict: 'passed' },
      qaCtx,
    )) as Res;
    expect(qa.ok).toBe(false);
    expect(qa.error).toMatch(/aborted/i);
    expect(qa.error).toContain('start_flow');
    // La story no se movió: la guarda corre antes del side-effect.
    expect((await store.getStory(story.story_id))!.status).toBe('in_review');

    // 2) Ni siquiera forzando la story a qa_passed por atrás se resucita el flow:
    //    esta es la escritura incondicional de status que hacía de puerta.
    await store.updateStory(story.story_id, { status: 'qa_passed' });
    const request = (await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] },
      qaCtx,
    )) as Res;
    expect(request.ok).toBe(false);
    expect(request.error).toMatch(/aborted/i);
    expect((await store.getFlow(flow.flow_id))!.status).toBe('aborted');
    // No se tocó el PR: ningún reviewer agregado.
    expect(mockFetch).not.toHaveBeenCalled();

    // 3) Y el outcome tampoco, ni con el review.requested sembrado a mano.
    await store.appendEvent({
      flow_id: flow.flow_id,
      type: 'review.requested',
      actor: 'quinn',
      payload: { story_id: story.story_id, pr_url: PR_URL, reviewer_ids: ['bob'] },
    });
    const outcome = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved' , review: reviewOk() },
      reviewerCtx,
    )) as Res;
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/aborted/i);

    // El final de la cadena: nada de merged/done.
    const final = (await store.getFlow(flow.flow_id))!;
    expect(final.status).toBe('aborted');
    expect(final.current_phase).not.toBe('done');
    expect((await store.getStory(story.story_id))!.status).not.toBe('merged');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('una vez rechazada la cadena, sync_backlog sigue rechazando (no hay resurrección por atrás)', async () => {
    const { store, registry, flow, story } = await seedReadyForQa();
    await registry.get('abort_flow')!.handler(
      { flow_id: flow.flow_id, reason: 'se abandona' },
      leadCtx,
    );

    const sync = (await registry.get('sync_backlog')!.handler({ flow_id: flow.flow_id }, leadCtx)) as Res;
    expect(sync.ok).toBe(false);
    expect(sync.error).toMatch(/aborted/i);
    expect((await store.getFlow(flow.flow_id))!.status).toBe('aborted');
    expect((await store.getStory(story.story_id))!.status).toBe('in_review');
  });

  it('changes_requested tampoco reabre la implementación de un flow aborted', async () => {
    // La otra escritura incondicional: la rama `changes_requested` de
    // submit_review_outcome pisaba `status: impl_in_review, phase: implementation`.
    const { store, registry, flow, story } = await seedReadyForQa();
    await store.updateStory(story.story_id, { status: 'qa_passed' });
    await store.appendEvent({
      flow_id: flow.flow_id,
      type: 'review.requested',
      actor: 'quinn',
      payload: { story_id: story.story_id, pr_url: PR_URL, reviewer_ids: ['bob'] },
    });
    // El review se pidió con el flow vivo, así que la fase quedó en `review`; el
    // abort no la mueve, es el dato que dice hasta dónde había llegado.
    const request = (await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] },
      qaCtx,
    )) as Res;
    expect(request.ok, request.error).toBe(true);
    const alAbortar = (await registry.get('abort_flow')!.handler(
      { flow_id: flow.flow_id, reason: 'se abandona' },
      leadCtx,
    )) as Res<{ flow: { current_phase: string } }>;
    expect(alAbortar.ok, alAbortar.error).toBe(true);
    expect(alAbortar.data!.flow.current_phase).toBe('review');

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'changes_requested', comment: 'cambiá esto' , review: reviewConHallazgos() },
      reviewerCtx,
    )) as Res;

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/aborted/i);
    const final = (await store.getFlow(flow.flow_id))!;
    expect(final.status).toBe('aborted');
    // La fase quedó donde el abort la dejó: no volvió a implementation.
    expect(final.current_phase).toBe('review');
    expect((await store.getStory(story.story_id))!.status).toBe('qa_passed');
  });
});


// ---------------------------------------------------------------------------
// Censo de escrituras de `flow.status`
//
// La guarda por tool es tan fuerte como el censo: alcanza **una** escritura
// incondicional de `flow.status` en cualquier tool para que `aborted` vuelva a ser
// decorativo. Así que el censo tiene que ser verdadero, no plausible.
//
// La versión anterior escaneaba el texto de los argumentos de `.updateFlow(` con una
// regex de `status\s*:`. Un reviewer aplicó su lógica exacta a doce formas de escribir
// la misma escritura y **ocho pasaban**, empezando por la más natural de todas:
//
//     DETECTA  store.updateFlow(id, { status: 'merged' })
//     DETECTA  const p = {...}; store.updateFlow(id, p)
//     ESCAPA   store.updateFlow(id, buildPatch())
//     ESCAPA   store.updateFlow(id, this.patch())
//     ESCAPA   store.updateFlow(id, { ...p })
//     ESCAPA   store.updateFlow(id, { ['status']: 'merged' })
//     ESCAPA   store.updateFlow(id, { [K]: 'merged' })
//     ESCAPA   store.updateFlow(id, Object.assign({}, p))
//     ESCAPA   store.updateFlow(id, ok ? p : q)
//     ESCAPA   store.updateFlow(id, p as UpdateFlowInput)
//     ESCAPA   const { updateFlow } = store; updateFlow(id, {status:'x'})
//
// El problema no era la regex: era mirar el **texto del programa** cuando lo que
// importa es el **valor** que llega al store. Cualquier censo sintáctico tiene esta
// lista; el argumento se puede escribir de infinitas formas.
//
// Ahora la invariante vive en tres capas y ninguna es textual:
//
//  1. **Tipos.** `UpdateFlowInput` no tiene `status`, así que el literal no compila.
//     `PATCH_GENERICO_SIN_STATUS` en `state/store.ts` es la aserción de compilación
//     que impide volver a agregarlo, y corre en `pnpm typecheck`.
//  2. **Runtime.** `updateFlow` tira si el patch trae la clave `status`, sea el patch
//     un literal, una variable, un spread, un `Object.assign` o un cast. Es lo que
//     cierra las once formas de arriba de una sola vez, y es lo que se prueba abajo
//     **por comportamiento**, contra las dos implementaciones del store.
//  3. **Un solo nombre.** La única escritura de status es `updateFlowStatus`, y para
//     llamarla hay que nombrarla. El censo de abajo busca ese identificador en todo
//     `src/` (recursivo, no un solo directorio como antes) y exige que aparezca sólo
//     en la capa de store y en el chokepoint. Un nombre no se evade con un spread.
//
// Lo que **no** cubre: un `as never` sobre el patch saltea el runtime igual que
// saltea el tipo, porque el chequeo mira `hasOwnProperty` y un `as never` no cambia
// el valor... salvo que el valor sí lleve `status`, en cuyo caso tira. La única
// evasión que queda es llamar a `updateFlowStatus` directamente desde una tool
// nueva, y eso es lo que detecta el censo del identificador.
// ---------------------------------------------------------------------------

/** Todos los `.ts` bajo `src/`, recursivo. El escaneo viejo era de un solo directorio. */
function fuentesDeSrc(dir: string, acc: { file: string; source: string }[] = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) fuentesDeSrc(full, acc);
    else if (entry.name.endsWith('.ts')) acc.push({ file: relative(SRC_DIR, full), source: readFileSync(full, 'utf8') });
  }
  return acc;
}

/**
 * Los únicos archivos con derecho a nombrar `updateFlowStatus`.
 *
 * La capa de store porque ahí vive el método, y `abort-flow.ts` porque ahí vive el
 * chokepoint (`updateFlowUnlessAborted`) y el productor del terminal. Cualquier otro
 * archivo que aparezca acá es una tool que se saltea el chokepoint: pasala por
 * `updateFlowUnlessAborted` en vez de agregarla a la lista.
 */
const STATUS_WRITERS = [
  'state/store.ts',
  'state/in-memory.ts',
  'state/postgres.ts',
  'mcp/tools/abort-flow.ts',
];

describe('censo de escrituras: nada pisa un flow aborted', () => {
  const sources = fuentesDeSrc(SRC_DIR);

  it('sólo la capa de store y el chokepoint nombran updateFlowStatus', () => {
    // Buscar un **identificador** en vez de una forma sintáctica es lo que hace al
    // censo verdadero: para mover flow.status hay que llamar al método, y para
    // llamarlo hay que escribir su nombre. `store['updateFlowStatus']` y
    // `const { updateFlowStatus } = store` también contienen el nombre, y un acceso
    // por índice dinámico no compila contra un `FlowStore` tipado.
    const writers = sources
      .filter(({ source }) => source.includes('updateFlowStatus'))
      .map(({ file }) => file)
      .sort();

    expect(writers).toEqual([...STATUS_WRITERS].sort());
  });

  it('el censo mira archivos de verdad (y encuentra el chokepoint donde dice)', () => {
    // Guarda del test de arriba: si el escaneo se rompiera —directorio equivocado,
    // filtro mal puesto— la lista daría vacía y el censo pasaría sin mirar nada.
    expect(sources.length).toBeGreaterThan(30);
    expect(sources.some(({ file }) => file === 'mcp/tools/abort-flow.ts')).toBe(true);
    // Y el escaneo es recursivo: `mcp/tools/` no es el único directorio con fuentes.
    expect(new Set(sources.map(({ file }) => file.split('/')[0])).size).toBeGreaterThan(3);
  });
});

// ---------------------------------------------------------------------------
// La invariante de runtime: `updateFlow` no mueve `flow.status`, en ninguna forma
// ---------------------------------------------------------------------------

/**
 * Las doce formas de la lista del reviewer, como **valores** en vez de como texto.
 *
 * Cada entrada arma el patch de una forma distinta y todas llegan al store con la
 * clave `status` puesta. El chequeo mira el valor, así que la forma de construirlo
 * es irrelevante: es exactamente la razón por la que este test cubre las ocho que
 * escapaban al censo sintáctico.
 */
const STATUS_KEY = 'status';
const evasiones: { forma: string; patch: () => Record<string, unknown> }[] = [
  { forma: "literal { status: 'merged' }", patch: () => ({ status: 'merged' }) },
  { forma: 'patch en una variable', patch: () => { const p = { status: 'merged' }; return p; } },
  { forma: 'buildPatch() — el refactor más natural', patch: () => (() => ({ status: 'merged' }))() },
  { forma: 'spread { ...p }', patch: () => { const p = { status: 'merged' }; return { ...p }; } },
  { forma: "clave computada { ['status']: 'merged' }", patch: () => ({ ['status']: 'merged' }) },
  { forma: 'clave computada con constante { [K]: ... }', patch: () => ({ [STATUS_KEY]: 'merged' }) },
  { forma: 'Object.assign({}, p)', patch: () => Object.assign({}, { status: 'merged' }) },
  { forma: 'ternario ok ? p : q', patch: () => (true ? { status: 'merged' } : { status: 'aborted' }) },
  { forma: 'status: undefined (la clave está igual)', patch: () => ({ status: undefined }) },
  { forma: 'status junto a campos legítimos', patch: () => ({ current_phase: 'done', status: 'merged' }) },
];

describe('updateFlow rechaza cualquier patch con status (las dos implementaciones)', () => {
  for (const { forma, patch } of evasiones) {
    it(`InMemoryFlowStore: ${forma}`, async () => {
      const store = new InMemoryFlowStore();
      const flow = await store.createFlow({
        tenant_id: 't1', project: PROJECT, slug: 'censo', title: 'T',
      });

      await expect(store.updateFlow(flow.flow_id, patch() as never)).rejects.toThrow(
        /updateFlow.*status.*updateFlowUnlessAborted/s,
      );

      // Y no escribió nada: el flow quedó como estaba.
      expect((await store.getFlow(flow.flow_id))!.status).toBe('draft');
    });
  }

  it('PostgresFlowStore: el rechazo es anterior al query', async () => {
    // La invariante tiene que valer en las dos implementaciones, no sólo en la de
    // memoria; si no, el store de producción sería el único sin censo. La guarda es
    // la primera línea de `updateFlow`, así que corre antes de tocar la conexión —
    // por eso este test no necesita una base y vale igual.
    const store = new PostgresFlowStore({ databaseUrl: 'postgres://u:p@127.0.0.1:1/db' });
    try {
      await expect(store.updateFlow('t1:demo:x', { status: 'merged' } as never)).rejects.toThrow(
        /updateFlow.*status.*updateFlowUnlessAborted/s,
      );
    } finally {
      await store.close();
    }
  });

  it('el método destructurado tampoco lo evade', async () => {
    // `const { updateFlow } = store` era la última de la lista del reviewer. La
    // guarda es una función de módulo y no depende de `this`, así que corre igual.
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({
      tenant_id: 't1', project: PROJECT, slug: 'suelto', title: 'T',
    });
    const { updateFlow } = store;

    await expect(updateFlow(flow.flow_id, { status: 'merged' } as never)).rejects.toThrow(
      /updateFlow.*status/s,
    );
  });

  it('un patch sin status pasa: la guarda no rompe lo legítimo', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({
      tenant_id: 't1', project: PROJECT, slug: 'ok', title: 'T',
    });

    const updated = await store.updateFlow(flow.flow_id, {
      current_phase: 'rfc',
      epic_external_id: 'ADO-7',
    });

    expect(updated.current_phase).toBe('rfc');
    expect(updated.epic_external_id).toBe('ADO-7');
    expect(updated.status).toBe('draft');
  });

  it('el mensaje nombra la salida ejecutable', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({
      tenant_id: 't1', project: PROJECT, slug: 'msg', title: 'T',
    });

    const err = await store.updateFlow(flow.flow_id, { status: 'merged' } as never).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('updateFlowUnlessAborted');
    expect((err as Error).message).toContain('abort-flow.ts');
  });
});
