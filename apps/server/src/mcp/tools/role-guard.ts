import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { RoleId } from '@sdlc/core';

/**
 * Roles efectivos del ctx para un workspace dado.
 *
 * Cuando el token trae el claim `workspaces`, los roles de ese workspace son los
 * que mandan: pertenecer al tenant no habilita a firmar en un workspace donde no
 * tenés el rol. Sin claim se usan los roles de tenant del token.
 */
export function effectiveRoles(ctx: TenantCtx, workspaceId?: string): RoleId[] {
  if (workspaceId && ctx.workspaces) {
    return ctx.workspaces[workspaceId] ?? [];
  }
  return ctx.roles ?? [];
}

/**
 * Exige que el ctx tenga alguno de los roles habilitados para `action`.
 *
 * Fail-closed a propósito: un ctx sin roles no pasa. La alternativa —dejar pasar
 * cuando no hay información— es el mismo fail-open que ya nos costó la
 * autorización por workspace, y acá el precio sería que cualquier actor firme
 * cualquier fase.
 *
 * Devuelve un mensaje de error si el acceso está denegado, o `null` si pasa.
 */
export function assertRole(
  ctx: TenantCtx,
  allowed: readonly RoleId[],
  action: string,
  workspaceId?: string,
): string | null {
  const mine = effectiveRoles(ctx, workspaceId);
  if (mine.some((r) => allowed.includes(r))) return null;
  const scope = workspaceId ? ` en "${workspaceId}"` : '';
  const own = mine.length ? mine.join(', ') : '(ninguno)';
  return `${action} requiere rol ${allowed.join(' o ')}. Tus roles${scope}: ${own}.`;
}

/**
 * Separación de funciones: quien implementó la story no puede firmar su propia
 * verificación.
 *
 * Los chequeos de identidad que ya existían (`claim_story`, `report_progress`)
 * **atan** al actor a la story; éste lo **excluye** de las fases que verifican su
 * trabajo. Sin esto, un mismo `user_id` recorre claim → QA → review sin que nada
 * lo impida.
 *
 * Una story sin `assignee` no tiene contra qué comparar y no se bloquea acá: el
 * único camino a `in_progress` / `in_review` pasa por `claim_story`, que siempre
 * lo setea, así que el caso es anómalo y lo cubren las guardas de status.
 *
 * Devuelve un mensaje de error si el acceso está denegado, o `null` si pasa.
 */
export function assertNotSelfSignoff(
  ctx: TenantCtx,
  story: { story_id: string; assignee?: string | undefined },
  action: string,
): string | null {
  if (!story.assignee) return null;
  if (story.assignee !== ctx.userId) return null;
  return (
    `${action}: ${ctx.userId} tiene asignada la story ${story.story_id} y no puede firmar ` +
    'la verificación de su propio trabajo. Pedile a otra persona que lo haga.'
  );
}
