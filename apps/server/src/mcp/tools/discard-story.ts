import { z } from 'zod';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { TaskSystemProvider } from '../../adapters/task-system-provider.js';
import type { FlowStore } from '../../state/index.js';
import { resolveStoryForCtx } from './flow-access.js';
import { assertRole } from './role-guard.js';
import { assertFlowNotAborted } from './abort-flow.js';
import { canTransition, listAllowedTargets } from '../../stories/index.js';
import { closeFlowIfSettled } from './flow-closure.js';

export const DiscardStoryInput = z.object({
  story_id: z.string().min(1),
  reason: z.string().min(1),
});
export type DiscardStoryInput = z.infer<typeof DiscardStoryInput>;

/**
 * Descarta una story que no se va a hacer.
 *
 * Existe porque `merged` era el único terminal del ciclo de vida y el cierre del
 * flow exige que ninguna story hermana quede fuera de él. Una story creada de
 * más —un array de más en `create_stories`, que es una sola llamada sin
 * deshacer— dejaba el flow sin poder llegar nunca a `merged/done`, y la única
 * salida era hacer el trabajo completo de la story de sobra: `block_story` la
 * deja en `blocked`, que tampoco es `merged`.
 *
 * Por qué una tool con guarda de rol y no simplemente excluir del conteo un
 * estado que cualquiera pueda setear: el estado terminal de descarte *es* el
 * conteo. Si un developer pudiera mandar su propia story a `discarded`, cerrar
 * el flow sin implementarla sería un bypass tan bueno como el que veníamos
 * cerrando. El backlog lo dueñea el tech-lead, así que ese es el rol.
 *
 * No toca el PR ni firma nada: mueve el work item externo a Removed y deja el
 * `story.discarded` con el motivo en el log, que es lo que después se audita.
 */
export function makeDiscardStoryTool(store: FlowStore, taskSystemProvider: TaskSystemProvider) {
  return {
    name: 'discard_story',
    description:
      'Discards a story that will not be implemented (e.g. created by mistake or superseded), moving it to ' +
      'the terminal status "discarded" so it stops blocking the flow from closing. Requires role tech-lead ' +
      'in the flow workspace and a reason. A merged story cannot be discarded. Discarding the last pending ' +
      'story closes the flow (merged/done) as long as at least one story was merged; a flow whose stories ' +
      'were all discarded delivered nothing and is left open.',
    inputSchema: DiscardStoryInput,
    handler: async (input: DiscardStoryInput, ctx: TenantCtx) => {
      const reason = input.reason.trim();
      if (reason.length === 0) {
        return {
          ok: false,
          error:
            'discard_story: reason no puede estar vacío. Volvé a llamar discard_story({story_id, reason}) ' +
            'explicando por qué la story no se va a hacer — queda en el log como única traza del descarte.',
        };
      }

      const resolved = await resolveStoryForCtx(store, ctx, input.story_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const { story, flow } = resolved;

      // Guarda de rol antes de cualquier side-effect: `discarded` saca a la story
      // del conteo de pendientes que cierra el flow, así que es una concesión.
      const roleDenied = assertRole(ctx, ['tech-lead'], 'discard_story', flow.project);
      if (roleDenied) {
        return {
          ok: false,
          error:
            `${roleDenied} Verificá tus roles con whoami y pedile a alguien con rol tech-lead en ese ` +
            'workspace que ejecute discard_story.',
        };
      }

      // Un flow abandonado no se ordena story por story. `discard_story` existe para
      // desbloquear el cierre del flow, y sobre un flow `aborted` no hay cierre que
      // desbloquear: `closeFlowIfSettled` no cierra un flow abortado. Lo único que
      // quedaría de esta llamada son escrituras —el work item a Removed y un
      // `story.discarded` en el log— que contradicen el propio registro del abort,
      // que ya contó y nombró las stories que quedaron tiradas. Era la última tool
      // de escritura sin la guarda, o sea la última grieta en lo que promete la
      // description de `abort_flow`.
      const abortedDenied = assertFlowNotAborted(flow, 'discard_story');
      if (abortedDenied) return { ok: false, error: abortedDenied };

      if (!canTransition(story.status, 'discarded')) {
        const detalle =
          story.status === 'merged'
            ? 'la story ya está merged: el trabajo se integró y sacarlo del conteo sería reescribir la historia'
            : story.status === 'discarded'
              ? 'la story ya está descartada'
              : `desde "${story.status}" no se puede descartar (destinos válidos: ${listAllowedTargets(story.status).join(', ')})`;
        return {
          ok: false,
          error:
            `discard_story: ${detalle}. Llamá get_flow_state({flow_id:"${flow.flow_id}"}) para ver el estado ` +
            'real de las stories del flow.',
        };
      }

      const taskSystem = await taskSystemProvider.resolve(ctx, flow);
      await taskSystem.transition(story.external_id, 'Removed', ctx);

      const updated = await store.updateStory(story.story_id, { status: 'discarded' });
      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'story.discarded',
        actor: ctx.userId,
        payload: { story_id: story.story_id, reason, previous_status: story.status },
      });

      // Descartar la última pendiente cierra el flow igual que mergearla.
      //
      // El cierre se evaluaba sólo dentro de `submit_review_outcome`, así que el
      // orden natural de trabajo —mergear lo real primero y descartar lo sobrante
      // al final, que es cuando uno se entera de que sobraba— dejaba el flow
      // abierto sin ninguna tool capaz de re-evaluarlo: `submit_review_outcome`
      // rechaza una story ya `merged` y `discard_story` también. Ver
      // `closeFlowIfSettled`, que además explica por qué un flow donde se
      // descartaron *todas* las stories no se cierra como `merged`.
      const closure = await closeFlowIfSettled(store, flow);

      return {
        ok: true,
        data: { story: updated, flow: closure.flow },
        next_actions: closure.closed
          ? []
          : closure.pending === 0 && closure.merged === 0
            ? // No queda ninguna story viva y no se entregó nada: el flow no cierra
              // como merged. La salida es rehacer el backlog, no rebobinar el flow.
              [
                `create_stories({flow_id:"${flow.flow_id}", epic_id:"${flow.epic_external_id ?? '<epic_id>'}", stories:[...]})`,
                `sync_backlog({flow_id:"${flow.flow_id}"})`,
              ]
            : [`get_flow_state({flow_id:"${flow.flow_id}"})`],
      };
    },
  };
}
