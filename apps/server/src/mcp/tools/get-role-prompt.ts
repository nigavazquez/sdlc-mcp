import { z } from 'zod';
import { Catalog, type ScenarioContext } from '@sdlc/catalog';
import { PhaseId, RoleId } from '@sdlc/core';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';
import { resolveFlowForCtx } from './flow-access.js';

export const GetRolePromptInput = z.object({
  role: RoleId,
  phase: PhaseId,
  flow_id: z.string().min(1).optional(),
});
export type GetRolePromptInput = z.infer<typeof GetRolePromptInput>;

export function makeGetRolePromptTool(catalog: Catalog, store: FlowStore) {
  return {
    name: 'get_role_prompt',
    description:
      'Returns the system prompt, skills and templates that the IDE-side agent must inject for the given role+phase. If flow_id is supplied and the flow has architecture_mode/codebase_status set (populated at submit_rfc), additional scenario skills are merged into the bundle.',
    inputSchema: GetRolePromptInput,
    handler: async (input: GetRolePromptInput, ctx: TenantCtx) => {
      let scenario: ScenarioContext | undefined;
      // `flow_id` es opcional y eso define el alcance de la guarda: autorizamos cuando
      // hay un flow que autorizar, no siempre.
      //
      // No exigimos membresía cuando no viene `flow_id` porque ahí no hay workspace
      // contra el cual chequear —¿membresía en cuál?— y lo que se devuelve es catálogo:
      // prompts, skills y templates que son contenido del servidor, iguales para todos,
      // sin un solo dato de cliente adentro. Exigir membresía "siempre" tendría que
      // inventar un workspace de referencia, y además rompería el arranque legítimo: el
      // agente pide el prompt de su rol antes de que exista cualquier flow.
      //
      // Cuando sí viene `flow_id`, la guarda es la misma que en el resto: aunque el
      // prompt sea público, `architecture_mode`/`codebase_status` de un flow ajeno son
      // datos de ese flow, y las skills de escenario que se mergean los delatan por
      // presencia. Que el dato salga envuelto en algo público no lo hace público.
      if (input.flow_id) {
        const resolved = await resolveFlowForCtx(store, ctx, input.flow_id);
        if (!resolved.ok) return { ok: false, error: resolved.error };
        const flow = resolved.flow;
        const scenarioObj: ScenarioContext = {};
        if (flow.architecture_mode) scenarioObj.architecture_mode = flow.architecture_mode;
        if (flow.codebase_status) scenarioObj.codebase_status = flow.codebase_status;
        if (flow.initiative_type) scenarioObj.initiative_type = flow.initiative_type;
        scenario = scenarioObj;
      }
      const bundle = await catalog.getRolePrompt(input.role, input.phase, scenario);
      return {
        ok: true,
        data: bundle,
        // La secuencia la declara la fase en su frontmatter; ver Catalog.getNextActions.
        next_actions: await catalog.getNextActions(input.role, input.phase),
      };
    },
  };
}
