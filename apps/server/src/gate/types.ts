/**
 * Tipos del gate de repos habilitados (RFC sdlc-repo-onboarding, épica #5).
 *
 * Un lease es el permiso que el gate instalado en un repo valida contra el server
 * antes de dejar editar o commitear. Lo emite `claim_story` (kind `story`) o un
 * bypass humano (kind `bypass`). El secreto (`lease_id`) sólo viaja en la respuesta;
 * acá se guarda su sha256.
 */
export type GateLeaseKind = 'story' | 'bypass';

export interface GateLease {
  lease_hash: string;
  tenant_id: string;
  workspace_id: string;
  kind: GateLeaseKind;
  story_id: string | null;
  flow_id: string | null;
  user_id: string;
  /** Remote normalizado y branch: se fijan en el primer check (TOFU), no al emitir. */
  repo: string | null;
  branch: string | null;
  reason: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface IssueStoryLeaseInput {
  lease_hash: string;
  tenant_id: string;
  workspace_id: string;
  story_id: string;
  flow_id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
}

export interface GateStore {
  /**
   * Guarda un lease de story y revoca, en la misma operación, los leases activos de
   * esa story: hay un único lease vigente por story, así un re-claim invalida lo que
   * haya quedado en otra sesión o worktree.
   */
  issueStoryLease(input: IssueStoryLeaseInput): Promise<GateLease>;
  getLease(leaseHash: string): Promise<GateLease | undefined>;
}
