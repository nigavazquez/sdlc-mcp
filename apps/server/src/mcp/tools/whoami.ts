import { z } from 'zod';
import type { Catalog } from '@sdlc/catalog';
import type { TenantCtx } from '@sdlc/adapters-contracts';

export const WhoamiInput = z.object({});
export type WhoamiInput = z.infer<typeof WhoamiInput>;

/**
 * Identidad + contra qué catálogo corre este server.
 *
 * La versión y el digest van acá porque el cliente que recibe los prompts es el único
 * que puede notar que cambiaron: dos deploys con el mismo `catalog_version` pero distinto
 * digest son dos catálogos distintos, y sin exponerlo eso se descubre leyendo prompts.
 * El digest es el **sellado** (el que declara `catalog.yaml`), no uno calculado por
 * llamada: recalcularlo sería leer todo el catálogo en cada `whoami`. `null` cuando el
 * catálogo no está sellado — mejor null que un número que no se puede verificar.
 */
export function makeWhoamiTool(catalog: Catalog) {
  return {
    name: 'whoami',
    description:
      'Returns the authenticated tenant, user and roles, plus the catalog version this server runs. Use this to verify the connection and entitlements before invoking other tools.',
    inputSchema: WhoamiInput,
    handler: async (_input: WhoamiInput, ctx: TenantCtx) => ({
      ok: true,
      data: {
        tenant_id: ctx.tenantId,
        user_id: ctx.userId,
        roles: ctx.roles,
        catalog_version: catalog.version,
        catalog_digest: catalog.seal?.digest ?? null,
      },
    }),
  };
}
