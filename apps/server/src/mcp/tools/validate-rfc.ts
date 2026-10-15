import { z } from 'zod';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';
import { validateRfc } from '../../validation/rfc.js';
import { resolveFlowForCtx } from './flow-access.js';

export const ValidateRfcInput = z.object({
  flow_id: z.string().min(1),
  rfc_markdown: z.string().optional(),
});
export type ValidateRfcInput = z.infer<typeof ValidateRfcInput>;

export function makeValidateRfcTool(store: FlowStore) {
  return {
    name: 'validate_rfc',
    description:
      'Runs the RFC structural validator. If "rfc_markdown" is supplied, validates that body directly (dry-run). Otherwise reports the stored reference (the body itself is not retained server-side).',
    inputSchema: ValidateRfcInput,
    handler: async (input: ValidateRfcInput, ctx: TenantCtx) => {
      const resolved = await resolveFlowForCtx(store, ctx, input.flow_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      // Misma decisión que en validate_prd: la guarda completa (tenant + workspace) vive
      // en resolveFlowForCtx y corre igual para el dry-run y para el modo que reporta
      // `rfc_ref`. El dry-run no lee el flow pero sí confirma que existe, y una guarda
      // por modo se rompe sola en cuanto el dry-run pase a mirar algo del flow.
      const flow = resolved.flow;

      if (input.rfc_markdown) {
        const validation = validateRfc(input.rfc_markdown);
        return { ok: true, data: validation };
      }
      if (!flow.rfc_ref) {
        return {
          ok: false,
          error:
            'No RFC has been submitted for this flow yet. Call submit_rfc first, or pass rfc_markdown for a dry-run.',
        };
      }
      return {
        ok: false,
        error: 'RFC body is not stored server-side. Pass rfc_markdown to revalidate.',
        data: { rfc_ref: flow.rfc_ref },
      };
    },
  };
}
