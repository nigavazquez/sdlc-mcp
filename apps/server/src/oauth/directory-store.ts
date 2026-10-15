export interface Membership {
  email: string;
  workspace_id: string;
  roles: string[];
  created_at: string;
}

/**
 * Directorio de membresías N:M email ↔ workspace administrado desde el panel. Es la fuente
 * de autorización del login MCP: sin al menos una membresía, la cuenta Google no entra.
 * Una persona puede aportar a varios workspaces, con roles distintos en cada uno.
 */
export interface DirectoryStore {
  /** Todas las membresías de una persona (0..N workspaces). */
  listMemberships(email: string): Promise<Membership[]>;
  /** Miembros de un workspace. */
  listMembers(workspaceId: string): Promise<Membership[]>;
  /** Alta/actualización de la membresía puntual (email, workspace_id). */
  upsertMember(input: { email: string; workspace_id: string; roles: string[] }): Promise<Membership>;
  /** Baja de la membresía puntual (email, workspace_id). */
  removeMember(email: string, workspaceId: string): Promise<boolean>;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
