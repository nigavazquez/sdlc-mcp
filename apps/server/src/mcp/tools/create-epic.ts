import { z } from 'zod';
import { EpicInput } from '@sdlc/core';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { TaskSystemProvider } from '../../adapters/task-system-provider.js';
import type { FlowStore } from '../../state/index.js';
import { resolveFlowForCtx } from './flow-access.js';
import { assertRole } from './role-guard.js';
import { crearEpic } from './backlog-core.js';

export const CreateEpicInput = z.object({
  flow_id: z.string().min(1),
  epic: EpicInput,
});
export type CreateEpicInput = z.infer<typeof CreateEpicInput>;

export function makeCreateEpicTool(store: FlowStore, taskSystemProvider: TaskSystemProvider) {
  return {
    name: 'create_epic',
    description:
      'Creates the epic for the flow in the external task system and persists its external id on the flow. Requires status=rfc_ready.',
    inputSchema: CreateEpicInput,
    handler: async (input: CreateEpicInput, ctx: TenantCtx) => {
      const resolved = await resolveFlowForCtx(store, ctx, input.flow_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const flow = resolved.flow;

      // Guarda de rol antes de cualquier side-effect, y acá el orden importa de
      // verdad: `taskSystem.createEpic` escribe en el sistema externo de tareas y no
      // hay rollback. El catálogo le asigna `shaping` a `pmo`; `tech-lead` como
      // break-glass.
      const roleDenied = assertRole(ctx, ['pmo', 'tech-lead'], 'create_epic', flow.project);
      if (roleDenied) {
        return {
          ok: false,
          error:
            `${roleDenied} Verificá tus roles con whoami y pedile a alguien con rol pmo o tech-lead en ` +
            'ese workspace que ejecute create_epic.',
        };
      }

      // Un flow `aborted` no llega acá: el status requerido es `rfc_ready`.
      if (flow.status !== 'rfc_ready') {
        return {
          ok: false,
          error: `Cannot create epic: flow status is "${flow.status}", expected "rfc_ready".`,
        };
      }
      if (flow.epic_external_id) {
        return {
          ok: false,
          error: `Epic already created for this flow: ${flow.epic_external_id}.`,
        };
      }

      const taskSystem = await taskSystemProvider.resolve(ctx, flow);
      const { ref, flow: updated } = await crearEpic(store, taskSystem, flow, input.epic, ctx);

      return {
        ok: true,
        data: { epic_ref: ref, flow: updated },
        next_actions: ['create_stories'],
      };
    },
  };
}
