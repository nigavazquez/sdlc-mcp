import type { AdminStore } from './store.js';

/**
 * Default de producto (PRD self-qa-single-member): cada persona puede ser un equipo
 * completo, así que la firma propia de QA y review está permitida salvo que un admin la
 * desactive en el workspace.
 */
export const SELF_SIGNOFF_DEFAULT = true;

/**
 * Valor de `self_signoff` de un workspace. Sin AdminStore (registries mínimos de tests) o
 * sin registro del workspace (dev in-memory) vale el default. Un error del store se
 * propaga: quien decide una firma (la política de #23) tiene que fallar cerrado.
 */
export async function workspaceSelfSignoff(
  adminStore: AdminStore | undefined,
  workspaceId: string,
): Promise<boolean> {
  if (!adminStore) return SELF_SIGNOFF_DEFAULT;
  const ws = await adminStore.getWorkspace(workspaceId);
  return ws ? ws.self_signoff : SELF_SIGNOFF_DEFAULT;
}
