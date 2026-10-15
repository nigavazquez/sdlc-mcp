import { z } from 'zod';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { TaskSystemProvider } from '../../adapters/task-system-provider.js';
import type { StoryStatus } from '@sdlc/core';
import type { FlowStore } from '../../state/index.js';
import { resolveStoryForCtx } from './flow-access.js';
import { assertRole } from './role-guard.js';
import { assertFlowNotAborted } from './abort-flow.js';
import { canTransition } from '../../stories/index.js';

export const ReportProgressInput = z.object({
  story_id: z.string().min(1),
  status: z.enum(['in_progress', 'in_review']),
  pr_url: z.string().url().optional(),
  notes: z.string().optional(),
});
export type ReportProgressInput = z.infer<typeof ReportProgressInput>;

export function makeReportProgressTool(store: FlowStore, taskSystemProvider: TaskSystemProvider) {
  return {
    name: 'report_progress',
    description:
      'Reports developer progress on a claimed story. status="in_progress" while coding; status="in_review" when the PR is open (pr_url required). Transitions the work item accordingly.',
    inputSchema: ReportProgressInput,
    handler: async (input: ReportProgressInput, ctx: TenantCtx) => {
      const resolved = await resolveStoryForCtx(store, ctx, input.story_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const { story, flow } = resolved;

      // Guarda de rol antes de cualquier side-effect. Igual que en `claim_story`, el
      // chequeo de identidad de abajo ata al actor a la story pero no verifica que
      // tenga el rol que implementa. `developer` solo, por el mismo motivo: acá se
      // setea el `pr_url`, y quien declara el PR no puede ser el mismo rol que
      // después firma la QA o el review.
      // Mismo criterio que `claim_story`: la salida es el rol, y el mensaje nombra
      // dónde se asigna y que hace falta re-loguearse, igual que
      // `assertWorkspaceAccess` con la membresía.
      const roleDenied = assertRole(ctx, ['developer'], 'report_progress', flow.project);
      if (roleDenied) {
        return {
          ok: false,
          error:
            `${roleDenied} Verificá tus roles con whoami. El progreso de una story lo reporta quien la ` +
            `implementa, así que necesitás el rol developer en el workspace "${flow.project}" — incluso si ` +
            'sos tech-lead: acá se declara el pr_url, y quien declara el PR no puede ser el mismo rol que ' +
            'después firma la QA o el review. Pedí a un admin que te asigne el rol developer en ese ' +
            'workspace desde el panel admin (Workspaces → miembros) y volvé a loguearte para que el token ' +
            'traiga el rol nuevo.',
        };
      }

      // Un flow abandonado no avanza stories.
      const abortedDenied = assertFlowNotAborted(flow, 'report_progress');
      if (abortedDenied) return { ok: false, error: abortedDenied };

      if (story.assignee !== ctx.userId) {
        return {
          ok: false,
          error: `Only the assignee can report progress (assignee=${story.assignee ?? 'unset'})`,
        };
      }
      if (input.status === 'in_review' && !input.pr_url) {
        return { ok: false, error: 'pr_url is required when status=in_review' };
      }
      const target: StoryStatus = input.status;
      if (!canTransition(story.status, target)) {
        return { ok: false, error: `invalid transition ${story.status}→${target}` };
      }

      const adoStatus = target === 'in_review' ? 'Resolved' : 'Active';
      const taskSystem = await taskSystemProvider.resolve(ctx, flow);
      await taskSystem.transition(story.external_id, adoStatus, ctx);

      const updated = await store.updateStory(story.story_id, {
        status: target,
        ...(input.pr_url ? { pr_url: input.pr_url } : {}),
      });
      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'progress.reported',
        actor: ctx.userId,
        payload: {
          story_id: story.story_id,
          status: target,
          pr_url: input.pr_url ?? null,
          notes: input.notes ?? null,
        },
      });

      return {
        ok: true,
        data: { story: updated },
        next_actions:
          target === 'in_review'
            ? ['get_implementation_context (QA side)', 'generate_qa_plan']
            : ['report_progress({status:"in_review", pr_url})'],
      };
    },
  };
}
