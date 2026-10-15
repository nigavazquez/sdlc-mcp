import { z } from 'zod';
import { SubtaskInput } from '@sdlc/core';
import type { ExternalRef, TenantCtx } from '@sdlc/adapters-contracts';
import type { TaskSystemProvider } from '../../adapters/task-system-provider.js';
import type { FlowStore } from '../../state/index.js';
import { resolveFlowForCtx } from './flow-access.js';
import { assertRole } from './role-guard.js';
import { assertFlowNotAborted } from './abort-flow.js';

export const LinkSubtasksInput = z.object({
  flow_id: z.string().min(1),
  story_id: z.string().min(1),
  subtasks: z.array(SubtaskInput).min(1),
});
export type LinkSubtasksInput = z.infer<typeof LinkSubtasksInput>;

export function makeLinkSubtasksTool(store: FlowStore, taskSystemProvider: TaskSystemProvider) {
  return {
    name: 'link_subtasks',
    description:
      'Creates technical subtasks (tasks) under a story in the external task system and links them to the story.',
    inputSchema: LinkSubtasksInput,
    handler: async (input: LinkSubtasksInput, ctx: TenantCtx) => {
      const resolved = await resolveFlowForCtx(store, ctx, input.flow_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const flow = resolved.flow;

      // Guarda de rol antes de cualquier side-effect: el loop de abajo crea subtasks
      // en el sistema externo de tareas y no hay rollback. Fase `shaping` → `pmo`,
      // con `tech-lead` como break-glass.
      const roleDenied = assertRole(ctx, ['pmo', 'tech-lead'], 'link_subtasks', flow.project);
      if (roleDenied) {
        return {
          ok: false,
          error:
            `${roleDenied} Verificá tus roles con whoami y pedile a alguien con rol pmo o tech-lead en ` +
            'ese workspace que ejecute link_subtasks. No se creó ninguna subtask.',
        };
      }

      // Un flow abandonado no acepta backlog nuevo.
      const abortedDenied = assertFlowNotAborted(flow, 'link_subtasks');
      if (abortedDenied) return { ok: false, error: abortedDenied };

      if (!flow.epic_external_id) {
        return { ok: false, error: 'Cannot link subtasks: no epic exists yet. Call create_epic and create_stories first.' };
      }

      const taskSystem = await taskSystemProvider.resolve(ctx, flow);
      const refs: ExternalRef[] = [];
      for (const sub of input.subtasks) {
        const ref = await taskSystem.createSubtask(
          {
            project_key: flow.project,
            parent_story_id: input.story_id,
            title: sub.title,
            ...(sub.description ? { description: sub.description } : {}),
          },
          ctx,
        );
        await taskSystem.linkChildToParent(input.story_id, ref.external_id, ctx);
        refs.push(ref);
      }

      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'subtasks.linked',
        actor: ctx.userId,
        payload: { story_id: input.story_id, refs },
      });

      return {
        ok: true,
        data: { subtask_refs: refs },
        next_actions: ['sync_backlog'],
      };
    },
  };
}
