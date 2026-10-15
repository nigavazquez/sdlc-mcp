/**
 * Seam test: verify that calling create_epic through the tool registry, when the
 * flow's (tenant, project) is configured for azure-devops, drives the provider
 * through the credential path (resolveSecret is called) before surfacing
 * NotImplementedError.
 *
 * All tool tests in shaping.test.ts use an empty InMemoryIntegrationConfigStore,
 * so they always resolve to the in-memory adapter — the azure-devops branch is
 * never exercised through a tool. This test closes that gap.
 */
import { resolve } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { Catalog } from '@sdlc/catalog';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { InMemoryFlowStore } from '../src/state/index.js';
import { InMemoryTaskSystemAdapter, ConfigBackedTaskSystemProvider } from '../src/adapters/index.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import { buildToolRegistry } from '../src/mcp/tools/index.js';
import { testCtx } from './helpers/tenant-ctx.js';

const CATALOG_ROOT = resolve(__dirname, '../../../packages/catalog');

// Reuse the same PRD/RFC fixtures from shaping.test.ts so the flow passes
// validation gates on submit_prd → submit_rfc.
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

const PRD = `# PRD\n\n## Problem\nx problem here long enough to pass\n\n## Users\n- u\n\n## Success Metrics\n| m | b | t | p |\n\n## Scope\n- s\n\n## Out of Scope\n- o\n\n## Risks\n| r | p | i | m |`;

const TENANT_ID = 'demo-tenant';
const PROJECT = 'checkout';
const SECRET_REF = 'aws-sm://ado-pat#token';

describe('tool → provider azure-devops seam', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolveSecret is called and create_epic succeeds via real adapter', async () => {
    // 1. Build a seeded config store so that (TENANT_ID, PROJECT) → azure-devops.
    const configStore = new InMemoryIntegrationConfigStore();
    configStore.seed(TENANT_ID, PROJECT, {
      task_system: {
        kind: 'azure-devops',
        secret_ref: SECRET_REF,
        settings: { org: 'acme', project: PROJECT },
      },
    });

    const catalog = await Catalog.load(CATALOG_ROOT);
    const store = new InMemoryFlowStore();
    const taskSystem = new InMemoryTaskSystemAdapter();
    const taskSystemProvider = new ConfigBackedTaskSystemProvider({
      configStore,
      inMemory: taskSystem,
    });
    const registry = buildToolRegistry({ catalog, store, taskSystemProvider });

    // 2. Build a ctx whose resolveSecret is a spy that records refs.
    const resolvedRefs: string[] = [];
    // El claim `workspaces` va explícito: las guardas de workspace ya no dejan pasar un ctx sin él.
    //
    // Los roles son andamiaje: lo que se verifica es que `create_epic` llegue al adapter
    // real y resuelva el secreto. Un solo ctx conduce todo el camino hasta `rfc_ready`, así
    // que necesita los roles de los cuatro pasos: product-manager (start_flow, submit_prd),
    // tech-lead (submit_rfc) y pmo (create_epic).
    const ctx: TenantCtx = testCtx({
      tenantId: TENANT_ID,
      userId: 'pat',
      roles: ['product-manager', 'tech-lead', 'pmo'],
      workspaces: [PROJECT],
      async resolveSecret(ref: string) {
        resolvedRefs.push(ref);
        return 'dummy-secret';
      },
    });

    // Helper to invoke a tool through the registry (mirrors shaping.test.ts's call helper).
    const call = async <T>(name: string, input: unknown): Promise<{ ok: boolean; data?: T; error?: string }> => {
      const tool = registry.get(name);
      if (!tool) throw new Error(`Unknown tool ${name}`);
      const parsed = tool.inputSchema.parse(input ?? {});
      return (await tool.handler(parsed, ctx)) as never;
    };

    // 3. Drive the flow to rfc_ready using the SAME tenant + project that was seeded.
    // Cada paso del andamiaje se assertea: si mañana cambia una guarda, el test dice cuál
    // paso se rompió en vez de fallar más adelante con "flow status is draft".
    const start = await call<{ flow_id: string }>('start_flow', { project: PROJECT, title: 'Pago en cuotas', initiative_type: 'feature' });
    expect(start.ok, `start_flow falló: ${start.error}`).toBe(true);
    const flow_id = (start.data as { flow_id: string }).flow_id;
    const prd = await call('submit_prd', { flow_id, prd_markdown: PRD, repo_path: '/docs/prd/c.md' });
    expect(prd.ok, `submit_prd falló: ${prd.error}`).toBe(true);
    const rfc = await call('submit_rfc', { flow_id, rfc_markdown: RFC, repo_path: '/docs/rfc/c.md' });
    expect(rfc.ok, `submit_rfc falló: ${rfc.error}`).toBe(true);

    // 4 & 5. Stub fetch so the adapter does not make a real network call, then
    //         call create_epic — must succeed (ok: true) now that the real adapter
    //         is wired in, and resolveSecret must have been called.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 99,
            url: 'https://dev.azure.com/acme/_apis/wit/workItems/99',
            fields: { 'System.Title': 'Cuotas', 'System.WorkItemType': 'Epic', 'System.State': 'New', 'System.Tags': '' },
            relations: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const epicResult = await registry.get('create_epic')!.handler(
      { flow_id, epic: { title: 'Cuotas', description: 'desc' } },
      ctx,
    );
    expect((epicResult as { ok: boolean }).ok).toBe(true);
    // The secret was resolved:
    expect(resolvedRefs).toEqual([SECRET_REF]);
  });
});
