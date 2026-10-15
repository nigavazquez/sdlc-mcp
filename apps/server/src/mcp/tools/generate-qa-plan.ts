import { z } from 'zod';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { StoryStatus } from '@sdlc/core';
import type { FlowStore } from '../../state/index.js';
import { resolveStoryForCtx } from './flow-access.js';
import { assertRole } from './role-guard.js';
import { assertFlowNotAborted } from './abort-flow.js';
import { generateQaPlan } from '../../stories/index.js';

export const GenerateQaPlanInput = z.object({
  story_id: z.string().min(1),
});
export type GenerateQaPlanInput = z.infer<typeof GenerateQaPlanInput>;

const PLAN_ELIGIBLE: ReadonlySet<StoryStatus> = new Set<StoryStatus>([
  'in_review',
  'qa_passed',
  'blocked',
]);

export function makeGenerateQaPlanTool(store: FlowStore) {
  return {
    name: 'generate_qa_plan',
    description:
      'Generates (or regenerates) a deterministic QA plan from the story acceptance criteria. Required before submit_qa_results.',
    inputSchema: GenerateQaPlanInput,
    handler: async (input: GenerateQaPlanInput, ctx: TenantCtx) => {
      const resolved = await resolveStoryForCtx(store, ctx, input.story_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const { story, flow } = resolved;

      // Guarda de rol antes de cualquier side-effect: el plan se persiste en la story
      // y es el prerequisito de `submit_qa_results`, así que regenerarlo cambia
      // contra qué se firma la QA. Mismos roles que `submit_qa_results`, que es el
      // paso que lo consume: `qa` por la fase del catálogo, `tech-lead` como
      // break-glass.
      //
      // No lleva `assertNotSelfSignoff` a propósito. El plan es determinístico
      // —sale de los acceptance criteria de la story, no del juicio de quien lo
      // pide— así que generarlo no es un acto de verificación y no hay nada que
      // el autor pueda sesgar. La separación de funciones se aplica un paso después,
      // en `submit_qa_results`, que es donde alguien afirma que pasó.
      const roleDenied = assertRole(ctx, ['qa', 'tech-lead'], 'generate_qa_plan', flow.project);
      if (roleDenied) {
        return {
          ok: false,
          error:
            `${roleDenied} Verificá tus roles con whoami y pedile a alguien con rol qa o tech-lead en ` +
            'ese workspace que ejecute generate_qa_plan.',
        };
      }

      // Un flow abandonado no genera planes de QA nuevos.
      const abortedDenied = assertFlowNotAborted(flow, 'generate_qa_plan');
      if (abortedDenied) return { ok: false, error: abortedDenied };

      if (!PLAN_ELIGIBLE.has(story.status)) {
        return {
          ok: false,
          error: `Story must be in {in_review, qa_passed, blocked} to generate a plan (current=${story.status})`,
        };
      }

      const qa_plan = generateQaPlan(story.acceptance_criteria);
      const updated = await store.updateStory(story.story_id, { qa_plan });
      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'qa.plan.generated',
        actor: ctx.userId,
        payload: { story_id: story.story_id, case_count: qa_plan.cases.length },
      });

      return {
        ok: true,
        data: { story: updated, qa_plan },
        next_actions: ['submit_qa_results'],
      };
    },
  };
}
