import { z } from 'zod';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { Catalog } from '@sdlc/catalog';
import type { FlowStore } from '../../state/index.js';
import { extractSections } from '../../validation/markdown-sections.js';
import { scenarioForStory, storyTargetFields } from './story-component.js';
import { resolveStoryForCtx } from './flow-access.js';

export const GetImplementationContextInput = z.object({
  story_id: z.string().min(1),
  rfc_markdown: z.string().optional(),
});
export type GetImplementationContextInput = z.infer<typeof GetImplementationContextInput>;

const EXCERPT_HEADINGS = ['design', 'risks'];

function buildExcerpt(rfcMarkdown: string): string | null {
  const sections = extractSections(rfcMarkdown);
  const picked = sections.filter((s) =>
    EXCERPT_HEADINGS.some((h) => s.heading.trim().toLowerCase() === h),
  );
  if (picked.length === 0) return null;
  return picked
    .map((s) => `## ${s.heading}\n${s.body.trim()}`)
    .join('\n\n')
    .trim();
}

export function makeGetImplementationContextTool(store: FlowStore, catalog: Catalog) {
  return {
    name: 'get_implementation_context',
    description:
      'Returns the bundle that QA (or anyone else) needs to validate a story: the story itself, the flow rfc_ref/architecture_mode, pr_url, scenario-resolved QA skills, and (if rfc_markdown is supplied) a Design+Risks excerpt extracted from it.',
    inputSchema: GetImplementationContextInput,
    handler: async (input: GetImplementationContextInput, ctx: TenantCtx) => {
      // Esta tool entra por `story_id`, no por `flow_id`: el workspace que manda es el
      // del flow **de la story**, no ninguno que venga en el input. `resolveStoryForCtx`
      // resuelve exactamente eso —workspace, story y flow, con el gate y el backstop
      // contra `flow.project`— y tiene que correr antes del chequeo de status de abajo:
      // si corriera después, el error "not been claimed yet" confirmaría que la story
      // existe para alguien sin acceso al workspace, el mismo oráculo que este cambio
      // cierra, entrando por otra puerta.
      const resolved = await resolveStoryForCtx(store, ctx, input.story_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const { story, flow } = resolved;

      if (story.status === 'created') {
        return {
          ok: false,
          error: 'Story has not been claimed yet (status=created); nothing to validate.',
        };
      }

      const rfc_excerpt = input.rfc_markdown ? buildExcerpt(input.rfc_markdown) : null;

      const bundle = await catalog.getRolePrompt('qa', 'qa', scenarioForStory(flow, story));

      return {
        ok: true,
        data: {
          story,
          rfc_ref: flow.rfc_ref ?? null,
          architecture_mode: flow.architecture_mode ?? null,
          codebase_status: flow.codebase_status ?? null,
          ...storyTargetFields(flow, story),
          pr_url: story.pr_url ?? null,
          rfc_excerpt,
          skills: bundle.skills,
        },
        next_actions: ['generate_qa_plan'],
      };
    },
  };
}
