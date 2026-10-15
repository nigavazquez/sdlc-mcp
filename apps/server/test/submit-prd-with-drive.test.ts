import { describe, expect, it, vi } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { Flow } from '@sdlc/core';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { makeSubmitPrdTool } from '../src/mcp/tools/submit-prd.js';
import type { DocStoreProvider } from '../src/adapters/doc-store-provider.js';
import { NoOpDocStoreAdapter } from '../src/adapters/doc-store-provider.js';
import { InMemoryAdminStore } from '../src/admin/in-memory.js';
import { testCtx } from './helpers/tenant-ctx.js';

// El claim `workspaces` va explícito: las guardas de workspace ya no dejan pasar un ctx sin él.
//
// El rol es andamiaje: lo que se cubre acá es la interacción de submit_prd con el doc
// store (qué campos de Drive quedan en `prd_ref`, published true/false, publish_error), y
// `submit_prd` exige `product-manager` para llegar hasta ahí.
const ctx: TenantCtx = testCtx({
  tenantId: 't1', userId: 'u', roles: ['product-manager'], workspaces: ['p1'],
  resolveSecret: async () => { throw new Error('not used'); },
});

// Los tests de derivación usan flows del workspace `platform`, así que el claim
// tiene que nombrarlo: la guarda de workspace corre antes del publish.
const platformCtx: TenantCtx = testCtx({
  tenantId: 't1', userId: 'u', roles: ['product-manager'], workspaces: ['platform'],
  resolveSecret: async () => { throw new Error('not used'); },
});

// Minimal valid PRD markdown (satisfies validatePrd)
const PRD = `# PRD

## Problem
Users cannot pay in installments on checkout.

## Users
Online shoppers in LATAM.

## Success Metrics
- Conversion +5 %

## Scope
Installments via Cuota-API.

## Out of Scope
Debit card flows.

## Risks
- Cuota-API downtime risk.
`;

describe('submit_prd with DocStoreProvider', () => {
  it('stores Drive url in prd_ref when docStore.publish returns a real DocRef (published:true)', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({
      tenant_id: 't1', project: 'p1', slug: 'drive-test', title: 'Drive test',
    });

    // DocRef carries both: url=Google Doc, id=.md file, gdoc_id=Google Doc id
    const fakeRef = {
      id: 'md-file-id',
      url: 'https://docs.google.com/document/d/gdoc-id/edit',
      gdoc_id: 'gdoc-id',
      gdoc_url: 'https://docs.google.com/document/d/gdoc-id/edit',
      md_url: 'https://drive.google.com/file/md-file-id',
    };
    const fakeAdapter = { kind: 'google-drive' as const, publish: vi.fn().mockResolvedValue(fakeRef), fetch: vi.fn() };
    const docStoreProvider: DocStoreProvider = {
      resolve: vi.fn().mockResolvedValue(fakeAdapter),
    };

    const tool = makeSubmitPrdTool(store, docStoreProvider);
    const result = await tool.handler(
      { flow_id: flow.flow_id, prd_markdown: PRD },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect((result as any).data.published).toBe(true);
    expect((result as any).data.flow.prd_ref.url).toBe(fakeRef.url);          // Google Doc url
    expect((result as any).data.flow.prd_ref.external_id).toBe(fakeRef.id);   // .md file id
    expect((result as any).data.flow.prd_ref.gdoc_id).toBe(fakeRef.gdoc_id);  // Google Doc id
    expect(fakeAdapter.publish).toHaveBeenCalledWith(
      // Sin adminStore la ruta cae al workspace_id del flow, que es `flow.project`.
      expect.objectContaining({ doc_kind: 'prd', folder_path: ['p1'] }),
      ctx,
    );
  });

  it('still succeeds (sha256 stored) when docStoreProvider returns NoOp (published:false)', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({
      tenant_id: 't1', project: 'p1', slug: 'noop-test', title: 'Noop',
    });
    const docStoreProvider: DocStoreProvider = {
      resolve: vi.fn().mockResolvedValue(new NoOpDocStoreAdapter()),
    };
    const tool = makeSubmitPrdTool(store, docStoreProvider);
    const result = await tool.handler({ flow_id: flow.flow_id, prd_markdown: PRD }, ctx);

    expect(result.ok).toBe(true);
    expect((result as any).data.published).toBe(false);
    expect((result as any).data.flow.prd_ref.sha256).toBeDefined();
    // On NoOp, no Drive fields should be written into the ref
    expect((result as any).data.flow.prd_ref.external_id).toBeUndefined();
    expect((result as any).data.flow.prd_ref.gdoc_id).toBeUndefined();
  });

  it('publish failure → published:false, sha256-only ref, publish_error present, status still advanced', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({
      tenant_id: 't1', project: 'p1', slug: 'fail-prd', title: 'Fail',
    });

    const failingAdapter = {
      kind: 'google-drive' as const,
      publish: vi.fn().mockRejectedValue(new Error('Drive quota exceeded')),
      fetch: vi.fn(),
    };
    const docStoreProvider: DocStoreProvider = { resolve: vi.fn().mockResolvedValue(failingAdapter) };

    const tool = makeSubmitPrdTool(store, docStoreProvider);
    const result = await tool.handler({ flow_id: flow.flow_id, prd_markdown: PRD }, ctx);

    expect(result.ok).toBe(true); // validation still passes
    expect((result as any).data.published).toBe(false);
    expect((result as any).data.publish_error).toContain('Drive quota exceeded');
    // sha256-only ref — no Drive fields
    expect((result as any).data.flow.prd_ref.sha256).toBeDefined();
    expect((result as any).data.flow.prd_ref.url).toBeUndefined();
    expect((result as any).data.flow.prd_ref.external_id).toBeUndefined();
    expect((result as any).data.flow.prd_ref.gdoc_id).toBeUndefined();
    // Status should still advance
    expect((result as any).data.flow.status).toBe('prd_ready');
  });
  it('deriva folder_path del modelo y fija la ruta en el primer publish', async () => {
    const store = new InMemoryFlowStore();
    const adminStore = new InMemoryAdminStore();
    await adminStore.createGroup({ group_id: 'product', name: 'Product' });
    await adminStore.createWorkspace({
      workspace_id: 'platform',
      name: 'Platform',
      group_id: 'product',
    });
    const flow = await store.createFlow({
      tenant_id: 't1', project: 'platform', slug: 'derive-test', title: 'Derive',
    });

    const fakeAdapter = {
      kind: 'google-drive' as const,
      publish: vi.fn().mockResolvedValue({ id: 'md-1', url: 'https://docs.example.com/1' }),
      fetch: vi.fn(),
    };
    const docStoreProvider: DocStoreProvider = {
      resolve: vi.fn().mockResolvedValue(fakeAdapter),
    };

    const tool = makeSubmitPrdTool(store, docStoreProvider, adminStore);
    const result = await tool.handler({ flow_id: flow.flow_id, prd_markdown: PRD }, platformCtx);

    expect(result.ok).toBe(true);
    expect(fakeAdapter.publish).toHaveBeenCalledWith(
      expect.objectContaining({ folder_path: ['Product', 'Platform'] }),
      platformCtx,
    );
    // El primer publish exitoso deja la ruta fijada, para que un rename posterior
    // del workspace no parta los documentos del flow en dos carpetas.
    expect((result as any).data.flow.doc_folder_path).toEqual(['Product', 'Platform']);
  });

  it('respeta la ruta histórica del flow en vez de re-derivarla', async () => {
    const store = new InMemoryFlowStore();
    const adminStore = new InMemoryAdminStore();
    await adminStore.createWorkspace({ workspace_id: 'platform', name: 'Platform' });
    const flow = await store.createFlow({
      tenant_id: 't1', project: 'platform', slug: 'legacy-test', title: 'Legacy',
    });
    // Ruta heredada del modelo viejo, como la dejó el backfill de la migración 0011.
    await store.updateFlow(flow.flow_id, { doc_folder_path: ['Tribu-A', 'Squad-B'] });

    const fakeAdapter = {
      kind: 'google-drive' as const,
      publish: vi.fn().mockResolvedValue({ id: 'md-2', url: 'https://docs.example.com/2' }),
      fetch: vi.fn(),
    };
    const docStoreProvider: DocStoreProvider = {
      resolve: vi.fn().mockResolvedValue(fakeAdapter),
    };

    const tool = makeSubmitPrdTool(store, docStoreProvider, adminStore);
    const result = await tool.handler({ flow_id: flow.flow_id, prd_markdown: PRD }, platformCtx);

    expect(fakeAdapter.publish).toHaveBeenCalledWith(
      expect.objectContaining({ folder_path: ['Tribu-A', 'Squad-B'] }),
      platformCtx,
    );
    // Y la ruta histórica no se pisa con la derivada.
    expect((result as any).data.flow.doc_folder_path).toEqual(['Tribu-A', 'Squad-B']);
  });

  it('un publish que falla no fija la ruta: no hay documento en esa carpeta', async () => {
    const store = new InMemoryFlowStore();
    const adminStore = new InMemoryAdminStore();
    await adminStore.createWorkspace({ workspace_id: 'platform', name: 'Platform' });
    const flow = await store.createFlow({
      tenant_id: 't1', project: 'platform', slug: 'fail-derive', title: 'Fail derive',
    });

    const failingAdapter = {
      kind: 'google-drive' as const,
      publish: vi.fn().mockRejectedValue(new Error('Drive quota exceeded')),
      fetch: vi.fn(),
    };
    const docStoreProvider: DocStoreProvider = {
      resolve: vi.fn().mockResolvedValue(failingAdapter),
    };

    const tool = makeSubmitPrdTool(store, docStoreProvider, adminStore);
    const result = await tool.handler({ flow_id: flow.flow_id, prd_markdown: PRD }, platformCtx);

    expect(result.ok).toBe(true);
    expect((result as any).data.published).toBe(false);
    // Fijar la ruta sin documento publicado ataría el flow a una carpeta vacía y
    // dejaría de derivar para siempre.
    expect((result as any).data.flow.doc_folder_path).toBeUndefined();
  });
});
