import type { TenantCtx } from '@sdlc/adapters-contracts';
import { allowsUnscopedCtx } from '../../config.js';

/**
 * Autorización por workspace para las tools de escritura. Exige que el ctx traiga el
 * claim `workspaces` (login MCP real) y que tenga membresía en `workspaceId`.
 *
 * Sin claim NO pasa. Antes sí pasaba —un fail-open deliberado para no romper los flujos
 * in-memory de tests y fakes— y el costo real era que un access token válidamente firmado
 * pero sin el claim (uno emitido antes de que el claim existiera, o un refresh token viejo
 * de 30 días de esa época) pasaba todas las guardas de workspace. El escape hatch quedó
 * detrás de SDLC_ALLOW_UNSCOPED_CTX, apagado por default y sólo para tests/dev local.
 *
 * Devuelve un mensaje de error si el acceso está denegado, o `null` si pasa.
 */
export function assertWorkspaceAccess(ctx: TenantCtx, workspaceId: string, workspaceLabel = 'workspace'): string | null {
  if (!ctx.workspaces) {
    if (allowsUnscopedCtx()) return null;
    return (
      `No tenés acceso al ${workspaceLabel} "${workspaceId}": tu token no trae el claim "workspaces", ` +
      `así que no hay membresía que verificar. Volvé a autenticarte contra el MCP (borrá el token cacheado ` +
      `del cliente y repetí el login OAuth) para obtener uno con tus ${workspaceLabel}s. ` +
      `Sólo para tests y desarrollo local: arrancá el proceso con SDLC_ALLOW_UNSCOPED_CTX=true.`
    );
  }
  if (Object.prototype.hasOwnProperty.call(ctx.workspaces, workspaceId)) return null;
  const own = Object.keys(ctx.workspaces);
  return own.length
    ? `No tenés acceso al ${workspaceLabel} "${workspaceId}". Tus ${workspaceLabel}s: ${own.join(', ')}. ` +
        `Reintentá contra uno de esos, o pedí a un admin que te agregue al ${workspaceLabel} "${workspaceId}" ` +
        `desde el panel admin (Workspaces → miembros) y volvé a loguearte para que el token traiga la membresía nueva.`
    : `No tenés acceso al ${workspaceLabel} "${workspaceId}". Tus ${workspaceLabel}s: (ninguno). ` +
        `Pedí a un admin que te agregue al ${workspaceLabel} "${workspaceId}" desde el panel admin ` +
        `(Workspaces → miembros) y volvé a loguearte para que el token traiga la membresía.`;
}

/**
 * Guarda combinada tenant + workspace para las tools de escritura, aplicada apenas se
 * resuelve el `flow` y antes de cualquier side-effect. Verifica que el flow sea del
 * tenant del ctx y que el usuario pertenezca al workspace dueño del flow (`flow.project`).
 *
 * Devuelve un mensaje de error si el acceso está denegado, o `null` si pasa.
 */
export function assertFlowAccess(
  ctx: TenantCtx,
  flow: { tenant_id: string; project: string },
): string | null {
  // El texto se mantiene igual (y en inglés) porque otras seis tools devuelven esta
  // misma cadena literal y hay tests que la matchean. Uniformarla es otro cambio.
  if (flow.tenant_id !== ctx.tenantId) return 'Flow belongs to a different tenant';
  return assertWorkspaceAccess(ctx, flow.project);
}
