import { z } from 'zod';
import { Catalog } from '@sdlc/catalog';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';
import { resolveFlowForCtx } from './flow-access.js';

export const GenerateRfcSkeletonInput = z.object({
  flow_id: z.string().min(1),
});
export type GenerateRfcSkeletonInput = z.infer<typeof GenerateRfcSkeletonInput>;

export function makeGenerateRfcSkeletonTool(store: FlowStore, catalog: Catalog) {
  return {
    name: 'generate_rfc_skeleton',
    description:
      'Returns an RFC skeleton (markdown) pre-filled with metadata derived from the flow and the PRD reference. The Tech Lead agent fills in the design/risks/rollout sections from there.',
    inputSchema: GenerateRfcSkeletonInput,
    handler: async (input: GenerateRfcSkeletonInput, ctx: TenantCtx) => {
      const resolved = await resolveFlowForCtx(store, ctx, input.flow_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      // La guarda completa (tenant + workspace) vive en resolveFlowForCtx y corre antes
      // de mirar nada del flow: el esqueleto que devolvemos abajo lleva el título del
      // flow y el link del PRD embebidos, y el mensaje de "falta el PRD" ya confirma en
      // qué fase está un flow ajeno.
      const flow = resolved.flow;

      if (!flow.prd_ref) {
        return {
          ok: false,
          error: 'No PRD reference on this flow yet. The PM must submit_prd first.',
        };
      }
      const tpl = await catalog.getTemplate('rfc-template');
      const today = new Date().toISOString().slice(0, 10);
      const prdLink = flow.prd_ref.url ?? flow.prd_ref.repo_path ?? `sha256:${flow.prd_ref.sha256 ?? 'unknown'}`;
      const skeleton = tpl.content
        .replace('# RFC: <Título técnico>', `# RFC: ${flow.title}`)
        .replace('**Autores:** <nombres>', `**Autores:** ${ctx.userId}`)
        .replace('**Fecha:** <YYYY-MM-DD>', `**Fecha:** ${today}`)
        .replace('**PRD origen:** <link/path>', `**PRD origen:** ${prdLink}`);
      return { ok: true, data: { rfc_skeleton: skeleton } };
    },
  };
}
