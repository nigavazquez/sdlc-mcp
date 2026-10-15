import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { Catalog } from '@sdlc/catalog';
import { InMemoryFlowStore } from '../src/state/index.js';
import { makeCreateEpicTool } from '../src/mcp/tools/create-epic.js';
import { makeCreateStoriesTool } from '../src/mcp/tools/create-stories.js';
import { makeClaimStoryTool } from '../src/mcp/tools/claim-story.js';
import { makeBlockStoryTool } from '../src/mcp/tools/block-story.js';
import { makeDiscardStoryTool } from '../src/mcp/tools/discard-story.js';
import { makeReportProgressTool } from '../src/mcp/tools/report-progress.js';
import { makeLinkSubtasksTool } from '../src/mcp/tools/link-subtasks.js';
import { makeRequestCodeReviewTool } from '../src/mcp/tools/request-code-review.js';
import { makeSubmitAdrTool } from '../src/mcp/tools/submit-adr.js';
import { makeSubmitPrdTool } from '../src/mcp/tools/submit-prd.js';
import { makeSubmitRfcTool } from '../src/mcp/tools/submit-rfc.js';
import { makeSubmitQaResultsTool } from '../src/mcp/tools/submit-qa-results.js';
import { makeSubmitReviewOutcomeTool } from '../src/mcp/tools/submit-review-outcome.js';
import { makeSyncBacklogTool } from '../src/mcp/tools/sync-backlog.js';
import { makeGenerateQaPlanTool } from '../src/mcp/tools/generate-qa-plan.js';
import { makeProposeBreakdownTool } from '../src/mcp/tools/propose-breakdown.js';
import { makeStartFlowTool } from '../src/mcp/tools/start-flow.js';
import { makeGetFlowStateTool } from '../src/mcp/tools/get-flow-state.js';
import { makeGenerateRfcSkeletonTool } from '../src/mcp/tools/generate-rfc-skeleton.js';
import { makeValidatePrdTool } from '../src/mcp/tools/validate-prd.js';
import { makeValidateRfcTool } from '../src/mcp/tools/validate-rfc.js';
import { makeGetImplementationContextTool } from '../src/mcp/tools/get-implementation-context.js';
import { makeGetRolePromptTool } from '../src/mcp/tools/get-role-prompt.js';
import { reviewOk } from './helpers/review-envelope.js';

// El acceso al squad se chequea antes de resolver cualquier provider/side-effect:
// si se llegara a resolver, este provider explota y el test falla.
//
// El mensaje es deliberadamente opaco y **sin palabras del dominio** — no lo mejores.
// Las tools devuelven el error del provider como `{ok:false, error}`, así que un
// mensaje que dijera "workspace" satisfaría por sí solo una aserción `/workspace/i` y
// la tabla pasaría por el motivo equivocado. Mismo criterio en los dobles del catálogo
// de más abajo.
const explodingProvider = {
  resolve() {
    throw new Error('PROBE_SHOULD_NOT_RESOLVE');
  },
} as never;
const catalog = {} as never;

function ctxForeign(): TenantCtx {
  return {
    tenantId: 'default',
    userId: 'alice',
    roles: ['developer'],
    workspaces: { platform: ['developer'] },
    async resolveSecret() {
      throw new Error('PROBE_SHOULD_NOT_RESOLVE_SECRET');
    },
  };
}

async function seedFlow(store: InMemoryFlowStore) {
  return store.createFlow({
    tenant_id: 'default',
    project: 'other-workspace', // squad al que alice NO pertenece
    slug: 's',
    title: 'Ajena',
    initiative_type: 'feature',
  });
}

async function seedStory(store: InMemoryFlowStore, flowId: string) {
  return store.createStory({
    flow_id: flowId,
    external_id: 'WI-1',
    external_url: 'http://x/1',
    title: 'S',
    acceptance_criteria: ['a'],
  });
}

describe('squad access en tools de escritura (workspace ajeno → error)', () => {
  it('create_epic rechaza workspace ajeno antes de tocar el task system', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store);
    const tool = makeCreateEpicTool(store, explodingProvider);
    const res = (await tool.handler(
      { flow_id: flow.flow_id, epic: { title: 'E', description: 'd' } },
      ctxForeign(),
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('other-workspace');
  });

  it('create_stories rechaza workspace ajeno', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store);
    const tool = makeCreateStoriesTool(store, explodingProvider);
    const res = (await tool.handler(
      { flow_id: flow.flow_id, epic_id: 'E-1', stories: [{ title: 'S', acceptance_criteria: ['a'] }] },
      ctxForeign(),
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('other-workspace');
  });

  it('claim_story rechaza workspace ajeno', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store);
    const story = await seedStory(store, flow.flow_id);
    const tool = makeClaimStoryTool(store, explodingProvider, catalog);
    const res = (await tool.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctxForeign(),
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('other-workspace');
  });

  it('block_story rechaza workspace ajeno', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store);
    const story = await seedStory(store, flow.flow_id);
    const tool = makeBlockStoryTool(store, explodingProvider);
    const res = (await tool.handler(
      { story_id: story.story_id, reason: 'x' },
      ctxForeign(),
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('other-workspace');
  });

  it('discard_story rechaza workspace ajeno', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store);
    const story = await seedStory(store, flow.flow_id);
    const tool = makeDiscardStoryTool(store, explodingProvider);
    const res = (await tool.handler(
      { story_id: story.story_id, reason: 'duplicada' },
      ctxForeign(),
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('other-workspace');
  });

  it('report_progress rechaza workspace ajeno', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store);
    const story = await seedStory(store, flow.flow_id);
    const tool = makeReportProgressTool(store, explodingProvider);
    const res = (await tool.handler(
      { story_id: story.story_id, status: 'in_progress' },
      ctxForeign(),
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('other-workspace');
  });

  it('link_subtasks rechaza workspace ajeno', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store);
    const tool = makeLinkSubtasksTool(store, explodingProvider);
    const res = (await tool.handler(
      { flow_id: flow.flow_id, story_id: 'WI-1', subtasks: [{ title: 'T' }] },
      ctxForeign(),
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('other-workspace');
  });

  it('request_code_review rechaza workspace ajeno', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store);
    const story = await seedStory(store, flow.flow_id);
    const tool = makeRequestCodeReviewTool(store, explodingProvider);
    const res = (await tool.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] },
      ctxForeign(),
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('other-workspace');
  });

  it('submit_adr rechaza workspace ajeno', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store);
    const tool = makeSubmitAdrTool(store, explodingProvider);
    const res = (await tool.handler(
      { flow_id: flow.flow_id, title: 'ADR', adr_markdown: 'x'.repeat(60) },
      ctxForeign(),
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('other-workspace');
  });

  it('submit_prd rechaza workspace ajeno', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store);
    const tool = makeSubmitPrdTool(store, explodingProvider);
    const res = (await tool.handler(
      { flow_id: flow.flow_id, prd_markdown: 'x'.repeat(60) },
      ctxForeign(),
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('other-workspace');
  });

  it('submit_rfc rechaza workspace ajeno', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store);
    const tool = makeSubmitRfcTool(store, explodingProvider);
    const res = (await tool.handler(
      { flow_id: flow.flow_id, rfc_markdown: 'x'.repeat(60), repo_path: 'docs/rfc.md' },
      ctxForeign(),
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('other-workspace');
  });

  it('submit_qa_results rechaza workspace ajeno', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store);
    const story = await seedStory(store, flow.flow_id);
    const tool = makeSubmitQaResultsTool(store, explodingProvider);
    const res = (await tool.handler(
      { story_id: story.story_id, results: [], verdict: 'passed' },
      ctxForeign(),
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('other-workspace');
  });

  it('submit_review_outcome rechaza workspace ajeno', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store);
    const story = await seedStory(store, flow.flow_id);
    const tool = makeSubmitReviewOutcomeTool(store, explodingProvider);
    const res = (await tool.handler(
      { story_id: story.story_id, outcome: 'approved' , review: reviewOk() },
      ctxForeign(),
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('other-workspace');
  });

  it('sync_backlog rechaza workspace ajeno', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store);
    const tool = makeSyncBacklogTool(store);
    const res = (await tool.handler(
      { flow_id: flow.flow_id },
      ctxForeign(),
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('other-workspace');
  });

  it('generate_qa_plan rechaza workspace ajeno', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store);
    const story = await seedStory(store, flow.flow_id);
    const tool = makeGenerateQaPlanTool(store);
    const res = (await tool.handler(
      { story_id: story.story_id },
      ctxForeign(),
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('other-workspace');
  });

  it('propose_breakdown rechaza workspace ajeno', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store);
    const tool = makeProposeBreakdownTool(store, catalog);
    const res = (await tool.handler(
      { flow_id: flow.flow_id, rfc_markdown: 'x' },
      ctxForeign(),
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('other-workspace');
  });
});

// El ctx sin claim `workspaces` es el caso del token viejo: firmado válido pero emitido
// antes de que el claim existiera. Antes pasaba todas las guardas (fail-open deliberado);
// ahora se rechaza, salvo que esté prendido el escape hatch de tests/dev local.
function ctxSinClaim(): TenantCtx {
  return {
    tenantId: 'default',
    userId: 'alice',
    roles: ['developer', 'product-manager'],
    async resolveSecret() {
      throw new Error('PROBE_SHOULD_NOT_RESOLVE_SECRET');
    },
  };
}

describe('ctx sin claim workspaces (token viejo) en tools de escritura', () => {
  afterEach(() => {
    delete process.env.SDLC_ALLOW_UNSCOPED_CTX;
  });

  it('start_flow rechaza el ctx sin claim, sin crear el flow, y nombra las dos salidas', async () => {
    const store = new InMemoryFlowStore();
    const tool = makeStartFlowTool(store);
    const res = (await tool.handler(
      { project: 'platform', title: 'Sin claim', initiative_type: 'feature' },
      ctxSinClaim(),
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('platform');
    expect(res.error).toContain('login OAuth');
    expect(res.error).toContain('SDLC_ALLOW_UNSCOPED_CTX=true');
    expect(await store.listFlows('default')).toHaveLength(0);
  });

  it('submit_prd rechaza el ctx sin claim antes de resolver el doc store', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store);
    const tool = makeSubmitPrdTool(store, explodingProvider);
    const res = (await tool.handler(
      { flow_id: flow.flow_id, prd_markdown: 'x'.repeat(60) },
      ctxSinClaim(),
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('other-workspace');
  });

  it('con SDLC_ALLOW_UNSCOPED_CTX=true el mismo ctx sin claim pasa la guarda', async () => {
    process.env.SDLC_ALLOW_UNSCOPED_CTX = 'true';
    const store = new InMemoryFlowStore();
    const tool = makeStartFlowTool(store);
    const res = (await tool.handler(
      { project: 'platform', title: 'Sin claim, con flag', initiative_type: 'feature' },
      ctxSinClaim(),
    )) as { ok: boolean };
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tools de LECTURA. Antes sólo comparaban `flow.tenant_id` con el del ctx y no
// llamaban a ninguna guarda de workspace. Como el deploy es single-tenant, ese
// chequeo no rechazaba a nadie: cualquier usuario autenticado leía el estado
// completo de un flow de otro workspace (prd_ref/rfc_ref con URLs de Drive,
// título, los últimos 10 eventos, pr_url). Ahora las seis usan assertFlowAccess,
// la misma guarda que las de escritura, aplicada antes de devolver cualquier dato.
//
// `ctxForeign()` (arriba) es alice, miembro sólo de `platform`. Los flows ajenos
// viven en `other-workspace` y los propios en `platform`.
const CATALOG_ROOT = resolve(__dirname, '../../../packages/catalog');

/** Flow ajeno con referencias cargadas: si algo se filtra, se filtra esto. */
async function seedFlowConDatos(store: InMemoryFlowStore) {
  const flow = await store.createFlow({
    tenant_id: 'default',
    project: 'other-workspace',
    slug: 'secreta',
    title: 'Iniciativa confidencial de otro squad',
    initiative_type: 'feature',
  });
  return store.updateFlow(flow.flow_id, {
    prd_ref: { url: 'https://drive.google.com/file/d/SECRETO-PRD' },
    rfc_ref: { url: 'https://drive.google.com/file/d/SECRETO-RFC' },
    architecture_mode: 'monolith',
    codebase_status: 'brownfield',
  });
}

/** El mismo flow pero en un workspace al que alice sí pertenece. */
async function seedFlowPropio(store: InMemoryFlowStore) {
  const flow = await store.createFlow({
    tenant_id: 'default',
    project: 'platform',
    slug: 'propia',
    title: 'Iniciativa propia',
    initiative_type: 'feature',
  });
  return store.updateFlow(flow.flow_id, {
    prd_ref: { url: 'https://drive.google.com/file/d/PROPIO-PRD' },
    architecture_mode: 'monolith',
    codebase_status: 'brownfield',
  });
}

/** El rechazo por workspace nombra el workspace y la salida ejecutable. */
function expectRechazoDeWorkspace(res: { ok: boolean; error?: string }) {
  expect(res.ok).toBe(false);
  expect(res.error).toContain('other-workspace');
  expect(res.error).toContain('panel admin');
  expect(res.error).toContain('volvé a loguearte');
}

/** Ningún dato del flow ajeno puede aparecer en la respuesta. */
function expectSinFiltracion(res: unknown) {
  const dump = JSON.stringify(res);
  expect(dump).not.toContain('SECRETO-PRD');
  expect(dump).not.toContain('SECRETO-RFC');
  expect(dump).not.toContain('confidencial');
}

describe('workspace access en tools de lectura (workspace ajeno → error)', () => {
  it('get_flow_state rechaza el workspace ajeno y no filtra refs, título ni eventos', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlowConDatos(store);
    await store.appendEvent({
      flow_id: flow.flow_id,
      type: 'prd_submitted',
      actor: 'bob',
      payload: { nota: 'evento del squad ajeno' },
    });
    const tool = makeGetFlowStateTool(store);
    const res = (await tool.handler({ flow_id: flow.flow_id }, ctxForeign())) as {
      ok: boolean;
      error?: string;
    };
    expectRechazoDeWorkspace(res);
    expectSinFiltracion(res);
    expect(JSON.stringify(res)).not.toContain('squad ajeno');
  });

  it('get_flow_state deja pasar el workspace propio', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlowPropio(store);
    const tool = makeGetFlowStateTool(store);
    const res = (await tool.handler({ flow_id: flow.flow_id }, ctxForeign())) as {
      ok: boolean;
      data?: { flow: { flow_id: string } };
    };
    expect(res.ok).toBe(true);
    expect(res.data?.flow.flow_id).toBe(flow.flow_id);
  });

  it('generate_rfc_skeleton rechaza el workspace ajeno antes de leer el catálogo', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlowConDatos(store);
    // El catálogo explota si se lo toca: el rechazo tiene que salir antes.
    const catalogoQueExplota = {
      async getTemplate() {
        // Mensaje estéril a propósito: ver el comentario de `explodingProvider`.
        throw new Error('PROBE_SHOULD_NOT_READ');
      },
    } as never;
    const tool = makeGenerateRfcSkeletonTool(store, catalogoQueExplota);
    const res = (await tool.handler({ flow_id: flow.flow_id }, ctxForeign())) as {
      ok: boolean;
      error?: string;
    };
    expectRechazoDeWorkspace(res);
    expectSinFiltracion(res);
  });

  it('generate_rfc_skeleton deja pasar el workspace propio', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlowPropio(store);
    const catalog = await Catalog.load(CATALOG_ROOT);
    const tool = makeGenerateRfcSkeletonTool(store, catalog);
    const res = (await tool.handler({ flow_id: flow.flow_id }, ctxForeign())) as {
      ok: boolean;
      data?: { rfc_skeleton: string };
    };
    expect(res.ok).toBe(true);
    expect(res.data?.rfc_skeleton).toContain('Iniciativa propia');
  });
});

describe('workspace access en los validadores (los dos modos igual)', () => {
  // El dry-run (con el markdown en el input) no lee nada del flow, pero igual
  // confirmaría que el flow existe. Se autoriza igual que el otro modo: una sola
  // guarda arriba, apenas se resuelve el flow.
  const PRD = ['# PRD', '## Problema', 'x', '## Objetivos', 'y'].join('\n');
  const RFC = ['# RFC', '## Design', 'x', '## Risks', 'y'].join('\n');

  it('validate_prd rechaza el workspace ajeno en modo dry-run (con prd_markdown)', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlowConDatos(store);
    const tool = makeValidatePrdTool(store);
    const res = (await tool.handler(
      { flow_id: flow.flow_id, prd_markdown: PRD },
      ctxForeign(),
    )) as { ok: boolean; error?: string };
    expectRechazoDeWorkspace(res);
  });

  it('validate_prd rechaza el workspace ajeno en modo referencia (sin prd_markdown)', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlowConDatos(store);
    const tool = makeValidatePrdTool(store);
    const res = (await tool.handler({ flow_id: flow.flow_id }, ctxForeign())) as {
      ok: boolean;
      error?: string;
    };
    expectRechazoDeWorkspace(res);
    // Este modo devuelve `prd_ref` en `data` cuando pasa: no puede filtrarlo acá.
    expectSinFiltracion(res);
  });

  it('validate_prd deja pasar el workspace propio en los dos modos', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlowPropio(store);
    const tool = makeValidatePrdTool(store);
    const dryRun = (await tool.handler(
      { flow_id: flow.flow_id, prd_markdown: PRD },
      ctxForeign(),
    )) as { ok: boolean; data?: unknown };
    expect(dryRun.ok).toBe(true);
    expect(dryRun.data).toBeDefined();

    // Modo referencia: el flow tiene prd_ref, así que pasa la guarda y llega al
    // "el body no se guarda server-side" — ok:false, pero ya del otro lado.
    const porRef = (await tool.handler({ flow_id: flow.flow_id }, ctxForeign())) as {
      ok: boolean;
      error?: string;
      data?: { prd_ref: { url?: string } };
    };
    expect(porRef.error).toContain('not stored server-side');
    expect(porRef.data?.prd_ref.url).toContain('PROPIO-PRD');
  });

  it('validate_rfc rechaza el workspace ajeno en los dos modos', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlowConDatos(store);
    const tool = makeValidateRfcTool(store);
    const dryRun = (await tool.handler(
      { flow_id: flow.flow_id, rfc_markdown: RFC },
      ctxForeign(),
    )) as { ok: boolean; error?: string };
    expectRechazoDeWorkspace(dryRun);

    const porRef = (await tool.handler({ flow_id: flow.flow_id }, ctxForeign())) as {
      ok: boolean;
      error?: string;
    };
    expectRechazoDeWorkspace(porRef);
    expectSinFiltracion(porRef);
  });

  it('validate_rfc deja pasar el workspace propio en modo dry-run', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlowPropio(store);
    const tool = makeValidateRfcTool(store);
    const res = (await tool.handler(
      { flow_id: flow.flow_id, rfc_markdown: RFC },
      ctxForeign(),
    )) as { ok: boolean; data?: unknown };
    expect(res.ok).toBe(true);
    expect(res.data).toBeDefined();
  });
});

describe('workspace access en get_implementation_context (autoriza contra el flow de la story)', () => {
  it('rechaza una story cuyo flow es de otro workspace, antes del chequeo de status', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlowConDatos(store);
    const story = await store.createStory({
      flow_id: flow.flow_id,
      external_id: 'WI-9',
      external_url: 'https://dev.azure.com/secreto/9',
      title: 'Story del squad ajeno',
      acceptance_criteria: ['a'],
    });
    // La story queda en status=created. Si la guarda corriera después, el error
    // sería el de "not been claimed yet" y estaríamos confirmando que existe.
    const catalogoQueExplota = {
      async getRolePrompt() {
        // Mensaje estéril a propósito: ver el comentario de `explodingProvider`.
        throw new Error('PROBE_SHOULD_NOT_READ');
      },
    } as never;
    const tool = makeGetImplementationContextTool(store, catalogoQueExplota);
    const res = (await tool.handler({ story_id: story.story_id }, ctxForeign())) as {
      ok: boolean;
      error?: string;
    };
    expectRechazoDeWorkspace(res);
    expect(res.error).not.toContain('not been claimed');
    expectSinFiltracion(res);
    expect(JSON.stringify(res)).not.toContain('WI-9');
  });

  it('deja pasar una story cuyo flow es del workspace propio', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlowPropio(store);
    const story = await store.createStory({
      flow_id: flow.flow_id,
      external_id: 'WI-1',
      external_url: 'https://dev.azure.com/propio/1',
      title: 'Story propia',
      acceptance_criteria: ['a'],
    });
    await store.updateStory(story.story_id, { status: 'in_progress', assignee: 'alice' });
    const catalog = await Catalog.load(CATALOG_ROOT);
    const tool = makeGetImplementationContextTool(store, catalog);
    const res = (await tool.handler({ story_id: story.story_id }, ctxForeign())) as {
      ok: boolean;
      data?: { story: { story_id: string } };
    };
    expect(res.ok).toBe(true);
    expect(res.data?.story.story_id).toBe(story.story_id);
  });
});

describe('workspace access en get_role_prompt (flow_id opcional)', () => {
  // Decisión: se autoriza cuando hay un flow que autorizar. Sin `flow_id` no hay
  // workspace contra el que chequear y lo que se devuelve es catálogo del servidor,
  // igual para todos; con `flow_id`, el flow ajeno se rechaza porque
  // architecture_mode/codebase_status son datos de ese flow.
  it('rechaza el flow_id de otro workspace', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlowConDatos(store);
    const catalogoQueExplota = {
      async getRolePrompt() {
        // Mensaje estéril a propósito: ver el comentario de `explodingProvider`.
        throw new Error('PROBE_SHOULD_NOT_READ');
      },
    } as never;
    const tool = makeGetRolePromptTool(catalogoQueExplota, store);
    const res = (await tool.handler(
      { role: 'developer', phase: 'implement', flow_id: flow.flow_id },
      ctxForeign(),
    )) as { ok: boolean; error?: string };
    expectRechazoDeWorkspace(res);
    // El escenario del flow ajeno tampoco puede salir por acá.
    expect(JSON.stringify(res)).not.toContain('brownfield');
  });

  it('sin flow_id devuelve el catálogo aunque el usuario no tenga el workspace', async () => {
    const store = new InMemoryFlowStore();
    const catalog = await Catalog.load(CATALOG_ROOT);
    const tool = makeGetRolePromptTool(catalog, store);
    const res = (await tool.handler(
      { role: 'developer', phase: 'implement' },
      ctxForeign(),
    )) as { ok: boolean; data?: { system_prompt: string } };
    expect(res.ok).toBe(true);
    expect(res.data?.system_prompt).toBeTruthy();
  });

  it('con flow_id del workspace propio suma el escenario del flow', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlowPropio(store);
    const catalog = await Catalog.load(CATALOG_ROOT);
    const tool = makeGetRolePromptTool(catalog, store);
    const res = (await tool.handler(
      { role: 'developer', phase: 'implement', flow_id: flow.flow_id },
      ctxForeign(),
    )) as { ok: boolean; data?: { skills: { id: string }[] } };
    expect(res.ok).toBe(true);
    expect(res.data?.skills.length).toBeGreaterThan(0);
  });
});
