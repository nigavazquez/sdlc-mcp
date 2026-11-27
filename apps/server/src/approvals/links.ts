import { createHash, randomBytes } from 'node:crypto';
import {
  OWNER_ROLE,
  approvalRefsOf,
  type ApprovalArtifact,
  type Flow,
} from '@sdlc/core';
import type { FlowStore } from '../state/index.js';

/** Vencimiento de un link de aprobación (RFC aprobacion-de-fases, pregunta abierta: 7 días). */
export const APPROVAL_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Lo que devuelven submit_prd, submit_rfc y request_approval. El token sólo está en `url`. */
export interface ApprovalLink {
  status: 'pending';
  artifact: ApprovalArtifact;
  url: string;
  owner_role: (typeof OWNER_ROLE)[ApprovalArtifact];
  expires_at: string;
}

/** sha256 del token: es lo único que se guarda. */
export function hashApprovalToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Emite un link de aprobación de un solo uso para la versión **actual** del
 * artefacto. 32 bytes aleatorios en base64url; la base guarda sólo su hash, así
 * que quien lea la tabla no puede armar el link. No aprueba nada: aprobar es una
 * sesión web en `/approve/{token}` (historia A4).
 */
export async function issueApprovalLink(opts: {
  store: FlowStore;
  flow: Flow;
  artifact: ApprovalArtifact;
  requestedBy: string;
  publicUrl: string | undefined;
  now?: Date;
}): Promise<ApprovalLink> {
  const sha256 = approvalRefsOf(opts.flow)[opts.artifact];
  if (!sha256) throw new Error(`El flow no tiene ${opts.artifact} para aprobar.`);
  const token = randomBytes(32).toString('base64url');
  const now = opts.now ?? new Date();
  const expires_at = new Date(now.getTime() + APPROVAL_LINK_TTL_MS).toISOString();
  await opts.store.createApprovalRequest({
    token_hash: hashApprovalToken(token),
    tenant_id: opts.flow.tenant_id,
    flow_id: opts.flow.flow_id,
    artifact: opts.artifact,
    sha256,
    requested_by: opts.requestedBy,
    expires_at,
  });
  await opts.store.appendEvent({
    flow_id: opts.flow.flow_id,
    type: 'approval.requested',
    actor: opts.requestedBy,
    payload: { artifact: opts.artifact, sha256, expires_at },
  });
  const base = (opts.publicUrl ?? '').replace(/\/+$/, '');
  return {
    status: 'pending',
    artifact: opts.artifact,
    url: `${base}/approve/${token}`,
    owner_role: OWNER_ROLE[opts.artifact],
    expires_at,
  };
}
