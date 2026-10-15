import { z } from 'zod';
import { Catalog } from '@sdlc/catalog';
import type { TenantCtx } from '@sdlc/adapters-contracts';

export const ListRolesInput = z.object({});
export type ListRolesInput = z.infer<typeof ListRolesInput>;

export function makeListRolesTool(catalog: Catalog) {
  return {
    name: 'list_roles',
    description:
      'Lists all SDLC roles available in the catalog (product-manager, tech-lead, pmo, developer, qa, reviewer) and the phases each role can drive.',
    inputSchema: ListRolesInput,
    handler: async (_input: ListRolesInput, _ctx: TenantCtx) => {
      return {
        ok: true,
        data: {
          catalog_version: catalog.version,
          roles: catalog.listRoles(),
        },
      };
    },
  };
}
