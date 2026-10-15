import { z } from 'zod';
import type { Catalog } from '@sdlc/catalog';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';
import { resolveFlowForCtx } from './flow-access.js';
import { assertRole } from './role-guard.js';
import { proposeBreakdown } from '../../shaping/propose.js';
import { validateBreakdown } from '../../validation/breakdown.js';

export const ProposeBreakdownInput = z.object({
  flow_id: z.string().min(1),
  rfc_markdown: z.string().min(1),
});
export type ProposeBreakdownInput = z.infer<typeof ProposeBreakdownInput>;

export function makeProposeBreakdownTool(store: FlowStore, catalog: Catalog) {
  return {
    name: 'propose_breakdown',
    description:
      'Suggests an epic + stories breakdown from the RFC markdown (deterministic heuristic — NOT authoritative). Requires the flow to be in status=rfc_ready. Returns the suggested breakdown and the breakdown template. Does not create anything external.',
    inputSchema: ProposeBreakdownInput,
    handler: async (input: ProposeBreakdownInput, ctx: TenantCtx) => {
      const resolved = await resolveFlowForCtx(store, ctx, input.flow_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const flow = resolved.flow;

      // Guarda de rol antes de cualquier side-effect. La tool no crea nada externo,
      // pero emite `breakdown.proposed`, que es parte del log que después audita el
      // shaping. El catálogo le asigna la fase `shaping` a `pmo`; `tech-lead` va
      // como break-glass, igual que en el resto de las tools de esta fase.
      const roleDenied = assertRole(ctx, ['pmo', 'tech-lead'], 'propose_breakdown', flow.project);
      if (roleDenied) {
        return {
          ok: false,
          error:
            `${roleDenied} Verificá tus roles con whoami y pedile a alguien con rol pmo o tech-lead en ` +
            'ese workspace que ejecute propose_breakdown.',
        };
      }

      // Un flow `aborted` no llega acá: el status requerido es `rfc_ready`.
      if (flow.status !== 'rfc_ready') {
        return {
          ok: false,
          error: `Cannot propose breakdown: flow status is "${flow.status}", expected "rfc_ready".`,
        };
      }

      const rfcRef = flow.rfc_ref?.repo_path ?? flow.rfc_ref?.url ?? flow.flow_id;
      const suggested = proposeBreakdown(input.rfc_markdown, flow.title, rfcRef);
      const template = await catalog.getTemplate('breakdown-template');

      const validation = validateBreakdown(suggested);

      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'breakdown.proposed',
        actor: ctx.userId,
        payload: { story_count: suggested.stories.length },
      });

      return {
        ok: true,
        data: { suggested_breakdown: suggested, validation, template: template.content },
        next_actions: ['create_epic', 'create_stories'],
      };
    },
  };
}
