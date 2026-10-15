import { z } from 'zod';
import { InitiativeType, trackForInitiative, type RoleId } from '@sdlc/core';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { slugify, type FlowStore } from '../../state/index.js';
import { assertWorkspaceAccess } from './workspace-access.js';
import { assertRole } from './role-guard.js';

export const StartFlowInput = z.object({
  project: z.string().min(1),
  title: z.string().min(3),
  /** Tipo de iniciativa del proyecto: improvement | feature | refactor | fix. */
  initiative_type: InitiativeType,
  description: z.string().optional(),
  slug: z.string().optional(),
});
export type StartFlowInput = z.infer<typeof StartFlowInput>;

export function makeStartFlowTool(store: FlowStore) {
  return {
    name: 'start_flow',
    description:
      'Starts a new SDLC flow for the tenant. `project` is the workspace_id and `initiative_type` (improvement|feature|refactor|fix) is required. Returns the flow_id used by every subsequent tool call. Always call this first; the flow goes through PRD → RFC → shaping → implementation → QA → review.',
    inputSchema: StartFlowInput,
    handler: async (input: StartFlowInput, ctx: TenantCtx) => {
      // El project es el workspace_id: exigir membresía si el ctx trae el claim `workspaces`.
      const denied = assertWorkspaceAccess(ctx, input.project);
      if (denied) return { ok: false, error: denied };

      // Guarda de rol antes de cualquier side-effect: abrir la iniciativa es el
      // primer eslabón, y sin esto un solo `developer` recorría PRD → RFC →
      // shaping → claim → in_review sin que nada lo detuviera.
      //
      // Ojo con el `workspaceId`: acá el flow todavía no existe, así que el
      // workspace contra el que se evalúan los roles es `input.project` —el mismo
      // que después queda como `flow.project`— y no el de un flow que buscar.
      //
      // Los tres roles que abren iniciativas: `product-manager` porque el flow
      // arranca en `prd-discovery`, que el catálogo le asigna; `pmo` porque dueñea
      // el backlog y la planificación; `tech-lead` como el break-glass que ya usan
      // el resto de las guardas.
      //
      // Y `developer` cuando la iniciativa va por el track liviano, que es el punto
      // del track: un fix arranca donde aparece el bug, y hasta acá quien lo
      // encontraba no podía ni abrir el flow. No afloja nada aguas abajo —la nota de
      // cambio se valida igual y las gates de QA y review no se tocan— y el tipo de
      // iniciativa queda en el evento `flow.started`, así que declarar una feature
      // como fix para colarse es visible.
      const abrenIniciativa: RoleId[] =
        trackForInitiative(input.initiative_type) === 'lite'
          ? ['product-manager', 'tech-lead', 'pmo', 'developer']
          : ['product-manager', 'tech-lead', 'pmo'];
      const roleDenied = assertRole(ctx, abrenIniciativa, 'start_flow', input.project);
      if (roleDenied) {
        return {
          ok: false,
          error:
            `${roleDenied} Verificá tus roles con whoami y pedile a alguien con rol ` +
            `${abrenIniciativa.join(', ')} en ese workspace que ejecute start_flow.` +
            // Un developer rebotado en una feature merece saber que existe la otra
            // puerta, sin que eso suene a "declarala fix y pasás".
            (trackForInitiative(input.initiative_type) === 'lite'
              ? ''
              : ' Si el cambio es chico de verdad, un fix o improvement lo puede abrir un developer.'),
        };
      }

      const slug = input.slug?.trim() ? slugify(input.slug) : slugify(input.title);
      const existing = await store.getFlow(`${ctx.tenantId}:${input.project}:${slug}`);
      if (existing) {
        return {
          ok: false,
          error: `A flow with this slug already exists for project "${input.project}". Pick a different title or pass an explicit "slug".`,
          data: { flow_id: existing.flow_id },
        };
      }
      const flow = await store.createFlow({
        tenant_id: ctx.tenantId,
        project: input.project,
        slug,
        title: input.title,
        initiative_type: input.initiative_type,
      });
      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'flow.started',
        actor: ctx.userId,
        payload: { title: input.title, description: input.description ?? null },
      });
      return {
        ok: true,
        data: flow,
        next_actions: ['get_role_prompt({role:"product-manager", phase:"prd-draft"})', 'submit_prd'],
      };
    },
  };
}
