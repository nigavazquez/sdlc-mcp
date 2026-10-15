import { describe, expect, it } from 'vitest';
import { InMemoryAdminStore } from '../src/admin/in-memory.js';
import { resolveDocFolderPath } from '../src/docs/folder-path.js';

describe('resolveDocFolderPath', () => {
  it('workspace con group: [nombre del group, nombre del workspace]', async () => {
    const adminStore = new InMemoryAdminStore();
    await adminStore.createGroup({ group_id: 'product', name: 'Product' });
    await adminStore.createWorkspace({
      workspace_id: 'platform',
      name: 'Platform',
      group_id: 'product',
    });

    const path = await resolveDocFolderPath({ adminStore, workspaceId: 'platform' });

    expect(path).toEqual(['Product', 'Platform']);
  });

  it('workspace sin group: solo el nombre del workspace', async () => {
    const adminStore = new InMemoryAdminStore();
    await adminStore.createWorkspace({ workspace_id: 'platform', name: 'Platform' });

    const path = await resolveDocFolderPath({ adminStore, workspaceId: 'platform' });

    expect(path).toEqual(['Platform']);
  });

  it('workspace inexistente: cae al id, para no romper el publish en dev/in-memory', async () => {
    const adminStore = new InMemoryAdminStore();

    const path = await resolveDocFolderPath({ adminStore, workspaceId: 'no-existe' });

    expect(path).toEqual(['no-existe']);
  });

  it('group_id que no resuelve a ningún group: usa solo el workspace', async () => {
    const adminStore = new InMemoryAdminStore();
    await adminStore.createWorkspace({
      workspace_id: 'platform',
      name: 'Platform',
      group_id: 'borrado',
    });

    const path = await resolveDocFolderPath({ adminStore, workspaceId: 'platform' });

    expect(path).toEqual(['Platform']);
  });
});
