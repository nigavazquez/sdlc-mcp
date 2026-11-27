import { z } from 'zod';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { approvalRefsOf, currentApprovals } from '@sdlc/core';
import type { FlowStore } from '../../state/index.js';
import { resolveFlowForCtx } from './flow-access.js';
import { assertFlowNotAborted } from './abort-flow.js';
import { APPROVALS_OFF, type ApprovalPolicy } from '../../approvals/policy.js';
import { issueApprovalLink } from '../../approvals/links.js';

export const RequestApprovalInput = z.object({
  flow_id: z.string().min(1),
  artifact: z.enum(['prd', 'rfc']),
});
export type RequestApprovalInput = z.infer<typeof RequestApprovalInput>;

/**
 * Un link de aprobación nuevo para la versión actual del PRD o el RFC: sirve cuando
 * el anterior venció o se perdió. **No aprueba nada**: ninguna tool MCP aprueba,
 * porque el agente usa el mismo token que la persona. Aprobar es abrir el link con
 * la sesión web de quien tiene el rol dueño (RFC aprobacion-de-fases).
 *
 * La pide cualquier miembro del workspace: resolveFlowForCtx ya exige el acceso.
 */
export function makeRequestApprovalTool(store: FlowStore, approvals: ApprovalPolicy = APPROVALS_OFF) {
  return {
    name: 'request_approval',
    description:
      'Issues a new single-use approval link (valid 7 days) for the current version of the flow PRD or RFC, when the previous link expired or was lost. Does NOT approve anything: approval only happens when a person with the owner role (product-manager for the PRD, tech-lead for the RFC) opens the link with their web session. Any workspace member can request it. Requires the workspace to have phase approval enabled.',
    inputSchema: RequestApprovalInput,
    handler: async (input: RequestApprovalInput, ctx: TenantCtx) => {
      const resolved = await resolveFlowForCtx(store, ctx, input.flow_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const flow = resolved.flow;

      const abortedDenied = assertFlowNotAborted(flow, 'request_approval');
      if (abortedDenied) return { ok: false, error: abortedDenied };

      if (!approvals.required(flow.project)) {
        return {
          ok: false,
          error: `El workspace "${flow.project}" no exige aprobación de fases (APPROVALS_REQUIRED): no hay nada que aprobar.`,
        };
      }
      const sha = approvalRefsOf(flow)[input.artifact];
      if (!sha) {
        return {
          ok: false,
          error: `El flow todavía no tiene ${input.artifact.toUpperCase()}: envialo con submit_${input.artifact} y la respuesta trae el link.`,
        };
      }
      const vigente = currentApprovals(await store.listApprovals(flow.flow_id), approvalRefsOf(flow))[input.artifact];
      if (vigente) {
        return {
          ok: false,
          error: `El ${input.artifact.toUpperCase()} actual ya está aprobado (por ${vigente.approved_by} el ${vigente.approved_at}).`,
        };
      }

      const approval = await issueApprovalLink({
        store,
        flow,
        artifact: input.artifact,
        requestedBy: ctx.userId,
        publicUrl: approvals.publicUrl,
      });
      return {
        ok: true,
        data: { approval },
        next_actions: [
          `Pedile a una persona con rol ${approval.owner_role} que apruebe en ${approval.url} (vence ${approval.expires_at}). Vos no abras el link.`,
        ],
      };
    },
  };
}
