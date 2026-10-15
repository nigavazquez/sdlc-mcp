import type { AdminStore } from '../admin/store.js';

/**
 * Deriva la ruta de carpetas donde se publican los documentos de un flow, a partir
 * del modelo: el workspace dueño del flow y el group de ese workspace.
 *
 * Devuelve **nombres**, no ids, porque el adapter de Drive crea las carpetas por
 * nombre. Si el workspace no está registrado (típico en dev / in-memory, donde no
 * hay reconciliación) cae al id: el publish es no-fatal, pero igual conviene que
 * escriba en un lugar predecible en vez de tirar.
 */
export async function resolveDocFolderPath(opts: {
  adminStore: AdminStore;
  workspaceId: string;
}): Promise<string[]> {
  const { adminStore, workspaceId } = opts;

  const workspace = await adminStore.getWorkspace(workspaceId);
  if (!workspace) return [workspaceId];

  if (!workspace.group_id) return [workspace.name];

  const groups = await adminStore.listGroups();
  const group = groups.find((g) => g.group_id === workspace.group_id);

  return group ? [group.name, workspace.name] : [workspace.name];
}
