import { describe, expect, it, vi } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { makeSubmitPrdTool } from '../src/mcp/tools/submit-prd.js';
import { makeSubmitRfcTool } from '../src/mcp/tools/submit-rfc.js';
import { NoOpDocStoreAdapter } from '../src/adapters/doc-store-provider.js';
import type { DocStoreProvider } from '../src/adapters/doc-store-provider.js';
import { testCtx } from './helpers/tenant-ctx.js';

// El claim `workspaces` va explícito: las guardas de workspace ya no dejan pasar un ctx sin él.
//
// El rol es andamiaje: lo que se cubre acá es la interacción de submit_rfc con el doc
// store. El mismo ctx corre el submit_prd que deja el flow en `prd_ready` (requisito de
// submit_rfc), así que necesita los dos roles: `product-manager` para el PRD y
// `tech-lead` para el RFC.
const ctx: TenantCtx = testCtx({
  tenantId: 't1', userId: 'u', roles: ['product-manager', 'tech-lead'], workspaces: ['p1'],
  resolveSecret: async () => { throw new Error('not used'); },
});

// Minimal valid PRD (same as other tests)
const PRD = `# PRD\n\n## Problem\nP\n\n## Users\nU\n\n## Success Metrics\nM\n\n## Scope\nS\n\n## Out of Scope\nO\n\n## Risks\nR\n`;

// Valid RFC with all required sections (mirrors shaping.test.ts fixture)
const RFC = `---
architecture_mode: reuse
codebase_status: existing
existing_repo: https://github.com/acme/checkout
---

# RFC: Test RFC

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

describe('submit_rfc with DocStoreProvider', () => {
  it('stores Drive url in rfc_ref when docStore.publish returns a real DocRef (published:true)', async () => {
    const store = new InMemoryFlowStore();
    const noopProvider: DocStoreProvider = { resolve: async () => new NoOpDocStoreAdapter() };
    const flow = await store.createFlow({
      tenant_id: 't1', project: 'p1', slug: 'rfc-drive-test', title: 'RFC Drive',
    });
    // First submit PRD
    await makeSubmitPrdTool(store, noopProvider).handler(
      { flow_id: flow.flow_id, prd_markdown: PRD }, ctx,
    );

    const fakeRef = {
      id: 'rfc-md-id',
      url: 'https://docs.google.com/document/d/rfc-gdoc-id/edit',
      gdoc_id: 'rfc-gdoc-id',
    };
    const fakeAdapter = { kind: 'google-drive' as const, publish: vi.fn().mockResolvedValue(fakeRef), fetch: vi.fn() };
    const rfcProvider: DocStoreProvider = { resolve: vi.fn().mockResolvedValue(fakeAdapter) };

    const result = await makeSubmitRfcTool(store, rfcProvider).handler(
      { flow_id: flow.flow_id, rfc_markdown: RFC, repo_path: '/docs/rfc/test.md' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect((result as any).data.published).toBe(true);
    expect((result as any).data.flow.rfc_ref.url).toBe(fakeRef.url);             // Google Doc url
    expect((result as any).data.flow.rfc_ref.external_id).toBe(fakeRef.id);      // .md file id
    expect((result as any).data.flow.rfc_ref.gdoc_id).toBe(fakeRef.gdoc_id);     // Google Doc id
    expect(fakeAdapter.publish).toHaveBeenCalledWith(
      // Sin adminStore la ruta cae al workspace_id del flow, que es `flow.project`.
      expect.objectContaining({ doc_kind: 'rfc', folder_path: ['p1'] }),
      ctx,
    );
  });

  it('NoOp doc store → published:false, sha256+repo_path ref, status still advanced', async () => {
    const store = new InMemoryFlowStore();
    const noopProvider: DocStoreProvider = { resolve: async () => new NoOpDocStoreAdapter() };
    const flow = await store.createFlow({
      tenant_id: 't1', project: 'p1', slug: 'rfc-noop', title: 'RFC NoOp',
    });
    await makeSubmitPrdTool(store, noopProvider).handler(
      { flow_id: flow.flow_id, prd_markdown: PRD }, ctx,
    );

    const result = await makeSubmitRfcTool(store, noopProvider).handler(
      { flow_id: flow.flow_id, rfc_markdown: RFC, repo_path: '/docs/rfc/noop.md' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect((result as any).data.published).toBe(false);
    expect((result as any).data.flow.rfc_ref.sha256).toBeDefined();
    expect((result as any).data.flow.rfc_ref.repo_path).toBe('/docs/rfc/noop.md');
    expect((result as any).data.flow.rfc_ref.external_id).toBeUndefined();
    expect((result as any).data.flow.rfc_ref.gdoc_id).toBeUndefined();
    expect((result as any).data.flow.status).toBe('rfc_ready');
  });

  it('publish failure → published:false, sha256-only ref (no Drive fields), publish_error present, status still advanced', async () => {
    const store = new InMemoryFlowStore();
    const noopProvider: DocStoreProvider = { resolve: async () => new NoOpDocStoreAdapter() };
    const flow = await store.createFlow({
      tenant_id: 't1', project: 'p1', slug: 'rfc-fail', title: 'RFC Fail',
    });
    await makeSubmitPrdTool(store, noopProvider).handler(
      { flow_id: flow.flow_id, prd_markdown: PRD }, ctx,
    );

    const failingAdapter = {
      kind: 'google-drive' as const,
      publish: vi.fn().mockRejectedValue(new Error('Drive quota exceeded')),
      fetch: vi.fn(),
    };
    const failProvider: DocStoreProvider = { resolve: vi.fn().mockResolvedValue(failingAdapter) };

    const result = await makeSubmitRfcTool(store, failProvider).handler(
      { flow_id: flow.flow_id, rfc_markdown: RFC, repo_path: '/docs/rfc/fail.md' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect((result as any).data.published).toBe(false);
    expect((result as any).data.publish_error).toContain('Drive quota exceeded');
    expect((result as any).data.flow.rfc_ref.sha256).toBeDefined();
    expect((result as any).data.flow.rfc_ref.url).toBeUndefined();
    expect((result as any).data.flow.rfc_ref.external_id).toBeUndefined();
    expect((result as any).data.flow.rfc_ref.gdoc_id).toBeUndefined();
    expect((result as any).data.flow.status).toBe('rfc_ready');
  });
});
