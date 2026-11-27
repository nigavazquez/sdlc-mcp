import { z } from 'zod';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';
import { resolveFlowForCtx } from './flow-access.js';
import type { AdminStore } from '../../admin/store.js';
import { workspaceSelfSignoff } from '../../admin/self-signoff.js';
import { approvalRefsOf, currentApprovals } from '@sdlc/core';
import { APPROVALS_OFF, pendingApprovalOf, type ApprovalPolicy } from '../../approvals/policy.js';

export const GetFlowStateInput = z.object({
  flow_id: z.string().min(1),
});
export type GetFlowStateInput = z.infer<typeof GetFlowStateInput>;

export function makeGetFlowStateTool(
  store: FlowStore,
  adminStore?: AdminStore,
  approvals: ApprovalPolicy = APPROVALS_OFF,
) {
  return {
    name: 'get_flow_state',
    description:
      'Returns the current phase, status, and artifact references for a flow, plus the most recent events. Use this at the start of any session to know where you are.',
    inputSchema: GetFlowStateInput,
    handler: async (input: GetFlowStateInput, ctx: TenantCtx) => {
      const resolved = await resolveFlowForCtx(store, ctx, input.flow_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      // La guarda completa (tenant + workspace) vive en resolveFlowForCtx, la misma que
      // usan las tools de escritura. Antes acá sólo se comparaba el tenant, y como el
      // deploy es single-tenant eso no filtraba nada: cualquier usuario autenticado leía
      // el estado entero de un flow de otro workspace —prd_ref/rfc_ref con URLs de Drive,
      // título y los últimos 10 eventos—. Corre antes de listar los eventos: si el acceso
      // está denegado no se toca el store.
      const flow = resolved.flow;

      const events = (await store.listEvents(flow.flow_id)).slice(-10);
      const workspace = {
        workspace_id: flow.project,
        self_signoff: await workspaceSelfSignoff(adminStore, flow.project),
      };
      // Aprobaciones vigentes (del sha256 actual de cada artefacto) y la que espera el flow.
      const vigentes = currentApprovals(await store.listApprovals(flow.flow_id), approvalRefsOf(flow));
      const approvalsView = Object.fromEntries(
        Object.entries(vigentes).map(([artifact, a]) => [
          artifact,
          { sha256: a.sha256, approved_by: a.approved_by, approved_at: a.approved_at, self_signed: a.self_signed },
        ]),
      );
      const pending_approval = pendingApprovalOf(flow, vigentes, approvals);
      return {
        ok: true,
        data: { flow, workspace, approvals: approvalsView, pending_approval, recent_events: events },
        next_actions: nextActionsFor(flow.current_phase),
      };
    },
  };
}

function nextActionsFor(phase: string): string[] {
  switch (phase) {
    case 'prd':
      return ['submit_prd', 'validate_prd'];
    case 'rfc':
      return ['generate_rfc_skeleton', 'submit_rfc', 'validate_rfc'];
    case 'shaping':
      return ['propose_breakdown', 'create_epic'];
    case 'implementation':
      return ['claim_story', 'report_progress'];
    case 'qa':
      return ['generate_qa_plan', 'submit_qa_results'];
    case 'review':
      return ['request_code_review', 'submit_review_outcome'];
    default:
      return [];
  }
}
