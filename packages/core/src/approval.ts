import { z } from 'zod';
import type { Flow } from './flow.js';

/**
 * Aprobación humana de una fase (RFC `aprobacion-de-fases`).
 *
 * Una aprobación es de **una versión exacta** de un artefacto: queda atada al
 * `sha256` del markdown que la persona leyó. Si el contenido cambia, el `sha256`
 * de la referencia del flow deja de coincidir y la aprobación ya no vale, aunque
 * siga guardada para la auditoría.
 */
export const ApprovalArtifact = z.enum(['prd', 'rfc', 'acceptance_criteria']);
export type ApprovalArtifact = z.infer<typeof ApprovalArtifact>;

/**
 * Por qué una aprobación dejó de valer.
 *
 *  - `content_changed`: se reenvió el mismo artefacto con otro contenido.
 *  - `upstream_resubmitted`: se reenvió el artefacto del que depende (un PRD nuevo
 *    invalida también el RFC aprobado sobre el PRD anterior).
 */
export const ApprovalInvalidationReason = z.enum(['content_changed', 'upstream_resubmitted']);
export type ApprovalInvalidationReason = z.infer<typeof ApprovalInvalidationReason>;

export const Approval = z.object({
  id: z.string(),
  tenant_id: z.string(),
  flow_id: z.string(),
  artifact: ApprovalArtifact,
  sha256: z.string().min(1),
  /** Identidad de la sesión web que aprobó, nunca la del token MCP. */
  approved_by: z.string().min(1),
  /** Roles que tenía quien aprobó en el workspace, al momento de aprobar. */
  approver_roles: z.array(z.string()),
  /** true si aprobó quien envió el artefacto (permitido sólo con firma propia). */
  self_signed: z.boolean(),
  approved_at: z.string(),
  invalidated_at: z.string().optional(),
  invalidated_reason: ApprovalInvalidationReason.optional(),
});
export type Approval = z.infer<typeof Approval>;

/** Rol dueño de cada artefacto: el único que puede aprobarlo. */
export const OWNER_ROLE = {
  prd: 'product-manager',
  rfc: 'tech-lead',
  acceptance_criteria: 'product-manager',
} as const satisfies Record<ApprovalArtifact, string>;

/** El `sha256` vigente de cada artefacto, o `undefined` si todavía no hay referencia. */
export type ApprovalRefs = Partial<Record<ApprovalArtifact, string | undefined>>;

/**
 * Las referencias de un flow contra las que se mide la vigencia.
 *
 * `acceptance_criteria` no sale del flow todavía: su referencia es el borrador de
 * backlog, que agrega `criterios-confirmados-por-pm`. Hasta entonces ninguna
 * aprobación de criterios puede estar vigente, que es el default seguro.
 */
export function approvalRefsOf(flow: Pick<Flow, 'prd_ref' | 'rfc_ref'>): ApprovalRefs {
  return {
    prd: flow.prd_ref?.sha256,
    rfc: flow.rfc_ref?.sha256,
  };
}

/**
 * ¿Vale esta aprobación hoy? Vale si nadie la invalidó y aprobó exactamente la
 * versión que el flow tiene ahora.
 */
export function isApprovalCurrent(approval: Approval, refs: ApprovalRefs): boolean {
  if (approval.invalidated_at !== undefined) return false;
  const current = refs[approval.artifact];
  return current !== undefined && current === approval.sha256;
}

/**
 * La aprobación vigente de cada artefacto. Si hubiera más de una vigente para el
 * mismo artefacto (dos aprobaciones de la misma versión), gana la más reciente.
 */
export function currentApprovals(
  approvals: readonly Approval[],
  refs: ApprovalRefs,
): Partial<Record<ApprovalArtifact, Approval>> {
  const out: Partial<Record<ApprovalArtifact, Approval>> = {};
  for (const a of approvals) {
    if (!isApprovalCurrent(a, refs)) continue;
    const prev = out[a.artifact];
    if (!prev || prev.approved_at < a.approved_at) out[a.artifact] = a;
  }
  return out;
}
