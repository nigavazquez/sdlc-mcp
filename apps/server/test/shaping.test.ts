import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Catalog } from '@sdlc/catalog';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { InMemoryFlowStore } from '../src/state/index.js';
import { InMemoryTaskSystemAdapter, ConfigBackedTaskSystemProvider } from '../src/adapters/index.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import { buildToolRegistry } from '../src/mcp/tools/index.js';
import { testCtx } from './helpers/tenant-ctx.js';

const CATALOG_ROOT = resolve(__dirname, '../../../packages/catalog');

// El ctx de las tools de shaping se queda en `pmo` a propósito: es el rol que el catálogo
// le asigna a la fase `shaping`, y así estos tests prueban que el camino del pmo alcanza
// —sin apoyarse en el break-glass de tech-lead—.
const CTX: TenantCtx = testCtx({
  tenantId: 'demo-tenant',
  userId: 'pat',
  roles: ['pmo'],
  workspaces: ['checkout'],
  async resolveSecret() {
    throw new Error('not used');
  },
});

/**
 * Ctx aparte para llevar el flow hasta `rfc_ready`, que es andamiaje y no el objeto de
 * estudio de este archivo.
 *
 * Va separado de `CTX` en vez de sumarle los roles: los pasos previos al shaping los
 * conduce otra gente (`start_flow` → product-manager, `submit_prd` → product-manager,
 * `submit_rfc` → tech-lead), y meter esos tres roles en el ctx del pmo haría que los
 * tests de shaping pasaran por el break-glass de tech-lead sin que se note. Con el ctx
 * partido, si mañana se le saca `pmo` a una tool de shaping, estos tests fallan.
 */
const SETUP_CTX: TenantCtx = testCtx({
  tenantId: 'demo-tenant',
  userId: 'lee',
  roles: ['product-manager', 'tech-lead'],
  workspaces: ['checkout'],
  async resolveSecret() {
    throw new Error('not used');
  },
});

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

async function setup() {
  const catalog = await Catalog.load(CATALOG_ROOT);
  const store = new InMemoryFlowStore();
  const taskSystem = new InMemoryTaskSystemAdapter();
  const taskSystemProvider = new ConfigBackedTaskSystemProvider({
    configStore: new InMemoryIntegrationConfigStore(),
    inMemory: taskSystem,
  });
  const registry = buildToolRegistry({ catalog, store, taskSystemProvider });
  const call = async <T>(
    name: string,
    input: unknown,
    ctx: TenantCtx = CTX,
  ): Promise<{ ok: boolean; data?: T; error?: string }> => {
    const tool = registry.get(name);
    if (!tool) throw new Error(`Unknown tool ${name}`);
    const parsed = tool.inputSchema.parse(input ?? {});
    return (await tool.handler(parsed, ctx)) as never;
  };
  return { store, call };
}

type Call = <T>(n: string, i: unknown, ctx?: TenantCtx) => Promise<{ ok: boolean; data?: T; error?: string }>;

/**
 * Lleva un flow nuevo hasta `rfc_ready` con `SETUP_CTX`.
 *
 * Cada paso se assertea. Antes se ignoraban los tres resultados, y cuando `start_flow` /
 * `submit_prd` / `submit_rfc` estrenaron guarda de rol el fixture siguió devolviendo un
 * `flow_id` —de un flow que se había quedado en `draft`— así que los seis tests de shaping
 * fallaban con "flow status is draft, expected rfc_ready" en vez de decir que el problema
 * estaba en el andamiaje. Un fixture que se traga los errores hace que el próximo cambio
 * de guardas se diagnostique en el lugar equivocado.
 */
async function toRfcReady(call: Call) {
  const start = await call<{ flow_id: string }>(
    'start_flow',
    { project: 'checkout', title: 'Pago en cuotas', initiative_type: 'feature' },
    SETUP_CTX,
  );
  expect(start.ok, `start_flow falló: ${start.error}`).toBe(true);
  const flow_id = (start.data as { flow_id: string }).flow_id;
  const PRD = `# PRD\n\n## Problem\nx problem here long enough to pass\n\n## Users\n- u\n\n## Success Metrics\n| m | b | t | p |\n\n## Scope\n- s\n\n## Out of Scope\n- o\n\n## Risks\n| r | p | i | m |`;
  const prd = await call('submit_prd', { flow_id, prd_markdown: PRD, repo_path: '/docs/prd/c.md' }, SETUP_CTX);
  expect(prd.ok, `submit_prd falló: ${prd.error}`).toBe(true);
  const rfc = await call('submit_rfc', { flow_id, rfc_markdown: RFC, repo_path: '/docs/rfc/c.md' }, SETUP_CTX);
  expect(rfc.ok, `submit_rfc falló: ${rfc.error}`).toBe(true);
  return flow_id;
}

describe('shaping flow', () => {
  it('full happy path: rfc_ready → backlog_ready', async () => {
    const { call, store } = await setup();
    const flow_id = await toRfcReady(call);

    const proposed = await call<{ suggested_breakdown: unknown; template: string }>('propose_breakdown', {
      flow_id,
      rfc_markdown: RFC,
    });
    expect(proposed.ok).toBe(true);
    expect(typeof proposed.data?.template).toBe('string');

    const epic = await call<{ epic_ref: { external_id: string } }>('create_epic', {
      flow_id,
      epic: { title: 'Cuotas', description: 'desc' },
    });
    expect(epic.ok).toBe(true);
    const epic_id = epic.data!.epic_ref.external_id;

    const stories = await call<{ story_refs: { external_id: string }[] }>('create_stories', {
      flow_id,
      epic_id,
      stories: [
        { title: 'S1', description: 'd', acceptance_criteria: ['ac1'] },
        { title: 'S2', description: 'd', acceptance_criteria: ['ac2'] },
      ],
    });
    expect(stories.ok).toBe(true);
    expect(stories.data?.story_refs.length).toBe(2);
    const refs = stories.data!.story_refs;
    const stored = await store.listStoriesByFlow(flow_id);
    expect(stored.map((s) => s.external_id).sort()).toEqual(
      refs.map((r) => r.external_id).sort(),
    );
    expect(stored.every((s) => s.status === 'created')).toBe(true);
    expect(stored[0]?.acceptance_criteria.length).toBeGreaterThan(0);
    const story_id = stories.data!.story_refs[0]!.external_id;

    const subs = await call<{ subtask_refs: { external_id: string }[] }>('link_subtasks', {
      flow_id,
      story_id,
      subtasks: [{ title: 'Sub A' }],
    });
    expect(subs.ok).toBe(true);

    const sync = await call<{ flow: { status: string; current_phase: string }; backlog: { stories: unknown[] } }>(
      'sync_backlog',
      { flow_id },
    );
    expect(sync.ok).toBe(true);
    expect(sync.data?.flow.status).toBe('backlog_ready');
    expect(sync.data?.flow.current_phase).toBe('implementation');
    expect(sync.data?.backlog.stories.length).toBe(2);
  });

  it('propose_breakdown fails before rfc_ready', async () => {
    const { call } = await setup();
    const start = await call<{ flow_id: string }>('start_flow', { project: 'checkout', title: 'Early', initiative_type: 'feature' });
    const flow_id = (start.data as { flow_id: string }).flow_id;
    const res = await call('propose_breakdown', { flow_id, rfc_markdown: RFC });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/rfc_ready/);
  });

  it('create_stories fails when no epic exists', async () => {
    const { call } = await setup();
    const flow_id = await toRfcReady(call);
    const res = await call('create_stories', {
      flow_id,
      epic_id: 'ADO-999',
      stories: [{ title: 'S', description: 'd', acceptance_criteria: ['ac'] }],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/create_epic first/);
  });

  it('sync_backlog fails when no stories were created', async () => {
    const { call } = await setup();
    const flow_id = await toRfcReady(call);
    await call('create_epic', { flow_id, epic: { title: 'E', description: 'd' } });
    const res = await call('sync_backlog', { flow_id });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no stories/i);
  });

  it('rejects shaping access from another tenant', async () => {
    const { call, store } = await setup();
    const flow_id = await toRfcReady(call);
    // Con claim propio: el rechazo tiene que salir del chequeo de tenant, no del claim ausente.
    const otherCtx: TenantCtx = testCtx({ tenantId: 'evil', userId: 'm', roles: ['pmo'], workspaces: ['checkout'], async resolveSecret() { throw new Error('no'); } });
    const catalog = await Catalog.load(CATALOG_ROOT);
    const taskSystem = new InMemoryTaskSystemAdapter();
    const taskSystemProvider = new ConfigBackedTaskSystemProvider({
      configStore: new InMemoryIntegrationConfigStore(),
      inMemory: taskSystem,
    });
    const registry = buildToolRegistry({ catalog, store, taskSystemProvider });
    const tool = registry.get('create_epic')!;
    const res = (await tool.handler({ flow_id, epic: { title: 'E', description: 'd' } }, otherCtx)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/different tenant/);
  });

  it('create_epic fails if an epic already exists', async () => {
    const { call } = await setup();
    const flow_id = await toRfcReady(call);
    await call('create_epic', { flow_id, epic: { title: 'E', description: 'd' } });
    const res = await call('create_epic', { flow_id, epic: { title: 'E2', description: 'd' } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already created/i);
  });

  it('create_stories fails when epic_id does not match the flow epic', async () => {
    const { call } = await setup();
    const flow_id = await toRfcReady(call);
    await call('create_epic', { flow_id, epic: { title: 'E', description: 'd' } });
    const res = await call('create_stories', {
      flow_id,
      epic_id: 'ADO-WRONG',
      stories: [{ title: 'S', description: 'd', acceptance_criteria: ['ac'] }],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/does not match/i);
  });

  it('link_subtasks fails before an epic exists', async () => {
    const { call } = await setup();
    const flow_id = await toRfcReady(call);
    const res = await call('link_subtasks', {
      flow_id,
      story_id: 'ADO-1',
      subtasks: [{ title: 'Sub' }],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no epic exists/i);
  });

  it('sync_backlog fails if backlog already synced', async () => {
    const { call } = await setup();
    const flow_id = await toRfcReady(call);
    const epic = await call<{ epic_ref: { external_id: string } }>('create_epic', { flow_id, epic: { title: 'E', description: 'd' } });
    const epic_id = (epic.data as { epic_ref: { external_id: string } }).epic_ref.external_id;
    await call('create_stories', { flow_id, epic_id, stories: [{ title: 'S', description: 'd', acceptance_criteria: ['ac'] }] });
    const first = await call('sync_backlog', { flow_id });
    expect(first.ok).toBe(true);
    const second = await call('sync_backlog', { flow_id });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already synced/i);
  });

  it('create_stories rejects a story with empty acceptance_criteria', async () => {
    const { call } = await setup();
    const flow_id = await toRfcReady(call);
    const epic = await call<{ epic_ref: { external_id: string } }>('create_epic', { flow_id, epic: { title: 'E', description: 'd' } });
    const epic_id = (epic.data as { epic_ref: { external_id: string } }).epic_ref.external_id;
    await expect(
      call('create_stories', {
        flow_id,
        epic_id,
        stories: [{ title: 'S', description: 'd', acceptance_criteria: [] }],
      }),
    ).rejects.toThrow();
  });

  it('propose_breakdown returns advisory validation issues for the incomplete suggestion', async () => {
    const { call } = await setup();
    const flow_id = await toRfcReady(call);
    const res = await call<{ validation: { ok: boolean; issues: unknown[] } }>('propose_breakdown', { flow_id, rfc_markdown: RFC });
    expect(res.ok).toBe(true);
    // suggested stories have empty AC by design → validation reports issues
    expect(res.data?.validation.ok).toBe(false);
    expect((res.data?.validation.issues.length ?? 0)).toBeGreaterThan(0);
  });
});
