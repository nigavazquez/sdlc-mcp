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

export interface IssueBypassLeaseInput {
  lease_hash: string;
  tenant_id: string;
  workspace_id: string;
  user_id: string;
  /** Un bypass nace atado a repo y branch: no hay TOFU. */
  repo: string;
  branch: string;
  reason: string;
  created_at: string;
  expires_at: string;
}

/** Conteos de `gate_events` de un workspace, desde una fecha. */
export interface GateEventCounts {
  commits_allowed_story: number;
  commits_allowed_bypass: number;
  commits_blocked: number;
  edits_blocked: number;
  bypasses: number;
}

export const GATE_EVENT_KINDS = [
  'commit.allowed',
  'commit.blocked',
  'edit.blocked',
  'bypass.created',
  'protected.blocked',
] as const;
export type GateEventKind = (typeof GATE_EVENT_KINDS)[number];

export interface GateEventRow {
  tenant_id: string;
  workspace_id: string;
  user_id: string;
  repo: string;
  branch: string | null;
  kind: GateEventKind;
  lease_kind: GateLeaseKind | null;
  story_id: string | null;
  reason: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface GateStore {
  /**
   * Guarda un lease de story y revoca, en la misma operación, los leases activos de
   * esa story: hay un único lease vigente por story, así un re-claim invalida lo que
   * haya quedado en otra sesión o worktree.
   */
  issueStoryLease(input: IssueStoryLeaseInput): Promise<GateLease>;
  getLease(leaseHash: string): Promise<GateLease | undefined>;
  /**
   * Ata el lease a repo y branch en el primer uso (TOFU) y renueva `expires_at`, en una
   * sola operación. Sólo toca un lease no revocado cuyo repo/branch estén vacíos o
   * coincidan; si no, no cambia nada y devuelve `undefined` (branch_mismatch).
   */
  bindAndRenew(
    leaseHash: string,
    binding: { repo: string; branch: string; expires_at: string },
  ): Promise<GateLease | undefined>;
  insertEvents(rows: GateEventRow[]): Promise<void>;
  /** Guarda el lease de bypass y su evento `bypass.created` en la misma operación. */
  issueBypassLease(input: IssueBypassLeaseInput, event: GateEventRow): Promise<GateLease>;
  countEvents(tenantId: string, workspaceId: string, since: string): Promise<GateEventCounts>;
}
