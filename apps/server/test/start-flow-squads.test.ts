import { describe, expect, it } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { InMemoryFlowStore } from '../src/state/index.js';
import { makeStartFlowTool } from '../src/mcp/tools/start-flow.js';
import { testCtx } from './helpers/tenant-ctx.js';

// El claim `workspaces` va explícito: las guardas de workspace ya no dejan pasar un ctx sin él.
// Los tests que prueban la guarda lo sobreescriben con `ctx({ workspaces: ... })`.
function ctx(overrides: Partial<TenantCtx> = {}): TenantCtx {
  return {
    ...testCtx({
      tenantId: 'default',
      userId: 'alice',
      roles: ['product-manager'],
      workspaces: ['platform'],
      async resolveSecret() {
        throw new Error('not used');
      },
    }),
    ...overrides,
  };
}

describe('start_flow — initiative_type + workspace access', () => {
  it('persiste initiative_type en el flow', async () => {
    const store = new InMemoryFlowStore();
    const tool = makeStartFlowTool(store);
    const res = (await tool.handler(
      { project: 'platform', title: 'Nueva iniciativa', initiative_type: 'refactor' },
      ctx(),
    )) as { ok: boolean; data?: { flow_id: string; initiative_type?: string } };
    expect(res.ok).toBe(true);
    expect(res.data?.initiative_type).toBe('refactor');
    const flow = await store.getFlow(res.data!.flow_id);
    expect(flow?.initiative_type).toBe('refactor');
  });

  it('workspace ajeno (ctx.workspaces presente) → ok:false con error que nombra el workspace', async () => {
    const store = new InMemoryFlowStore();
    const tool = makeStartFlowTool(store);
    const res = (await tool.handler(
      { project: 'other-workspace', title: 'Ajena', initiative_type: 'feature' },
      ctx({ workspaces: { platform: ['product-manager'] } }),
    )) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toContain('other-workspace');
  });

  it('con membresía en el workspace del project → pasa', async () => {
    const store = new InMemoryFlowStore();
    const tool = makeStartFlowTool(store);
    const res = (await tool.handler(
      { project: 'platform', title: 'Propia', initiative_type: 'fix' },
      ctx({ workspaces: { platform: ['product-manager'] } }),
    )) as { ok: boolean };
    expect(res.ok).toBe(true);
  });
});

describe('start_flow — quién abre según el track', () => {
  const dev = () =>
    testCtx({ tenantId: 'default', userId: 'nico', roles: ['developer'], workspaces: ['platform'] });

  it.each(['fix', 'improvement'])(
    'un developer abre un flow de tipo %s: el track liviano arranca donde aparece el bug',
    async (initiative_type) => {
      const store = new InMemoryFlowStore();
      const res = (await makeStartFlowTool(store).handler(
        { project: 'platform', title: 'El claim no llega en el refresh', initiative_type },
        dev(),
      )) as { ok: boolean; error?: string };

      expect(res.ok).toBe(true);
    },
  );

  it.each(['feature', 'refactor'])(
    'un developer no abre un flow de tipo %s: ese va por PRD y no es su fase',
    async (initiative_type) => {
      const store = new InMemoryFlowStore();
      const res = (await makeStartFlowTool(store).handler(
        { project: 'platform', title: 'Iniciativa grande', initiative_type },
        dev(),
      )) as { ok: boolean; error?: string };

      expect(res.ok).toBe(false);
      expect(res.error).toContain('start_flow requiere rol');
    },
  );

  it('los tres roles de siempre siguen abriendo cualquier tipo', async () => {
    const store = new InMemoryFlowStore();
    for (const rol of ['product-manager', 'tech-lead', 'pmo'] as const) {
      const res = (await makeStartFlowTool(store).handler(
        { project: 'platform', title: `Iniciativa de ${rol}`, initiative_type: 'feature' },
        testCtx({ tenantId: 'default', userId: rol, roles: [rol], workspaces: ['platform'] }),
      )) as { ok: boolean };
      expect(res.ok).toBe(true);
    }
  });
});
