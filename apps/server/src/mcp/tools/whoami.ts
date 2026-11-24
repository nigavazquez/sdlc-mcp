import { z } from 'zod';
import type { Catalog } from '@sdlc/catalog';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { AdminStore } from '../../admin/store.js';
import { workspaceSelfSignoff } from '../../admin/self-signoff.js';

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
export function makeWhoamiTool(catalog: Catalog, adminStore?: AdminStore) {
  return {
    name: 'whoami',
    description:
      'Returns the authenticated tenant, user and roles, plus the catalog version this server runs. Use this to verify the connection and entitlements before invoking other tools.',
    inputSchema: WhoamiInput,
    handler: async (_input: WhoamiInput, ctx: TenantCtx) => {
      // Si la persona puede firmar su propio QA y review en cada uno de sus workspaces:
      // es lo que decide si una historia suya se puede cerrar sin otra persona.
      const selfSignoff: Record<string, boolean> = {};
      for (const ws of Object.keys(ctx.workspaces ?? {})) {
        selfSignoff[ws] = await workspaceSelfSignoff(adminStore, ws);
      }
      return {
        ok: true,
        data: {
          tenant_id: ctx.tenantId,
          user_id: ctx.userId,
          roles: ctx.roles,
          catalog_version: catalog.version,
          catalog_digest: catalog.seal?.digest ?? null,
          self_signoff: selfSignoff,
        },
      };
    },
  };
}
