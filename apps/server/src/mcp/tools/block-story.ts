import { z } from 'zod';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { TaskSystemProvider } from '../../adapters/task-system-provider.js';
import type { FlowStore } from '../../state/index.js';
import { resolveStoryForCtx } from './flow-access.js';
import { assertNotSelfSignoff, assertRole } from './role-guard.js';
import { assertFlowNotAborted } from './abort-flow.js';

export const BlockStoryInput = z.object({
  story_id: z.string().min(1),
  reason: z.string().min(1),
});
export type BlockStoryInput = z.infer<typeof BlockStoryInput>;

export function makeBlockStoryTool(store: FlowStore, taskSystemProvider: TaskSystemProvider) {
  return {
    name: 'block_story',
    description:
      'Shortcut for QA to block an in_review story without completing a full plan (e.g. smoke fails). ' +
      'Requires role qa, reviewer or tech-lead in the flow workspace, and the story assignee cannot ' +
      'block their own delivery. Transitions the work item back to Active and emits story.blocked.',
    inputSchema: BlockStoryInput,
    handler: async (input: BlockStoryInput, ctx: TenantCtx) => {
      const reason = input.reason.trim();
      if (reason.length === 0) {
        return {
          ok: false,
          error:
            'block_story: reason no puede estar vacío. Volvé a llamar block_story({story_id, reason}) ' +
            'explicando qué falló — el motivo queda en la story y en el evento story.blocked, y es lo ' +
            'único que le dice al developer qué tiene que arreglar.',
        };
      }
      const resolved = await resolveStoryForCtx(store, ctx, input.story_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const { story, flow } = resolved;

      // Guarda de rol antes de cualquier side-effect, y acá el orden importa: la
      // transición del work item externo a "Active" pasa por el sistema de tareas y
      // no hay rollback.
      //
      // `block_story` es el atajo de la fase de verificación —devolver una story sin
      // completar el plan entero— así que lo ejercen los dos roles que verifican
      // (`qa` por la fase `qa`, `reviewer` por la fase `review`) más `tech-lead` como
      // break-glass. `reviewer` va incluido porque el rechazo del review llega por
      // esta misma puerta cuando no hace falta un veredicto formal.
      const roleDenied = assertRole(ctx, ['qa', 'reviewer', 'tech-lead'], 'block_story', flow.project);
      if (roleDenied) {
        return {
          ok: false,
          error:
            `${roleDenied} Verificá tus roles con whoami y pedile a alguien con rol qa, reviewer o ` +
            'tech-lead en ese workspace que ejecute block_story.',
        };
      }

      // Separación de funciones: devolver una story es un juicio sobre la entrega,
      // así que el autor no lo firma sobre su propio trabajo — el mismo criterio que
      // `submit_qa_results`, del que `block_story` es el atajo.
      //
      // No es un detalle formal: sin esto, un developer con rol `qa` en el workspace
      // se bloqueaba su propia story para reabrirla —`blocked` habilita volver a
      // `in_progress`— y con eso rebobinaba una entrega ya en review sin que nadie
      // se enterara. Quien tiene que corregir usa `report_progress`; quien juzga que
      // hay que corregir es otro.
      const selfDenied = assertNotSelfSignoff(ctx, story, 'block_story');
      if (selfDenied) return { ok: false, error: selfDenied };

      // Un flow abandonado no mueve stories.
      const abortedDenied = assertFlowNotAborted(flow, 'block_story');
      if (abortedDenied) return { ok: false, error: abortedDenied };

      if (story.status !== 'in_review') {
        return {
          ok: false,
          error: `Cannot block a story unless it is in_review (current=${story.status})`,
        };
      }

      const taskSystem = await taskSystemProvider.resolve(ctx, flow);
      await taskSystem.transition(story.external_id, 'Active', ctx);
      const updated = await store.updateStory(story.story_id, {
        status: 'blocked',
        qa_verdict: 'blocked',
        qa_block_reason: reason,
      });
      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'story.blocked',
        actor: ctx.userId,
        payload: { story_id: story.story_id, reason },
      });

      return {
        ok: true,
        data: { story: updated },
        next_actions: ['report_progress({status:"in_progress"})'],
      };
    },
  };
}
