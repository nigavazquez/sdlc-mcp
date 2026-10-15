import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { Flow, Story } from '@sdlc/core';
import type { FlowStore } from '../../state/index.js';
import { assertFlowAccess, assertWorkspaceAccess } from './workspace-access.js';

/**
 * Resultado de leer el workspace de un id de recurso.
 *
 * Los tres casos se distinguen porque el caller responde distinto a cada uno, y la
 * diferencia entre los dos de error es deliberada: un id ajeno se nombra como tal,
 * un id que no tiene forma de id es un typo y se responde "no existe".
 */
export type ResourceIdParse =
  | { kind: 'ok'; workspaceId: string }
  | { kind: 'other-tenant' }
  | { kind: 'unaddressable' };

/**
 * Saca el `workspace_id` de un `flow_id` (`tenant:project:slug`) o de un `story_id`
 * (`flow_id::external_id`), **sin tocar el store**. `flow.project` *es* el
 * `workspace_id`, así que el id ya dice a qué workspace pertenece el recurso.
 *
 * No es un `split(':')[1]`: se saca el prefijo `${ctx.tenantId}:`, que es un valor
 * conocido, y recién ahí se lee hasta el próximo `:`. `tenantId` sale de `TENANT_ID`
 * como `z.string().default('default')`, sin restricción de charset, así que un
 * `TENANT_ID=a:b` haría que un split ingenuo devolviera el segmento equivocado.
 */
export function workspaceFromResourceId(ctx: TenantCtx, id: string): ResourceIdParse {
  const prefix = `${ctx.tenantId}:`;
  if (!id.startsWith(prefix)) {
    // Con separador y otro prefijo tiene forma de id de otro tenant; sin separador
    // no es direccionable y lo tratamos como inexistente.
    return id.includes(':') ? { kind: 'other-tenant' } : { kind: 'unaddressable' };
  }
  const rest = id.slice(prefix.length);
  const end = rest.indexOf(':');
  const workspaceId = end === -1 ? rest : rest.slice(0, end);
  if (!workspaceId) return { kind: 'unaddressable' };
  return { kind: 'ok', workspaceId };
}

export type FlowResolution =
  | { ok: true; flow: Flow }
  | { ok: false; error: string };

/**
 * Resuelve un flow y autoriza el acceso, en ese orden y en un solo lugar.
 *
 * Los cuatro primeros pasos **no leen el store**, y eso es el diseño y no una
 * optimización: como el id nombra el workspace, se puede denegar antes de saber si el
 * recurso existe. Para un no-miembro la respuesta es entonces idéntica exista o no el
 * flow, que es lo que cierra el oráculo. Para un miembro el paso 5 sigue diciendo "no
 * existe": quien pasó el paso 4 podría ver ese flow si existiera, así que decírselo no
 * filtra nada y mantiene debuggeable un typo.
 *
 * Devuelve una unión discriminada, no `Flow | null` más un mensaje aparte, para que el
 * caller no pueda usar el flow sin haber mirado el `ok`.
 */
export async function resolveFlowForCtx(
  store: FlowStore,
  ctx: TenantCtx,
  flowId: string,
): Promise<FlowResolution> {
  const parsed = workspaceFromResourceId(ctx, flowId);
  if (parsed.kind === 'other-tenant') {
    return { ok: false, error: 'Flow belongs to a different tenant' };
  }
  if (parsed.kind === 'unaddressable') {
    return { ok: false, error: `Unknown flow: ${flowId}` };
  }

  const deniedByClaim = assertWorkspaceAccess(ctx, parsed.workspaceId);
  if (deniedByClaim) return { ok: false, error: deniedByClaim };

  const flow = await store.getFlow(flowId);
  if (!flow) return { ok: false, error: `Unknown flow: ${flowId}` };

  // Backstop contra el record cargado: el parseo es una heurística sobre un string
  // del caller, la autoridad es el record.
  const denied = assertFlowAccess(ctx, flow);
  if (denied) return { ok: false, error: denied };

  return { ok: true, flow };
}

export type StoryResolution =
  | { ok: true; story: Story; flow: Flow }
  | { ok: false; error: string };

/**
 * Igual que `resolveFlowForCtx` pero entrando por `story_id`, que es
 * `flow_id::external_id` — así que el mismo parseo da el workspace y el gate temprano
 * corre idéntico, sin leer el store.
 *
 * Devuelve las dos entidades porque los nueve callers usan las dos.
 */
export async function resolveStoryForCtx(
  store: FlowStore,
  ctx: TenantCtx,
  storyId: string,
): Promise<StoryResolution> {
  const parsed = workspaceFromResourceId(ctx, storyId);
  if (parsed.kind === 'other-tenant') {
    return { ok: false, error: 'Flow belongs to a different tenant' };
  }
  if (parsed.kind === 'unaddressable') {
    // El sustantivo es el del recurso que pidió el caller: decir "Unknown flow" sobre
    // un story_id lo manda a buscar el recurso equivocado.
    return { ok: false, error: `Unknown story: ${storyId}` };
  }

  const deniedByClaim = assertWorkspaceAccess(ctx, parsed.workspaceId);
  if (deniedByClaim) return { ok: false, error: deniedByClaim };

  const story = await store.getStory(storyId);
  if (!story) return { ok: false, error: `Unknown story: ${storyId}` };

  // El flow se resuelve por el camino completo: vuelve a pasar por el gate y por el
  // backstop, que es lo que cubre una story cuyo flow_id apunta a otro workspace.
  const resolvedFlow = await resolveFlowForCtx(store, ctx, story.flow_id);
  if (!resolvedFlow.ok) return { ok: false, error: resolvedFlow.error };

  return { ok: true, story, flow: resolvedFlow.flow };
}
