import { randomToken, sha256hex } from '../oauth/crypto.js';
import type { GateStore } from './types.js';

/** TTL de un lease de story. El check (#8) lo renueva en cada validación. */
export const STORY_LEASE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Secreto de 256 bits; el prefijo deja reconocerlo en un `lease.json` o en un log. */
export function newLeaseId(): string {
  return randomToken('gl_');
}

export function hashLeaseId(leaseId: string): string {
  return sha256hex(leaseId);
}

export interface GateLeaseGrant {
  lease_id: string;
  expires_at: string;
}

export interface StoryLeaseRequest {
  tenantId: string;
  workspaceId: string;
  storyId: string;
  flowId: string;
  userId: string;
}

/** Emite un lease de story: devuelve el secreto una sola vez y persiste sólo el hash. */
export async function issueStoryLease(
  store: GateStore,
  req: StoryLeaseRequest,
  now: Date = new Date(),
): Promise<GateLeaseGrant> {
  const leaseId = newLeaseId();
  const expiresAt = new Date(now.getTime() + STORY_LEASE_TTL_MS).toISOString();
  await store.issueStoryLease({
    lease_hash: hashLeaseId(leaseId),
    tenant_id: req.tenantId,
    workspace_id: req.workspaceId,
    story_id: req.storyId,
    flow_id: req.flowId,
    user_id: req.userId,
    created_at: now.toISOString(),
    expires_at: expiresAt,
  });
  return { lease_id: leaseId, expires_at: expiresAt };
}
