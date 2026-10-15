import { describe, expect, it } from 'vitest';
import { InMemoryAdminStore } from '../src/admin/in-memory.js';
import { reconcileStructure } from '../src/config/reconcile.js';

describe('reconcileStructure', () => {
  it('crea workspaces/groups faltantes y reporta drift sin borrar', async () => {
    const store = new InMemoryAdminStore();
    await store.createWorkspace({ workspace_id: 'legacy', name: 'Legacy' });
    const res = await reconcileStructure(store, {
      tenantId: 'default', adminEmails: [], groups: [{ id: 'g', name: 'G' }],
      workspaces: [{ id: 'revenue', name: 'Revenue', group: 'g' }],
      labels: { workspace: { singular: 'workspace', plural: 'workspaces' }, group: { singular: 'group', plural: 'groups' } },
    } as any, { info() {}, warn() {} } as any);
    expect(res.created).toContain('revenue');
    expect(res.drift).toContain('legacy');           // presente en store, ausente en config
    expect(await store.getWorkspace('legacy')).toBeDefined(); // NO se borró
  });

  it('es idempotente: no crea duplicados en una segunda llamada', async () => {
    const store = new InMemoryAdminStore();
    const cfg = {
      tenantId: 'default', adminEmails: [],
      groups: [{ id: 'g1', name: 'G1' }],
      workspaces: [{ id: 'ws1', name: 'WS1', group: 'g1' }],
      labels: { workspace: { singular: 'workspace', plural: 'workspaces' }, group: { singular: 'group', plural: 'groups' } },
    } as any;

    const log = { info() {}, warn() {} } as any;
    const first = await reconcileStructure(store, cfg, log);
    const second = await reconcileStructure(store, cfg, log);

    expect(first.created).toContain('ws1');
    expect(second.created).toHaveLength(0); // ya existía
    expect(second.drift).toHaveLength(0);
  });

  it('reporta drift sólo para workspaces ausentes del config', async () => {
    const store = new InMemoryAdminStore();
    await store.createWorkspace({ workspace_id: 'old-ws', name: 'Old' });
    await store.createWorkspace({ workspace_id: 'new-ws', name: 'New' });

    const cfg = {
      tenantId: 'default', adminEmails: [],
      groups: [],
      workspaces: [{ id: 'new-ws', name: 'New' }], // sólo new-ws en config
      labels: { workspace: { singular: 'workspace', plural: 'workspaces' }, group: { singular: 'group', plural: 'groups' } },
    } as any;

    const warnCalls: string[] = [];
    const log = { info() {}, warn(msg: string) { warnCalls.push(msg); } } as any;
    const res = await reconcileStructure(store, cfg, log);

    expect(res.drift).toContain('old-ws');
    expect(res.drift).not.toContain('new-ws');
    expect(warnCalls.some(m => m.includes('old-ws'))).toBe(true);
    // old-ws sigue existiendo (no se borró)
    expect(await store.getWorkspace('old-ws')).toBeDefined();
  });

  it('crea el grupo antes que el workspace que lo referencia', async () => {
    const store = new InMemoryAdminStore();
    const cfg = {
      tenantId: 'default', adminEmails: [],
      groups: [{ id: 'grp', name: 'Grp' }],
      workspaces: [{ id: 'ws-a', name: 'WS-A', group: 'grp' }],
      labels: { workspace: { singular: 'workspace', plural: 'workspaces' }, group: { singular: 'group', plural: 'groups' } },
    } as any;

    await reconcileStructure(store, cfg, { info() {}, warn() {} } as any);

    const groups = await store.listGroups();
    expect(groups.some(g => g.group_id === 'grp')).toBe(true);

    const ws = await store.getWorkspace('ws-a');
    expect(ws?.group_id).toBe('grp');
  });
});
