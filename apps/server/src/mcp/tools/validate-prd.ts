import { z } from 'zod';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';
import { validatePrd } from '../../validation/prd.js';
import { resolveFlowForCtx } from './flow-access.js';

export const ValidatePrdInput = z.object({
  flow_id: z.string().min(1),
  prd_markdown: z.string().optional(),
});
export type ValidatePrdInput = z.infer<typeof ValidatePrdInput>;

export function makeValidatePrdTool(store: FlowStore) {
  return {
    name: 'validate_prd',
    description:
      'Runs the PRD structural validator. If "prd_markdown" is supplied, validates that body directly (use this for dry-runs before submit_prd). Otherwise the caller must have already submitted the PRD via submit_prd.',
    inputSchema: ValidatePrdInput,
    handler: async (input: ValidatePrdInput, ctx: TenantCtx) => {
      const resolved = await resolveFlowForCtx(store, ctx, input.flow_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      // La guarda completa (tenant + workspace) vive en resolveFlowForCtx y corre apenas
      // se resuelve el flow, para los dos modos por igual. El dry-run (con
      // `prd_markdown`) no lee nada del flow, así que podría parecer inofensivo dejarlo
      // pasar sin membresía; no lo es, porque igual distingue "el flow existe" de "no
      // existe" y eso ya es un oráculo sobre flows ajenos. Además una guarda condicional
      // al modo es una bomba de tiempo: el día que el dry-run necesite un dato del flow,
      // el bypass viaja gratis. Una sola guarda arriba es también lo único auditable de
      // un vistazo.
      const flow = resolved.flow;

      if (input.prd_markdown) {
        const validation = validatePrd(input.prd_markdown);
        return { ok: true, data: validation };
      }
      if (!flow.prd_ref) {
        return {
          ok: false,
          error:
            'No PRD has been submitted for this flow yet. Call submit_prd first, or pass prd_markdown for a dry-run.',
        };
      }
      // Without the body in store we cannot re-validate from a reference alone.
      // Surface that limitation explicitly so the agent re-submits the body if needed.
      return {
        ok: false,
        error:
          'PRD body is not stored server-side (only its sha256/url). Pass prd_markdown to revalidate.',
        data: { prd_ref: flow.prd_ref },
      };
    },
  };
}
