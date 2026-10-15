import { describe, expect, it, vi } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { makeSubmitAdrTool } from '../src/mcp/tools/submit-adr.js';
import { NoOpDocStoreAdapter } from '../src/adapters/doc-store-provider.js';
import type { DocStoreProvider } from '../src/adapters/doc-store-provider.js';
import { testCtx } from './helpers/tenant-ctx.js';

// El claim `workspaces` va explícito: las guardas de workspace ya no dejan pasar un ctx sin él.
//
// El rol es andamiaje: este archivo cubre el manejo del doc store en submit_adr (no-op
// rechazado, fallo de publish, numeración incremental), y `submit_adr` ahora exige
// `tech-lead` antes de resolver el adapter. Con `roles: []` los tests de "publish
// failure" y "resolve failure" seguían dando ok:false pero por la razón equivocada —el
// rechazo por rol— así que habrían pasado a verificar la guarda nueva en lugar del
// manejo de errores del doc store. La cobertura de la guarda de rol vive en
// `tools-role-guards.test.ts`.
const ctx: TenantCtx = testCtx({
  tenantId: 't1', userId: 'u', roles: ['tech-lead'], workspaces: ['p1'],
  resolveSecret: async () => { throw new Error('not used'); },
});

const ADR = `# ADR: Use PostgreSQL

## Status
Accepted

## Context
We need a relational database.

## Decision
We will use PostgreSQL.

## Consequences
Requires DBA expertise.
`;

describe('submit_adr', () => {
  it('publishes adr and increments adr_count on flow (happy path)', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({
      tenant_id: 't1', project: 'p1', slug: 'adr-flow', title: 'ADR flow',
    });

    const fakeRef = {
      id: 'adr-md-id',
      url: 'https://docs.google.com/document/d/adr-gdoc-id/edit',
      gdoc_id: 'adr-gdoc-id',
    };
    const fakeAdapter = { kind: 'google-drive' as const, publish: vi.fn().mockResolvedValue(fakeRef), fetch: vi.fn() };
    const provider: DocStoreProvider = { resolve: vi.fn().mockResolvedValue(fakeAdapter) };

    const tool = makeSubmitAdrTool(store, provider);
    const result = await tool.handler(
      { flow_id: flow.flow_id, title: 'Use Postgres', adr_markdown: ADR },
      ctx,
    );

    expect(result.ok).toBe(true);
    const updatedFlow = await store.getFlow(flow.flow_id);
    expect(updatedFlow?.adr_count).toBe(1);
    expect(updatedFlow?.adr_refs).toHaveLength(1);
    expect(updatedFlow?.adr_refs?.[0].url).toBe(fakeRef.url);              // Google Doc url
    expect(updatedFlow?.adr_refs?.[0].external_id).toBe(fakeRef.id);       // .md file id
    expect(updatedFlow?.adr_refs?.[0].gdoc_id).toBe(fakeRef.gdoc_id);      // Google Doc id

    expect(fakeAdapter.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        doc_kind: 'adr',
        adr_filename: '0001-use-postgres.md',
        folder_path: ['p1'],
      }),
      ctx,
    );
  });

  it('returns ok:false for unknown flow', async () => {
    const store = new InMemoryFlowStore();
    const provider: DocStoreProvider = { resolve: async () => new NoOpDocStoreAdapter() };
    const tool = makeSubmitAdrTool(store, provider);
    const result = await tool.handler({ flow_id: 'no-such-flow', title: 'T', adr_markdown: ADR }, ctx);
    expect(result.ok).toBe(false);
  });

  it('returns ok:false for wrong tenant', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({ tenant_id: 'other', project: 'p', slug: 's', title: 'T' });
    const provider: DocStoreProvider = { resolve: async () => new NoOpDocStoreAdapter() };
    const tool = makeSubmitAdrTool(store, provider);
    const result = await tool.handler({ flow_id: flow.flow_id, title: 'T', adr_markdown: ADR }, ctx);
    expect(result.ok).toBe(false);
  });

  it('NoOp doc store → returns ok:false (no phantom ADR)', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({ tenant_id: 't1', project: 'p1', slug: 'noop-adr', title: 'NoOp' });
    const provider: DocStoreProvider = { resolve: async () => new NoOpDocStoreAdapter() };
    const tool = makeSubmitAdrTool(store, provider);
    const result = await tool.handler({ flow_id: flow.flow_id, title: 'Noop ADR', adr_markdown: ADR }, ctx);

    expect(result.ok).toBe(false);
    // El mensaje pasó a castellano y ahora nombra la salida ejecutable: qué
    // configurar (doc_store en tenant_integrations) y qué tool reintentar.
    expect((result as any).error).toMatch(/no hay doc_store configurado/i);
    expect((result as any).error).toContain('tenant_integrations');
    expect((result as any).error).toContain('submit_adr');

    // adr_count must NOT have been incremented and adr_refs must be unchanged
    const unchanged = await store.getFlow(flow.flow_id);
    expect(unchanged?.adr_count).toBe(0);
    expect(unchanged?.adr_refs ?? []).toHaveLength(0);
  });

  it('publish failure → returns ok:false, adr_count NOT incremented, adr_refs unchanged', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({ tenant_id: 't1', project: 'p1', slug: 'fail-adr', title: 'Fail' });

    const failingAdapter = {
      kind: 'google-drive' as const,
      publish: vi.fn().mockRejectedValue(new Error('Drive quota exceeded')),
      fetch: vi.fn(),
    };
    const provider: DocStoreProvider = { resolve: vi.fn().mockResolvedValue(failingAdapter) };

    const tool = makeSubmitAdrTool(store, provider);
    const result = await tool.handler({ flow_id: flow.flow_id, title: 'Fail ADR', adr_markdown: ADR }, ctx);

    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/ADR publish failed/i);
    expect((result as any).error).toContain('Drive quota exceeded');

    // adr_count must NOT have been incremented and adr_refs must be unchanged
    const unchanged = await store.getFlow(flow.flow_id);
    expect(unchanged?.adr_count).toBe(0);
    expect(unchanged?.adr_refs ?? []).toHaveLength(0);
  });

  it('resolve failure → returns ok:false, adr_count NOT incremented', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({ tenant_id: 't1', project: 'p1', slug: 'resolve-fail', title: 'R' });

    const provider: DocStoreProvider = {
      resolve: vi.fn().mockRejectedValue(new Error('secret_ref not configured')),
    };

    const tool = makeSubmitAdrTool(store, provider);
    const result = await tool.handler({ flow_id: flow.flow_id, title: 'Fail ADR', adr_markdown: ADR }, ctx);

    expect(result.ok).toBe(false);
    expect((result as any).error).toMatch(/ADR publish failed/i);

    const unchanged = await store.getFlow(flow.flow_id);
    expect(unchanged?.adr_count).toBe(0);
  });

  it('second submit increments counter to 2 (with real adapter)', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({ tenant_id: 't1', project: 'p1', slug: 'adr2', title: 'T' });

    const makeRef = (n: number) => ({ id: `id-${n}`, url: `https://drive/${n}`, gdoc_id: `gdoc-${n}` });
    const fakeAdapter = {
      kind: 'google-drive' as const,
      publish: vi.fn()
        .mockResolvedValueOnce(makeRef(1))
        .mockResolvedValueOnce(makeRef(2)),
      fetch: vi.fn(),
    };
    const provider: DocStoreProvider = { resolve: vi.fn().mockResolvedValue(fakeAdapter) };
    const tool = makeSubmitAdrTool(store, provider);

    await tool.handler({ flow_id: flow.flow_id, title: 'First', adr_markdown: ADR }, ctx);
    await tool.handler({ flow_id: flow.flow_id, title: 'Second', adr_markdown: ADR }, ctx);
    const updated = await store.getFlow(flow.flow_id);
    expect(updated?.adr_count).toBe(2);
    expect(updated?.adr_refs).toHaveLength(2);
  });
});
