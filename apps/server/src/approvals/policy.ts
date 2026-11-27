import {
  OWNER_ROLE,
  approvalRefsOf,
  currentApprovals,
  type ApprovalArtifact,
  type ApprovalInvalidationReason,
  type Flow,
} from '@sdlc/core';
import type { FlowStore } from '../state/index.js';

/**
 * Qué workspaces exigen la aprobación humana de fases (RFC `aprobacion-de-fases`).
 *
 * Sale de `APPROVALS_REQUIRED`: una lista de workspace ids separada por comas, `*`
 * para todos, o vacía para nadie. Vacía es el comportamiento de antes y es el
 * interruptor del rollback: apagarla vuelve a dejar avanzar el flow sin aprobación,
 * y las aprobaciones ya registradas quedan guardadas.
 */
export interface ApprovalPolicy {
  required(workspaceId: string): boolean;
  /** Base de los links de aprobación (`PUBLIC_URL` del server). */
  publicUrl?: string;
}

export function approvalPolicyFrom(
  workspaces: readonly string[],
  opts: { publicUrl?: string } = {},
): ApprovalPolicy {
  const set = new Set(workspaces.map((w) => w.trim()).filter(Boolean));
  const all = set.has('*');
  return {
    required: (ws) => all || set.has(ws),
    ...(opts.publicUrl !== undefined ? { publicUrl: opts.publicUrl } : {}),
  };
}

/** Parseo de `APPROVALS_REQUIRED`. */
export function parseApprovalsRequired(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const APPROVALS_OFF: ApprovalPolicy = { required: () => false };

const NOMBRE: Record<ApprovalArtifact, string> = {
  prd: 'el PRD',
  rfc: 'el RFC',
  acceptance_criteria: 'los criterios de aceptación',
};

/**
 * `null` si el artefacto tiene una aprobación vigente (del `sha256` que el flow
 * tiene ahora); si no, el motivo para devolverle al agente, con el rol que puede
 * aprobar.
 */
export async function missingApproval(
  store: FlowStore,
  flow: Flow,
  artifact: ApprovalArtifact,
): Promise<string | null> {
  const vigentes = currentApprovals(await store.listApprovals(flow.flow_id), approvalRefsOf(flow));
  if (vigentes[artifact]) return null;
  return (
    `${NOMBRE[artifact][0]!.toUpperCase()}${NOMBRE[artifact].slice(1)} de este flow no tiene una aprobación vigente. ` +
    `Lo aprueba una persona con rol ${OWNER_ROLE[artifact]} en el workspace "${flow.project}", ` +
    'desde el link de aprobación (no desde una tool MCP). Si cambió el contenido, la aprobación anterior ya no vale.'
  );
}

/** ¿Tiene `artifact` una aprobación vigente para el `sha256` que va a quedar? */
export async function hasCurrentApproval(
  store: FlowStore,
  flow: Pick<Flow, 'flow_id' | 'prd_ref' | 'rfc_ref'>,
  artifact: ApprovalArtifact,
): Promise<boolean> {
  return currentApprovals(await store.listApprovals(flow.flow_id), approvalRefsOf(flow))[artifact] !== undefined;
}

/**
 * Invalida las aprobaciones y deja un evento `approval.invalidated` por cada una,
 * para que el historial diga qué versión había aprobado quién y por qué dejó de valer.
 */
export async function invalidateApprovalsWithEvents(
  store: FlowStore,
  flowId: string,
  actor: string,
  changes: ReadonlyArray<{ artifacts: ApprovalArtifact[]; reason: ApprovalInvalidationReason }>,
): Promise<number> {
  let total = 0;
  for (const { artifacts, reason } of changes) {
    const marcadas = await store.invalidateApprovals(flowId, artifacts, reason);
    for (const a of marcadas) {
      await store.appendEvent({
        flow_id: flowId,
        type: 'approval.invalidated',
        actor,
        payload: { artifact: a.artifact, sha256: a.sha256, reason, approved_by: a.approved_by },
      });
    }
    total += marcadas.length;
  }
  return total;
}

/** Qué aprobación espera el flow ahora, o `null`. */
export interface PendingApproval {
  artifact: ApprovalArtifact;
  owner_role: (typeof OWNER_ROLE)[ApprovalArtifact];
}

/**
 * La aprobación que el flow está esperando. En revisión es la del artefacto en
 * revisión. Con la exigencia prendida, un flow que llegó a `prd_ready` o
 * `rfc_ready` sin aprobación (los de antes de la exigencia) también la espera:
 * es la que le va a pedir la próxima transición.
 */
export function pendingApprovalOf(
  flow: Flow,
  vigentes: Partial<Record<ApprovalArtifact, unknown>>,
  policy: ApprovalPolicy,
): PendingApproval | null {
  const of = (artifact: ApprovalArtifact): PendingApproval => ({ artifact, owner_role: OWNER_ROLE[artifact] });
  if (flow.status === 'prd_in_review') return of('prd');
  if (flow.status === 'rfc_in_review') return of('rfc');
  if (!policy.required(flow.project)) return null;
  if (flow.status === 'prd_ready' && !vigentes.prd) return of('prd');
  if (flow.status === 'rfc_ready' && !vigentes.rfc) return of('rfc');
  return null;
}
