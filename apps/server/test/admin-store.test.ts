import { describe, expect, it } from 'vitest';
import { InMemoryAdminStore } from '../src/admin/in-memory.js';

describe('InMemoryAdminStore (workspaces)', () => {
  it('empieza vacío, crea y lista workspaces; rechaza duplicados', async () => {
    const s = new InMemoryAdminStore();
    expect(await s.listWorkspaces()).toEqual([]);

    const ws = await s.createWorkspace({ workspace_id: 'platform', name: 'Platform' });
    expect(ws.workspace_id).toBe('platform');
    expect((await s.listWorkspaces()).map((x) => x.workspace_id)).toEqual(['platform']);
    expect((await s.getWorkspace('platform'))?.name).toBe('Platform');

    await expect(s.createWorkspace({ workspace_id: 'platform', name: 'dup' })).rejects.toThrow(/exists/);
  });

  it('getWorkspace devuelve undefined para un workspace inexistente', async () => {
    const s = new InMemoryAdminStore();
    expect(await s.getWorkspace('nope')).toBeUndefined();
  });

  it('lista y crea groups, y un workspace puede referenciar uno', async () => {
    const store = new InMemoryAdminStore();
    await store.createGroup({ group_id: 'tribe-a', name: 'Tribe A' });
    const ws = await store.createWorkspace({ workspace_id: 'w1', name: 'W1', group_id: 'tribe-a' });
    expect(ws.group_id).toBe('tribe-a');
    expect((await store.listGroups()).map((g) => g.group_id)).toContain('tribe-a');
  });

  it('createGroup rechaza group_id duplicado', async () => {
    const store = new InMemoryAdminStore();
    await store.createGroup({ group_id: 'tribe-a', name: 'Tribe A' });
    await expect(store.createGroup({ group_id: 'tribe-a', name: 'dup' })).rejects.toThrow(/exists/);
  });
});
