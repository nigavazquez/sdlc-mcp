import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { RoleId } from '@sdlc/core';

export interface TestCtxOptions {
  tenantId?: string;
  userId?: string;
  roles?: RoleId[];
  /**
   * Workspaces del ctx. Como lista de ids (heredan `roles`) o como el mapa completo
   * del claim. Default: `['demo']`.
   */
  workspaces?: string[] | Record<string, RoleId[]>;
  resolveSecret?: TenantCtx['resolveSecret'];
}

/**
 * Ctx de test **con el claim `workspaces` siempre presente**.
 *
 * Existe porque `assertWorkspaceAccess` dejó de fallar abierto: un ctx sin el claim ya no
 * pasa las guardas de workspace. La alternativa era prender SDLC_ALLOW_UNSCOPED_CTX en la
 * config de tests, pero el flag prendido esconde justamente el bug que arreglamos —con el
 * bypass global ningún test volvería a ver la guarda. Así, cada test declara a qué
 * workspaces pertenece su usuario y las guardas corren de verdad en toda la suite.
 *
 * Para el caso "usuario sin membresía" no uses este helper con `workspaces: []` a ciegas:
 * mirá `test/tools-workspace-access.test.ts`, que construye el ctx ajeno a mano.
 */
export function testCtx(opts: TestCtxOptions = {}): TenantCtx {
  const roles = opts.roles ?? (['developer'] as RoleId[]);
  const requested = opts.workspaces ?? ['demo'];
  const workspaces = Array.isArray(requested)
    ? Object.fromEntries(requested.map((id) => [id, roles]))
    : requested;
  return {
    tenantId: opts.tenantId ?? 'default',
    userId: opts.userId ?? 'tester',
    roles,
    workspaces,
    resolveSecret:
      opts.resolveSecret ??
      (async () => {
        throw new Error('resolveSecret no está stubbeado en este test');
      }),
  };
}
