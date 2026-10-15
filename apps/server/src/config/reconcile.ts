import type { AdminStore } from '../admin/store.js';
import type { FileConfig } from './file-config.js';

/**
 * Reconciles the org structure (groups + workspaces) described in FileConfig
 * against what is currently in the AdminStore.
 *
 * - Creates missing groups (idempotent: checks via listGroups before create).
 * - Creates missing workspaces (idempotent: checks via getWorkspace before create).
 * - Reports "drift": workspace ids present in the store but absent from config.
 * - NEVER deletes anything.
 *
 * Safe to run on every boot.
 */
export async function reconcileStructure(
  store: AdminStore,
  cfg: FileConfig,
  log: { info(msg: string): void; warn(msg: string): void },
): Promise<{ created: string[]; drift: string[] }> {
  const created: string[] = [];

  // ── 1. Ensure groups exist ──────────────────────────────────────────────────
  const existingGroups = await store.listGroups();
  const existingGroupIds = new Set(existingGroups.map((g) => g.group_id));

  for (const group of cfg.groups ?? []) {
    if (!existingGroupIds.has(group.id)) {
      await store.createGroup({ group_id: group.id, name: group.name });
      log.info(`reconcile: created group "${group.id}"`);
      existingGroupIds.add(group.id);
    }
  }

  // ── 2. Ensure workspaces exist ──────────────────────────────────────────────
  for (const ws of cfg.workspaces ?? []) {
    const existing = await store.getWorkspace(ws.id);
    if (!existing) {
      await store.createWorkspace({
        workspace_id: ws.id,
        name: ws.name,
        ...(ws.group ? { group_id: ws.group } : {}),
      });
      log.info(`reconcile: created workspace "${ws.id}"`);
      created.push(ws.id);
    }
  }

  // ── 3. Detect drift ────────────────────────────────────────────────────────
  const cfgWorkspaceIds = new Set((cfg.workspaces ?? []).map((w) => w.id));
  const allStoreWorkspaces = await store.listWorkspaces();
  const drift: string[] = [];

  for (const sw of allStoreWorkspaces) {
    if (!cfgWorkspaceIds.has(sw.workspace_id)) {
      drift.push(sw.workspace_id);
      log.warn(`reconcile: drift detected — workspace "${sw.workspace_id}" exists in store but not in config`);
    }
  }

  return { created, drift };
}
