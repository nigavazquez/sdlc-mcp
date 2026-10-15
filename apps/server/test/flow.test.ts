import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Catalog } from '@sdlc/catalog';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { InMemoryFlowStore } from '../src/state/index.js';
import { InMemoryTaskSystemAdapter, ConfigBackedTaskSystemProvider } from '../src/adapters/index.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import { buildToolRegistry } from '../src/mcp/tools/index.js';
import { makeStartFlowTool } from '../src/mcp/tools/start-flow.js';
import { testCtx } from './helpers/tenant-ctx.js';

const CATALOG_ROOT = resolve(__dirname, '../../../packages/catalog');

const FAKE_CTX: TenantCtx = testCtx({
  tenantId: 'demo-tenant',
  userId: 'alice',
  roles: ['product-manager', 'tech-lead'],
  workspaces: ['checkout'],
  async resolveSecret() {
    throw new Error('not used in tests');
  },
});

const VALID_PRD = `
# PRD: Pago en cuotas

## Problem
Los compradores premium abandonan el checkout cuando el ticket supera USD 200 porque no hay opción de cuotas.

## Users
- Comprador premium recurrente: ticket > 200, abandona en checkout.
- Comprador ocasional: ticket bajo, no afectado pero feedback útil.

## Success Metrics
| Métrica | Baseline | Target | Plazo |
|---|---|---|---|
| Conversion premium | 1.8% | 2.5% | 60 días |
| Ticket promedio | 180 | 250 | 60 días |
| Reclamos cuotas | n/a | <2% | 90 días |

## Scope
- Cuotas 3, 6, 12 sin interés.
- Validación de tarjeta antes de cobrar primera cuota.

## Out of Scope
- Cuotas con interés del banco.
- Refinanciación post-compra.
- Soporte tarjetas corporativas.

## Risks
| Riesgo | Probabilidad | Impacto | Mitigación |
| Fraude con cuotas | M | H | 3DS obligatorio |
| Backoffice no preparado | M | M | Capacitación previa |
| Performance pagos | L | H | Carga + circuit breaker |
`;

const VALID_RFC = `---
architecture_mode: reuse
codebase_status: existing
existing_repo: https://github.com/acme/checkout
---

# RFC: Pago en cuotas

## Context
Implementar el feature definido en el PRD del 2026-05-09.

## Architecture context

### Architecture mode
Reusamos la arquitectura existente del servicio checkout. No introducimos nuevos runtimes.

### Existing components reused
- packages/checkout/service
- packages/payments/api

### Codebase context
Monorepo TypeScript pnpm + turbo. Convenciones de naming kebab-case. Tests con vitest.

### Integration points
- Eventos checkout.order.created
- API REST POST /payments/installments

## Goals
- Pagos en 3/6/12 cuotas, p99 < 800ms en checkout.

## Non-goals
- Refinanciación post-compra.

## Design
Usaremos el processor X con webhook idempotente.
Tabla payments_plans nueva con migración online.
Frontend agrega selector de cuotas en step 3 del checkout.

## Risks
| Riesgo | Tipo | Probabilidad | Impacto | Mitigación |
| Webhook drop | integ | M | H | Cola de retry |
| Migración bloqueante | data | L | H | Backfill async |
| Costo por txn | perf | M | M | Cap por cliente |

## Rollout
- Canary 5% durante 48h.
- 25% durante 72h con health checks.
- 100%.

## Rollback
1. Feature flag off via dashboard.
2. Worker drena cola pendiente.
3. Revertir migración no destructiva.
`;

async function setup() {
  const catalog = await Catalog.load(CATALOG_ROOT);
  const store = new InMemoryFlowStore();
  const taskSystemProvider = new ConfigBackedTaskSystemProvider({
    configStore: new InMemoryIntegrationConfigStore(),
    inMemory: new InMemoryTaskSystemAdapter(),
  });
  const registry = buildToolRegistry({ catalog, store, taskSystemProvider });
  const call = async <T>(name: string, input: unknown): Promise<{ ok: boolean; data?: T; error?: string; next_actions?: string[] }> => {
    const tool = registry.get(name);
    if (!tool) throw new Error(`Unknown tool ${name}`);
    const parsed = tool.inputSchema.parse(input ?? {});
    return (await tool.handler(parsed, FAKE_CTX)) as never;
  };
  return { catalog, store, registry, call };
}

describe('flow PRD/RFC happy path', () => {
  it('start_flow creates a flow scoped to the tenant', async () => {
    const { call } = await setup();
    const res = await call<{ flow_id: string; tenant_id: string }>('start_flow', {
      project: 'checkout',
      initiative_type: 'feature',
      title: 'Pago en cuotas',
    });
    expect(res.ok).toBe(true);
    expect(res.data?.flow_id).toBe('demo-tenant:checkout:pago-en-cuotas');
    expect(res.data?.tenant_id).toBe('demo-tenant');
    expect(res.next_actions).toContain('submit_prd');
  });

  it('submit_prd advances to prd_ready when validation passes', async () => {
    const { call } = await setup();
    const start = await call<{ flow_id: string }>('start_flow', {
      project: 'checkout',
      initiative_type: 'feature',
      title: 'Pago en cuotas',
    });
    const flow_id = start.data!.flow_id;
    const res = await call<{ flow: { status: string; current_phase: string }; validation: { ok: boolean } }>(
      'submit_prd',
      { flow_id, prd_markdown: VALID_PRD, repo_path: '/docs/prd/cuotas.md' },
    );
    expect(res.ok).toBe(true);
    expect(res.data?.flow.status).toBe('prd_ready');
    expect(res.data?.flow.current_phase).toBe('rfc');
    expect(res.data?.validation.ok).toBe(true);
  });

  it('submit_prd reports issues and stays in prd phase when sections are missing', async () => {
    const { call } = await setup();
    const start = await call<{ flow_id: string }>('start_flow', {
      project: 'checkout',
      initiative_type: 'feature',
      title: 'Half PRD',
    });
    const flow_id = start.data!.flow_id;
    const res = await call<{ flow: { status: string }; validation: { ok: boolean; issues: { section?: string }[] } }>(
      'submit_prd',
      {
        flow_id,
        prd_markdown: '# PRD\n\n## Problem\nuserless prd that has just a problem and nothing else',
        repo_path: '/docs/prd/half.md',
      },
    );
    expect(res.ok).toBe(false);
    expect(res.data?.flow.status).toBe('draft');
    const sections = res.data?.validation.issues.map((i) => i.section);
    expect(sections).toContain('users');
    expect(sections).toContain('success_metrics');
    expect(sections).toContain('out_of_scope');
    expect(sections).toContain('risks');
  });

  it('cannot submit RFC before PRD', async () => {
    const { call } = await setup();
    const start = await call<{ flow_id: string }>('start_flow', {
      project: 'checkout',
      initiative_type: 'feature',
      title: 'Sin PRD',
    });
    const res = await call('submit_rfc', {
      flow_id: start.data!.flow_id,
      rfc_markdown: VALID_RFC,
      repo_path: '/docs/rfc/sin-prd.md',
    });
    expect(res.ok).toBe(false);
    // La guarda ahora es sobre el status del flow (el PRD tiene que estar
    // aprobado, no sólo existir) y el mensaje nombra la salida ejecutable.
    expect(res.error).toMatch(/status "draft"/);
    expect(res.error).toMatch(/submit_prd/);
  });

  it('full PRD → RFC happy path advances through both phases', async () => {
    const { call } = await setup();
    const start = await call<{ flow_id: string }>('start_flow', {
      project: 'checkout',
      initiative_type: 'feature',
      title: 'Pago en cuotas',
    });
    const flow_id = start.data!.flow_id;
    await call('submit_prd', { flow_id, prd_markdown: VALID_PRD, repo_path: '/docs/prd/c.md' });

    const skeleton = await call<{ rfc_skeleton: string }>('generate_rfc_skeleton', { flow_id });
    expect(skeleton.ok).toBe(true);
    expect(skeleton.data?.rfc_skeleton).toMatch(/RFC: Pago en cuotas/);

    const submitted = await call<{ flow: { status: string; current_phase: string } }>('submit_rfc', {
      flow_id,
      rfc_markdown: VALID_RFC,
      repo_path: '/docs/rfc/cuotas.md',
    });
    expect(submitted.ok).toBe(true);
    expect(submitted.data?.flow.status).toBe('rfc_ready');
    expect(submitted.data?.flow.current_phase).toBe('shaping');

    const state = await call<{
      flow: {
        status: string;
        architecture_mode?: string;
        codebase_status?: string;
        existing_repo?: string;
      };
      recent_events: { type: string }[];
    }>('get_flow_state', { flow_id });
    expect(state.ok).toBe(true);
    expect(state.data?.flow.status).toBe('rfc_ready');
    expect(state.data?.flow.architecture_mode).toBe('reuse');
    expect(state.data?.flow.codebase_status).toBe('existing');
    expect(state.data?.flow.existing_repo).toBe('https://github.com/acme/checkout');
    const types = state.data?.recent_events.map((e) => e.type);
    expect(types).toContain('flow.started');
    expect(types).toContain('prd.submitted');
    expect(types).toContain('rfc.submitted');
  });

  it('submit_rfc fails validation when frontmatter is missing', async () => {
    const { call } = await setup();
    const start = await call<{ flow_id: string }>('start_flow', {
      project: 'checkout',
      initiative_type: 'feature',
      title: 'No frontmatter',
    });
    const flow_id = start.data!.flow_id;
    await call('submit_prd', { flow_id, prd_markdown: VALID_PRD, repo_path: '/docs/prd/c.md' });

    const rfcSinFrontmatter = VALID_RFC.replace(/^---[\s\S]*?---\n\n/, '');
    const res = await call<{ flow: { status: string }; validation: { ok: boolean; issues: { message: string }[] } }>(
      'submit_rfc',
      { flow_id, rfc_markdown: rfcSinFrontmatter, repo_path: '/docs/rfc/x.md' },
    );
    expect(res.ok).toBe(false);
    expect(res.data?.validation.issues.some((i) => i.message.includes('frontmatter'))).toBe(true);
    expect(res.data?.flow.status).toBe('prd_ready');
  });

  it('get_role_prompt with flow_id on an unclassified flow returns only base skills', async () => {
    const { call } = await setup();
    const start = await call<{ flow_id: string }>('start_flow', {
      project: 'checkout',
      initiative_type: 'feature',
      title: 'Unclassified',
    });
    const flow_id = start.data!.flow_id;
    const res = await call<{ skills: { id: string }[] }>('get_role_prompt', {
      role: 'developer',
      phase: 'implement',
      flow_id,
    });
    expect(res.ok).toBe(true);
    const ids = res.data?.skills.map((s) => s.id);
    expect(ids).toEqual(['skill-implementation-checklist']);
  });

  it('rejects flow access from another tenant', async () => {
    const { call, registry } = await setup();
    const start = await call<{ flow_id: string }>('start_flow', {
      project: 'checkout',
      initiative_type: 'feature',
      title: 'Tenant test',
    });
    const flow_id = start.data!.flow_id;

    // Con claim propio: el rechazo tiene que salir del chequeo de tenant, no de
    // la ausencia del claim `workspaces`.
    const otherTenant: TenantCtx = testCtx({
      tenantId: 'evil-tenant',
      userId: 'mallory',
      roles: ['product-manager'],
      workspaces: ['checkout'],
      async resolveSecret() {
        throw new Error('nope');
      },
    });
    const tool = registry.get('get_flow_state')!;
    const res = (await tool.handler({ flow_id }, otherTenant)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/different tenant/);
  });
});

describe('start_flow ya no acepta ruta de carpetas', () => {
  it('la ruta no es input de start_flow: sale del modelo al publicar', async () => {
    const store = new InMemoryFlowStore();
    const tool = makeStartFlowTool(store);
    // El rol es andamiaje: `start_flow` exige product-manager, tech-lead o pmo en el
    // workspace del `project`.
    const ctx: TenantCtx = testCtx({
      tenantId: 't2', userId: 'u', roles: ['product-manager'], workspaces: ['p1'],
      resolveSecret: async () => { throw new Error('not used'); },
    });

    const result = await tool.handler(
      { project: 'p1', title: 'Flow sin ruta', initiative_type: 'feature' },
      ctx,
    );

    expect(result.ok).toBe(true);
    // Un flow nuevo nace sin ruta: la fija el primer publish exitoso (ver submit_prd).
    expect((result as any).data.doc_folder_path).toBeUndefined();
  });

  it('tribu/squad ya no son entradas admitidas', async () => {
    const store = new InMemoryFlowStore();
    const tool = makeStartFlowTool(store);
    const ctx: TenantCtx = testCtx({
      tenantId: 't2', userId: 'u', roles: ['product-manager'], workspaces: ['p1'],
      resolveSecret: async () => { throw new Error('not used'); },
    });

    // Se pasan a propósito, como lo haría un cliente MCP viejo: el schema los ignora
    // y no vuelven en la respuesta. El punto es que no se persistan en ninguna forma.
    const result = await tool.handler(
      { project: 'p1', title: 'Flow legacy', tribu: 'Tribu-X', squad: 'Squad-Y' } as never,
      ctx,
    );

    expect(result.ok).toBe(true);
    const flow = (result as any).data;
    expect(flow.tribu).toBeUndefined();
    expect(flow.squad).toBeUndefined();
    expect(flow.doc_folder_path).toBeUndefined();
  });
});

describe('FlowStore doc_folder_path/adr extensions', () => {
  it('guarda doc_folder_path cuando se lo actualiza', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({
      tenant_id: 't1',
      project: 'p1',
      slug: 'folder-test',
      title: 'T',
    });

    const updated = await store.updateFlow(flow.flow_id, {
      doc_folder_path: ['Product', 'Platform'],
    });

    expect(updated.doc_folder_path).toEqual(['Product', 'Platform']);
  });

  it('adr_count increments when adr_refs are updated', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({
      tenant_id: 't1', project: 'p1', slug: 'adr-test', title: 'T',
    });
    const updated = await store.updateFlow(flow.flow_id, {
      adr_refs: [{ url: 'https://drive.example.com/file/1', external_id: 'file1' }],
      adr_count: 1,
    });
    expect(updated.adr_count).toBe(1);
    expect(updated.adr_refs).toHaveLength(1);
  });
});
