import { z } from 'zod';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { TaskSystemProvider } from '../../adapters/task-system-provider.js';
import type { Catalog } from '@sdlc/catalog';
import type { FlowStore } from '../../state/index.js';
import { scenarioForStory, storyTargetFields } from './story-component.js';
import { resolveStoryForCtx } from './flow-access.js';
import { assertRole } from './role-guard.js';
import { assertFlowNotAborted } from './abort-flow.js';
import { issueStoryLease, type GateStore } from '../../gate/index.js';

/**
 * Gate de repos habilitados (RFC sdlc-repo-onboarding). Prendido, cada claim aceptado
 * devuelve `data.gate_lease`, el permiso que el gate del repo valida contra el server.
 * Apagado (`GATE_API_ENABLED=false`) o ausente, la respuesta queda como antes.
 */
export interface ClaimStoryGate {
  store: GateStore;
  enabled: boolean;
}

export const ClaimStoryInput = z.object({
  story_id: z.string().min(1),
  developer_id: z.string().min(1),
});
export type ClaimStoryInput = z.infer<typeof ClaimStoryInput>;

export function makeClaimStoryTool(
  store: FlowStore,
  taskSystemProvider: TaskSystemProvider,
  catalog: Catalog,
  gate?: ClaimStoryGate,
) {
  return {
    name: 'claim_story',
    description:
      'Marks a story as claimed by the given developer. Idempotent if the same developer re-claims. Transitions the external work item to Active and emits story.claimed.',
    inputSchema: ClaimStoryInput,
    handler: async (input: ClaimStoryInput, ctx: TenantCtx) => {
      const resolved = await resolveStoryForCtx(store, ctx, input.story_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const { story, flow } = resolved;

      // Guarda de rol antes de cualquier side-effect. El chequeo de identidad de
      // abajo (`developer_id === ctx.userId`) **ata** al actor a la story, pero no
      // dice nada de si ese actor tiene derecho a implementar: sin esto, cualquier
      // miembro del workspace se autoasignaba trabajo.
      //
      // `developer` solo, sin break-glass, y a propósito. El catálogo le asigna la
      // fase `implement` únicamente a `developer`, y `tech-lead` es break-glass en
      // las guardas de verificación (submit_qa_results, submit_review_outcome):
      // sumarlo también acá le daría los dos lados del mismo cambio. Un tech-lead
      // que además escribe código lleva el rol `developer` en ese workspace, que es
      // lo que el modelo ya sabe expresar.
      // La salida ejecutable es el rol, no otra persona: en un equipo chico "pedile
      // a alguien con rol developer" no es una salida —puede no haber nadie más—, y
      // el caso real es un tech-lead que además implementa. Ese caso se resuelve
      // teniendo el rol `developer` en el workspace, que es lo que el mensaje
      // nombra, con el mismo lugar y la misma re-autenticación que
      // `assertWorkspaceAccess`: los roles vienen del claim del token.
      const roleDenied = assertRole(ctx, ['developer'], 'claim_story', flow.project);
      if (roleDenied) {
        return {
          ok: false,
          error:
            `${roleDenied} Verificá tus roles con whoami. Para tomar una story necesitás el rol developer ` +
            `en el workspace "${flow.project}" — incluso si sos tech-lead: implementar y verificar el mismo ` +
            'cambio son roles distintos a propósito. Pedí a un admin que te asigne el rol developer en ese ' +
            'workspace desde el panel admin (Workspaces → miembros) y volvé a loguearte para que el token ' +
            'traiga el rol nuevo; si la story es de otra persona, que la tome quien la va a implementar.',
        };
      }

      // Un flow abandonado no reparte trabajo nuevo.
      const abortedDenied = assertFlowNotAborted(flow, 'claim_story');
      if (abortedDenied) return { ok: false, error: abortedDenied };

      if (input.developer_id !== ctx.userId) {
        return {
          ok: false,
          error: 'developer_id must match the authenticated userId (ctx.userId)',
        };
      }

      const buildBundle = async (s: typeof story) => {
        const promptBundle = await catalog.getRolePrompt('developer', 'implement', scenarioForStory(flow, s));
        return {
          story: s,
          rfc_ref: flow.rfc_ref ?? null,
          epic_external_id: flow.epic_external_id ?? null,
          architecture_mode: flow.architecture_mode ?? null,
          codebase_status: flow.codebase_status ?? null,
          ...storyTargetFields(flow, s),
          skills: promptBundle.skills,
        };
      };

      // Sólo se llama con el claim ya aceptado: un rechazo nunca emite lease. Un
      // re-claim emite uno nuevo y el store revoca el anterior de la story.
      const gateLease = async (s: typeof story) =>
        gate?.enabled
          ? {
              gate_lease: await issueStoryLease(gate.store, {
                tenantId: ctx.tenantId,
                workspaceId: flow.project,
                storyId: s.story_id,
                flowId: flow.flow_id,
                userId: ctx.userId,
              }),
            }
          : {};

      if (story.status === 'claimed' && story.assignee === input.developer_id) {
        return {
          ok: true,
          data: { ...(await buildBundle(story)), idempotent: true, ...(await gateLease(story)) },
          next_actions: ['report_progress({status:"in_progress"})'],
        };
      }
      if (story.status !== 'created') {
        return {
          ok: false,
          error: `Cannot claim story: already claimed by ${story.assignee ?? 'unknown'} (status=${story.status})`,
        };
      }

      const taskSystem = await taskSystemProvider.resolve(ctx, flow);
      await taskSystem.transition(story.external_id, 'Active', ctx);
      const updated = await store.updateStory(story.story_id, {
        status: 'claimed',
        assignee: input.developer_id,
      });
      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'story.claimed',
        actor: ctx.userId,
        payload: {
          story_id: story.story_id,
          external_id: story.external_id,
          developer_id: input.developer_id,
        },
      });

      return {
        ok: true,
        data: { ...(await buildBundle(updated)), ...(await gateLease(updated)) },
        next_actions: ['report_progress({status:"in_progress"})'],
      };
    },
  };
}
