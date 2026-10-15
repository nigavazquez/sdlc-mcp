# sdlc-mcp Framework Configurable (OSS) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convertir `sdlc-mcp` en un framework self-host reusable: identidad OIDC genérica, modelo `workspace`/`group` config-driven (sin seeds ni nombres propios), y contenido/infra sin "Acme-ismos".

**Architecture:** Rename del dominio `squad`→`workspace` en todas las capas (DB, claim JWT, ctx, tools, API, SPA) + `group` opcional como metadato. Broker OIDC genérico reemplaza al de Google. Un `sdlc.config.yaml` declarativo, validado con zod y reconciliado al boot, pasa a ser la fuente de verdad de la estructura (reemplaza el seed SQL). El panel admin muta en runtime; los secretos siguen por `SecretResolver`.

**Tech Stack:** el existente (Fastify, Drizzle/Postgres, zod, vitest, React/Vite, `googleapis`→`openid-client` para OIDC). Se agrega `yaml` y `openid-client`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-12-oss-configurable-framework-design.md`.
- Los tests corren **sin DB ni IdP** (in-memory + fakes). `ctx` sin `workspaces` no bloquea acceso (compat dev/tests).
- TDD estricto: test que falla → mínimo código → verde. Commits frecuentes con el trailer del repo (`Co-Authored-By: Claude ...`).
- Single-tenant: `tenantId` default = `default` (ya no `acme`).
- Los labels visibles (workspace/group singular/plural) vienen de config; **nunca** hardcodear "squad"/"tribu" en textos nuevos.
- Verificación por tarea: `pnpm --filter @sdlc/server typecheck && pnpm --filter @sdlc/server test` (o `npx turbo run typecheck test --force` para el monorepo).
- No borrar datos en reconciliación: crear/actualizar y loguear drift.

## Rename map (referencia para las tareas A*)

| Antes | Después |
|---|---|
| `squads` (jsonb claim/field/var) | `workspaces` |
| `squad_id` | `workspace_id` |
| `SquadRecord`, `listSquads`, `getSquad`, `createSquad` | `WorkspaceRecord`, `listWorkspaces`, `getWorkspace`, `createWorkspace` |
| `Membership.squad_id`, `listMembers(squadId)`, `removeMember(email, squadId)` | `workspace_id`, `listMembers(workspaceId)`, `removeMember(email, workspaceId)` |
| `assertSquadAccess` | `assertWorkspaceAccess` (`assertFlowAccess` queda igual) |
| tabla `squads` / `squad_members` | `workspaces` / `workspace_members` |
| `/admin/api/squads*` | `/admin/api/workspaces*` |

> `assertFlowAccess(ctx, flow)` ya es genérico y usa `flow.project` como id de workspace. **No** se renombra `flows.project` en este plan (ver Task A8, opcional) porque `tenant_integrations` también keyea por `project` y los adapters lo usan como project key externo; se documenta que `project` == workspace id.

---

## Workstream A — Modelo de dominio: `workspace` + `group`

### Task A1: Migración 0009 + drizzle schema

**Files:**
- Create: `apps/server/migrations/0009_workspaces.sql`
- Modify: `apps/server/src/state/schema.ts:116-158` (renombrar tablas/columnas, agregar `groups`)
- Test: `apps/server/test/migration-0009.test.ts`

**Interfaces:**
- Produces: tablas `workspaces(workspace_id, name, group_id, created_at)`, `workspace_members(email, workspace_id, roles, created_at)`, `groups(group_id, name, created_at)`; columnas `oauth_codes.workspaces`, `oauth_refresh_tokens.workspaces` (jsonb). Exports drizzle: `workspaces`, `workspace_members`, `groups` (reemplazan `squads`, `squad_members`).

- [ ] **Step 1: Escribir el test de migración (falla)**

```ts
// apps/server/test/migration-0009.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(join(__dirname, '../migrations/0009_workspaces.sql'), 'utf8');

describe('migración 0009 (squads → workspaces)', () => {
  it('renombra tablas y columnas preservando datos (usa RENAME, no DROP)', () => {
    expect(sql).toMatch(/ALTER TABLE "squads" RENAME TO "workspaces"/);
    expect(sql).toMatch(/ALTER TABLE "squad_members" RENAME TO "workspace_members"/);
    expect(sql).toMatch(/RENAME COLUMN "squad_id" TO "workspace_id"/);
    expect(sql).toMatch(/ALTER TABLE "oauth_codes" RENAME COLUMN "squads" TO "workspaces"/);
    expect(sql).toMatch(/ALTER TABLE "oauth_refresh_tokens" RENAME COLUMN "squads" TO "workspaces"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "groups"/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "group_id"/);
    expect(sql).not.toMatch(/\bDROP TABLE\b/);
  });
});
```

- [ ] **Step 2: Correr y ver fallar**

Run: `pnpm --filter @sdlc/server test migration-0009`
Expected: FAIL (archivo `0009_workspaces.sql` no existe).

- [ ] **Step 3: Escribir la migración**

```sql
-- 0009_workspaces.sql — squads → workspaces + groups (config-driven, sin seed).
ALTER TABLE "squads"        RENAME TO "workspaces";
ALTER TABLE "workspaces"    RENAME COLUMN "squad_id" TO "workspace_id";
ALTER TABLE "squad_members" RENAME TO "workspace_members";
ALTER TABLE "workspace_members" RENAME COLUMN "squad_id" TO "workspace_id";
ALTER INDEX IF EXISTS "squad_members_squad_idx" RENAME TO "workspace_members_workspace_idx";

ALTER TABLE "oauth_codes"          RENAME COLUMN "squads" TO "workspaces";
ALTER TABLE "oauth_refresh_tokens" RENAME COLUMN "squads" TO "workspaces";

CREATE TABLE IF NOT EXISTS "groups" (
  "group_id"   text PRIMARY KEY,
  "name"       text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "group_id" text;
```

- [ ] **Step 4: Actualizar `schema.ts`**

Reemplazar los exports `squads` y `squad_members` (líneas ~141-158) por:

```ts
export const workspaces = pgTable('workspaces', {
  workspace_id: text('workspace_id').primaryKey(),
  name: text('name').notNull(),
  group_id: text('group_id'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workspace_members = pgTable(
  'workspace_members',
  {
    email: text('email').notNull(),
    workspace_id: text('workspace_id').notNull(),
    roles: jsonb('roles').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.email, t.workspace_id] }) }),
);

export const groups = pgTable('groups', {
  group_id: text('group_id').primaryKey(),
  name: text('name').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Y renombrar la columna jsonb `squads` → `workspaces` en `oauth_codes` (línea 118) y `oauth_refresh_tokens` (línea 131): `workspaces: jsonb('workspaces').notNull().default({}),`.

- [ ] **Step 5: Correr test + typecheck**

Run: `pnpm --filter @sdlc/server test migration-0009 && pnpm --filter @sdlc/server typecheck`
Expected: test PASS; typecheck falla en consumidores de `squads`/`squad_members` (se arreglan en A3–A6). Anotar los errores; es esperado hasta A6.

- [ ] **Step 6: Commit**

```bash
git add apps/server/migrations/0009_workspaces.sql apps/server/src/state/schema.ts apps/server/test/migration-0009.test.ts
git commit -m "feat(workspaces): migración 0009 + schema (squads→workspaces + groups)"
```

### Task A2: `TenantCtx.squads` → `workspaces`

**Files:**
- Modify: `packages/adapters-contracts/src/tenant-context.ts:8`
- Test: (cubierto por los tests de tools en A5)

**Interfaces:**
- Produces: `TenantCtx.workspaces?: Record<string, RoleId[]>`.

- [ ] **Step 1: Renombrar el campo**

En `tenant-context.ts` cambiar `squads?` por `workspaces?` y el comentario a "Roles por workspace (claim del JWT)".

- [ ] **Step 2: Typecheck (falla en consumidores)**

Run: `pnpm --filter @sdlc/adapters-contracts typecheck`
Expected: PASS en el paquete (no tiene consumidores internos). El server compila recién tras A4/A5.

- [ ] **Step 3: Commit**

```bash
git add packages/adapters-contracts/src/tenant-context.ts
git commit -m "feat(workspaces): TenantCtx.squads → workspaces"
```

### Task A3: `DirectoryStore` → workspace_id

**Files:**
- Modify: `apps/server/src/oauth/directory-store.ts`, `directory-in-memory.ts`, `directory-postgres.ts`
- Test: `apps/server/test/directory-store.test.ts`

**Interfaces:**
- Produces: `Membership { email; workspace_id; roles; created_at }`; `listMembers(workspaceId)`, `upsertMember({ email, workspace_id, roles })`, `removeMember(email, workspaceId)`.

- [ ] **Step 1: Actualizar el test primero** — en `directory-store.test.ts`, reemplazar `squad_id`→`workspace_id` y `squadId`→`workspaceId` en assertions y llamadas.

- [ ] **Step 2: Correr y ver fallar**

Run: `pnpm --filter @sdlc/server test directory-store`
Expected: FAIL (tipos/campos `workspace_id` no existen aún).

- [ ] **Step 3: Aplicar el rename** en los tres archivos:

```bash
cd apps/server/src/oauth
perl -0777 -i -pe 's/\bsquad_id\b/workspace_id/g; s/\bsquadId\b/workspaceId/g; s/squad_members/workspace_members/g;' directory-store.ts directory-in-memory.ts directory-postgres.ts
```

En `directory-postgres.ts` verificar que el import de la tabla drizzle apunte a `workspace_members` (renombrado en A1) y el `onConflictDoUpdate` target sea `[workspace_members.email, workspace_members.workspace_id]`.

- [ ] **Step 4: Correr test**

Run: `pnpm --filter @sdlc/server test directory-store`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/oauth/directory-*.ts apps/server/test/directory-store.test.ts
git commit -m "feat(workspaces): DirectoryStore email↔workspace"
```

### Task A4: Claim `squads` → `workspaces` (stores OAuth + routes + bearer)

**Files:**
- Modify: `apps/server/src/oauth/oauth-store.ts`, `oauth-in-memory.ts`, `oauth-postgres.ts`, `oauth/routes.ts`, `auth/oauth-bearer.ts`
- Test: `apps/server/test/oauth-flow.test.ts`, `oauth-store.test.ts`, `oauth-bearer.test.ts`

**Interfaces:**
- Consumes: `Membership.workspace_id` (A3), `TenantCtx.workspaces` (A2).
- Produces: grants con `workspaces: Record<string,string[]>`; JWT claim `workspaces`; `ctx.workspaces` armado en el bearer.

- [ ] **Step 1: Actualizar tests** (`oauth-flow`, `oauth-store`, `oauth-bearer`): reemplazar el claim/campo `squads`→`workspaces` y en el fixture de membresías `squad_id`→`workspace_id`. En `oauth-flow` el callback ahora arma `workspaces[m.workspace_id] = m.roles`.

- [ ] **Step 2: Ver fallar**

Run: `pnpm --filter @sdlc/server test oauth-`
Expected: FAIL.

- [ ] **Step 3: Rename en producción**

```bash
cd apps/server/src
perl -0777 -i -pe 's/\bsquads\b/workspaces/g; s/\bsquad_id\b/workspace_id/g;' \
  oauth/oauth-store.ts oauth/oauth-in-memory.ts oauth/oauth-postgres.ts auth/oauth-bearer.ts
```

En `oauth/routes.ts`, reemplazar el bloque del callback (líneas ~179-187):

```ts
// workspaces = mapa workspace_id → roles; roles = unión (compat con clientes que sólo miran `roles`).
const workspaces: Record<string, string[]> = {};
for (const m of memberships) workspaces[m.workspace_id] = m.roles;
const roles = [...new Set(memberships.flatMap((m) => m.roles))];
const code = await deps.oauthStore.issueCode({
  email,
  tenant_id: config.tenantId,
  roles,
  workspaces,
  client_id: state.client_id as string,
  redirect_uri: state.redirect_uri as string,
  code_challenge: state.code_challenge as string,
});
```

Y en `routes.ts` renombrar `squads`→`workspaces` en la firma de `issueTokens` (líneas ~203-224) y el mensaje de error del callback: el texto usará el label configurable (se ajusta en C3; por ahora "workspace").

- [ ] **Step 4: Ver pasar**

Run: `pnpm --filter @sdlc/server test oauth-`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/oauth apps/server/src/auth apps/server/test/oauth-*
git commit -m "feat(workspaces): claim JWT squads→workspaces (AS + bearer)"
```

### Task A5: Tools `assertSquadAccess` → `assertWorkspaceAccess`

**Files:**
- Modify: `apps/server/src/mcp/tools/squad-access.ts` → renombrar a `workspace-access.ts`; todas las tools que lo importan.
- Test: `apps/server/test/tools-squad-access.test.ts` → `tools-workspace-access.test.ts`, `squad-access.test.ts` → `workspace-access.test.ts`.

**Interfaces:**
- Produces: `assertWorkspaceAccess(ctx, workspaceId): string | null`, `assertFlowAccess(ctx, flow)` (sin cambios de nombre).

- [ ] **Step 1: Renombrar archivos y símbolos**

```bash
cd apps/server/src/mcp/tools
git mv squad-access.ts workspace-access.ts
perl -0777 -i -pe 's/assertSquadAccess/assertWorkspaceAccess/g' workspace-access.ts
grep -rl "assertSquadAccess\|squad-access" . | xargs perl -0777 -i -pe 's/assertSquadAccess/assertWorkspaceAccess/g; s{\./squad-access\.js}{./workspace-access.js}g;'
cd ../../../test
git mv tools-squad-access.test.ts tools-workspace-access.test.ts
git mv squad-access.test.ts workspace-access.test.ts
perl -0777 -i -pe 's/assertSquadAccess/assertWorkspaceAccess/g; s/squad-access/workspace-access/g; s/\bsquads\b/workspaces/g; s/squad ajeno/workspace ajeno/g;' tools-workspace-access.test.ts workspace-access.test.ts
```

En los tests actualizar el fixture `ctxForeign()`: `workspaces: { platform: ['developer'] }` y el mensaje esperado sigue conteniendo el `workspace_id` ajeno (`finance-erp`).

- [ ] **Step 2: Actualizar el mensaje del helper** en `workspace-access.ts`: `No tenés acceso al workspace "${workspaceId}". Tus workspaces: ...` (el label fino se parametriza en C3).

- [ ] **Step 3: Ver pasar**

Run: `pnpm --filter @sdlc/server test workspace-access`
Expected: PASS (15 tests).

- [ ] **Step 4: Commit**

```bash
git add -A apps/server/src/mcp/tools apps/server/test
git commit -m "feat(workspaces): assertWorkspaceAccess (rename squad-access)"
```

### Task A6: AdminStore + rutas admin + API path + SPA

**Files:**
- Modify: `apps/server/src/admin/store.ts`, `admin/in-memory.ts`, `admin/postgres.ts`, `admin/routes.ts`
- Modify: `apps/admin/src/api.ts`, `apps/admin/src/App.tsx`, `apps/admin/src/pages/Squads.tsx`→`Workspaces.tsx`, `pages/SquadDetail.tsx`→`WorkspaceDetail.tsx`
- Test: `apps/server/test/admin-store.test.ts`, `admin-routes.test.ts`

**Interfaces:**
- Produces: `WorkspaceRecord { workspace_id; name; group_id?; created_at }`; `AdminStore.listWorkspaces/getWorkspace/createWorkspace`; rutas `GET/POST /admin/api/workspaces`, `/admin/api/workspaces/:id/*`.

- [ ] **Step 1: Actualizar tests** (`admin-store`, `admin-routes`): `SquadRecord`→`WorkspaceRecord`, `listSquads`→`listWorkspaces`, path `/admin/api/squads`→`/admin/api/workspaces`, `squad_id`→`workspace_id`.

- [ ] **Step 2: Ver fallar**

Run: `pnpm --filter @sdlc/server test admin-`
Expected: FAIL.

- [ ] **Step 3: Rename en store + rutas**

```bash
cd apps/server/src/admin
perl -0777 -i -pe 's/SquadRecord/WorkspaceRecord/g; s/listSquads/listWorkspaces/g; s/getSquad/getWorkspace/g; s/createSquad/createWorkspace/g; s/\bsquad_id\b/workspace_id/g; s{/admin/api/squads}{/admin/api/workspaces}g; s/\bsquads\b/workspaces/g;' store.ts in-memory.ts postgres.ts routes.ts
```

En `store.ts` agregar `group_id?: string` a `WorkspaceRecord` y a `createWorkspace(input)`.

- [ ] **Step 4: Rename en SPA**

```bash
cd apps/admin/src
git mv pages/Squads.tsx pages/Workspaces.tsx
git mv pages/SquadDetail.tsx pages/WorkspaceDetail.tsx
grep -rl "Squad\|squad" . | xargs perl -0777 -i -pe 's/SquadDetail/WorkspaceDetail/g; s/\bSquads\b/Workspaces/g; s{/admin/api/squads}{/admin/api/workspaces}g; s/squad_id/workspace_id/g;'
```

Los textos visibles ("Squads", "Squad") se dejan como default temporal; se reemplazan por el label configurable en C3.

- [ ] **Step 5: Ver pasar (server) + build (admin)**

Run: `pnpm --filter @sdlc/server test admin- && pnpm --filter @sdlc/admin build`
Expected: PASS + build OK.

- [ ] **Step 6: Commit**

```bash
git add -A apps/server/src/admin apps/admin/src apps/server/test/admin-*
git commit -m "feat(workspaces): AdminStore + /admin/api/workspaces + SPA"
```

### Task A7: `groups` (metadato opcional)

**Files:**
- Modify: `apps/server/src/admin/store.ts`, `in-memory.ts`, `postgres.ts`, `admin/routes.ts`
- Test: `apps/server/test/admin-store.test.ts`

**Interfaces:**
- Produces: `GroupRecord { group_id; name; created_at }`; `AdminStore.listGroups(): Promise<GroupRecord[]>`, `createGroup({ group_id, name })`; workspace opcionalmente referencia `group_id`; `GET /admin/api/groups`.

- [ ] **Step 1: Test (falla)**

```ts
// admin-store.test.ts
it('lista y crea groups, y un workspace puede referenciar uno', async () => {
  const store = new InMemoryAdminStore();
  await store.createGroup({ group_id: 'tribe-a', name: 'Tribe A' });
  const ws = await store.createWorkspace({ workspace_id: 'w1', name: 'W1', group_id: 'tribe-a' });
  expect(ws.group_id).toBe('tribe-a');
  expect((await store.listGroups()).map((g) => g.group_id)).toContain('tribe-a');
});
```

- [ ] **Step 2: Ver fallar** — Run: `pnpm --filter @sdlc/server test admin-store` → FAIL (`createGroup`/`listGroups` no existen).

- [ ] **Step 3: Implementar** `GroupRecord` + métodos en `store.ts`/`in-memory.ts`/`postgres.ts` (postgres usa la tabla `groups` de A1) y `app.get('/admin/api/groups', ...)` en `routes.ts`.

- [ ] **Step 4: Ver pasar** — Run: `pnpm --filter @sdlc/server test admin-store` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/server/src/admin apps/server/test/admin-store.test.ts
git commit -m "feat(workspaces): groups como metadato opcional"
```

### Task A8 (OPCIONAL): `flows.project` → `workspace_id`

> Diferible. Alto acoplamiento: `tenant_integrations.project` y los adapters usan `project` como project key externo. Solo hacer si se decide unificar la nomenclatura. Si se hace: migración `RENAME COLUMN project TO workspace_id` en `flows` y `tenant_integrations`, actualizar `schema.ts`, y `grep -rl "\.project\b" apps/server/src/mcp apps/server/src/adapters` para cada uso. Verificar con la suite completa.

---

## Workstream B — Identidad OIDC genérica

### Task B1: Broker OIDC genérico

**Files:**
- Create: `apps/server/src/oauth/oidc.ts`
- Modify: `apps/server/src/oauth/factory.ts` (elegir OIDC), `oauth/index.ts` (export)
- Delete: `apps/server/src/oauth/google.ts` (tras migrar; conservar como preset documentado)
- Test: `apps/server/test/oidc-provider.test.ts`
- Deps: `pnpm --filter @sdlc/server add openid-client`

**Interfaces:**
- Produces: `interface IdentityProvider { authUrl(input:{state:string;redirectUri:string}): string; exchangeCode(input:{code:string;redirectUri:string}): Promise<{ email:string }> }` y `class OidcIdentityProvider implements IdentityProvider` construida desde `{ discoveryUrl, clientId, clientSecret, scopes }`.
- Consumes (routes A4): `deps.google` se renombra a `deps.idp: IdentityProvider | undefined`.

- [ ] **Step 1: Test con discovery fake (falla)**

```ts
// oidc-provider.test.ts — valida que authUrl arma el redirect con state y scopes,
// usando un discovery document inyectado (sin red).
import { describe, expect, it } from 'vitest';
import { OidcIdentityProvider } from '../src/oauth/oidc.js';

describe('OidcIdentityProvider', () => {
  it('authUrl incluye client_id, redirect_uri, state y scope openid email', async () => {
    const idp = await OidcIdentityProvider.fromMetadata({
      metadata: {
        issuer: 'https://idp.example',
        authorization_endpoint: 'https://idp.example/authorize',
        token_endpoint: 'https://idp.example/token',
        jwks_uri: 'https://idp.example/jwks',
      },
      clientId: 'cid',
      clientSecret: 'sec',
      scopes: ['openid', 'email'],
    });
    const url = new URL(idp.authUrl({ state: 'st', redirectUri: 'https://app/cb' }));
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app/cb');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('scope')).toContain('email');
  });
});
```

- [ ] **Step 2: Ver fallar** — Run: `pnpm --filter @sdlc/server test oidc-provider` → FAIL.

- [ ] **Step 3: Implementar `oidc.ts`** con `openid-client`: `static async fromDiscovery({discoveryUrl,...})` (hace discovery por red) y `static async fromMetadata({metadata,...})` (para tests), `authUrl` (con PKCE/state ya provistos por el AS) y `exchangeCode` que valida el id_token y devuelve `{ email }` (exige `email_verified`).

- [ ] **Step 4: Ver pasar** — Run: `pnpm --filter @sdlc/server test oidc-provider` → PASS.

- [ ] **Step 5: Cablear factory + routes** — en `factory.ts` construir `OidcIdentityProvider.fromDiscovery` si hay `auth.oidc`; renombrar `deps.google`→`deps.idp` y el tipo en `routes.ts` (los 503 y el `authUrl`/`exchangeCode` no cambian de forma). Borrar `google.ts`.

- [ ] **Step 6: Ver pasar la suite OAuth** — Run: `pnpm --filter @sdlc/server test oauth- oidc-` → PASS.

- [ ] **Step 7: Commit**

```bash
git add -A apps/server
git commit -m "feat(auth): broker OIDC genérico (Google pasa a ser config)"
```

### Task B2: `allowedEmailDomains` en vez de `hostedDomain`

**Files:**
- Modify: `apps/server/src/config.ts`, `oauth/routes.ts:154-159` (validación de dominio), `factory.ts`
- Test: `apps/server/test/oauth-flow.test.ts`

**Interfaces:**
- Produces: `config.allowedEmailDomains: string[]` (vacío = sin restricción). Se elimina `googleHostedDomain` y el `hd` de Google.

- [ ] **Step 1: Test** — en `oauth-flow`, un email cuyo dominio no está en `allowedEmailDomains` da 403; con lista vacía, cualquier email verificado pasa (si tiene membresía).

- [ ] **Step 2: Ver fallar** — Run: `pnpm --filter @sdlc/server test oauth-flow` → FAIL.

- [ ] **Step 3: Implementar** — reemplazar el chequeo `identity.hostedDomain !== config.hostedDomain` por: si `config.allowedEmailDomains.length` y el dominio del email no está incluido → 403. Quitar `hostedDomain` de `OAuthRoutesConfig` y del `authUrl`. En `config.ts` cambiar `googleHostedDomain` por `allowedEmailDomains: z.string().default('')` (CSV → array en el loader).

- [ ] **Step 4: Ver pasar** — Run: `pnpm --filter @sdlc/server test oauth-flow` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/server
git commit -m "feat(auth): allowedEmailDomains reemplaza googleHostedDomain"
```

---

## Workstream C — Configuración declarativa + labels

### Task C1: Schema + loader de `sdlc.config.yaml`

**Files:**
- Create: `apps/server/src/config/file-config.ts`
- Modify: `apps/server/src/config.ts` (integrar carga del archivo)
- Test: `apps/server/test/file-config.test.ts`
- Deps: `pnpm --filter @sdlc/server add yaml`

**Interfaces:**
- Produces:
```ts
export interface FileConfig {
  tenantId: string;
  labels: { workspace: { singular: string; plural: string }; group: { singular: string; plural: string } };
  adminEmails: string[];
  auth?: { oidc?: { discoveryUrl: string; clientId: string; clientSecretRef: string; scopes: string[] }; allowedEmailDomains: string[] };
  groups: Array<{ id: string; name: string }>;
  workspaces: Array<{ id: string; name: string; group?: string; adapters?: { backlog?: string; docs?: string; pr?: string } }>;
}
export function loadFileConfig(path: string): FileConfig | null; // null si el archivo no existe
```

- [ ] **Step 1: Test (falla)**

```ts
// file-config.test.ts
import { describe, expect, it } from 'vitest';
import { parseFileConfig } from '../src/config/file-config.js';

describe('parseFileConfig', () => {
  it('parsea workspaces, groups y labels con defaults', () => {
    const cfg = parseFileConfig(`
tenantId: acme
labels: { workspace: { singular: squad, plural: squads } }
workspaces:
  - { id: revenue, name: Revenue, group: growth }
groups:
  - { id: growth, name: Growth }
`);
    expect(cfg.tenantId).toBe('acme');
    expect(cfg.labels.workspace.singular).toBe('squad');
    expect(cfg.labels.group.singular).toBe('group'); // default
    expect(cfg.workspaces[0]).toMatchObject({ id: 'revenue', group: 'growth' });
  });

  it('rechaza un workspace sin id', () => {
    expect(() => parseFileConfig('workspaces: [{ name: X }]')).toThrow();
  });
});
```

- [ ] **Step 2: Ver fallar** — Run: `pnpm --filter @sdlc/server test file-config` → FAIL.

- [ ] **Step 3: Implementar** `file-config.ts`: `parseFileConfig(yamlText)` con zod (defaults para labels: workspace→{workspace,workspaces}, group→{group,groups}) y `loadFileConfig(path)` que lee el archivo (null si no existe) y llama a `parseFileConfig`.

- [ ] **Step 4: Ver pasar** — Run: `pnpm --filter @sdlc/server test file-config` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/server
git commit -m "feat(config): schema + loader de sdlc.config.yaml"
```

### Task C2: Reconciliación al boot

**Files:**
- Create: `apps/server/src/config/reconcile.ts`
- Modify: `apps/server/src/index.ts` (llamar reconcile tras construir stores)
- Test: `apps/server/test/reconcile.test.ts`

**Interfaces:**
- Consumes: `FileConfig` (C1), `AdminStore` (A6/A7).
- Produces: `reconcileStructure(store: AdminStore, cfg: FileConfig, log): Promise<{ created: string[]; drift: string[] }>` — crea groups/workspaces faltantes, no borra, y devuelve en `drift` los ids que están en el store pero no en el config.

- [ ] **Step 1: Test (falla)**

```ts
// reconcile.test.ts
it('crea workspaces/groups faltantes y reporta drift sin borrar', async () => {
  const store = new InMemoryAdminStore();
  await store.createWorkspace({ workspace_id: 'legacy', name: 'Legacy' });
  const res = await reconcileStructure(store, {
    tenantId: 'default', adminEmails: [], groups: [{ id: 'g', name: 'G' }],
    workspaces: [{ id: 'revenue', name: 'Revenue', group: 'g' }],
    labels: { workspace: { singular: 'workspace', plural: 'workspaces' }, group: { singular: 'group', plural: 'groups' } },
  } as any, { info() {}, warn() {} } as any);
  expect(res.created).toContain('revenue');
  expect(res.drift).toContain('legacy');           // presente en store, ausente en config
  expect(await store.getWorkspace('legacy')).toBeDefined(); // NO se borró
});
```

- [ ] **Step 2: Ver fallar** — Run: `pnpm --filter @sdlc/server test reconcile` → FAIL.

- [ ] **Step 3: Implementar** `reconcile.ts`: crea groups primero, luego workspaces (idempotente vía `getWorkspace` antes de `createWorkspace`); computa `drift` comparando `listWorkspaces()` vs config; `log.warn` por cada drift. Cablear en `index.ts`: si `loadFileConfig(config.sdlcConfigPath)` no es null y hay `DATABASE_URL`, correr reconcile al boot.

- [ ] **Step 4: Ver pasar** — Run: `pnpm --filter @sdlc/server test reconcile` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/server
git commit -m "feat(config): reconciliación de estructura al boot (reemplaza seed SQL)"
```

### Task C3: Labels configurables en API + SPA + mensajes

**Files:**
- Modify: `apps/server/src/admin/routes.ts` (exponer labels en un endpoint `GET /admin/api/meta`), `apps/admin/src/App.tsx` (consumir labels), `apps/server/src/mcp/tools/workspace-access.ts` y `oauth/routes.ts` (mensajes con label)
- Test: `apps/server/test/admin-routes.test.ts`

**Interfaces:**
- Consumes: `FileConfig.labels`.
- Produces: `GET /admin/api/meta` → `{ labels }`; los textos de UI y el mensaje de "sin alta" usan `labels.workspace.singular`.

- [ ] **Step 1: Test** — `GET /admin/api/meta` devuelve los labels configurados; con label `squad`, el mensaje del 403 de callback dice "no pertenece a ningún squad".

- [ ] **Step 2: Ver fallar** — Run: `pnpm --filter @sdlc/server test admin-routes` → FAIL.

- [ ] **Step 3: Implementar** endpoint `/admin/api/meta`, pasar `labels` a `OAuthRoutesConfig` para el mensaje del callback, y en el SPA leer `/admin/api/meta` para los títulos ("Squads"/"Workspaces"/lo que sea). El helper `assertWorkspaceAccess` recibe el label como parámetro opcional (default "workspace").

- [ ] **Step 4: Ver pasar** — Run: `pnpm --filter @sdlc/server test admin-routes && pnpm --filter @sdlc/admin build` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A apps/server apps/admin
git commit -m "feat(config): labels configurables (workspace/group) en API, SPA y mensajes"
```

---

## Workstream D — Contenido neutro de catálogo y adapters

### Task D1: Neutralizar el catálogo

**Files:**
- Modify: `packages/catalog/roles/**/**.md`, `packages/catalog/skills/*.md`, `packages/catalog/templates/*.md`, `catalog.yaml`
- Test: `apps/server/test/catalog.smoke.test.ts` (ya existe; agregar assertion de neutralidad)

- [ ] **Step 1: Test (falla)** — agregar al smoke test:

```ts
it('el catálogo no contiene referencias a nombres propios de la org', () => {
  const dump = JSON.stringify(catalog); // o leer los .md
  expect(dump.toLowerCase()).not.toMatch(/acme|revenue-growth|finance-erp/);
});
```

- [ ] **Step 2: Ver fallar** — Run: `pnpm --filter @sdlc/server test catalog.smoke` → FAIL si hay refs.

- [ ] **Step 3: Editar** los `.md` que mencionen la org / squads propios → texto neutro/genérico. `CATALOG_ROOT` para override ya existe (verificar en el test de override existente).

- [ ] **Step 4: Ver pasar** — Run: `pnpm --filter @sdlc/server test catalog.smoke` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/catalog apps/server/test/catalog.smoke.test.ts
git commit -m "chore(catalog): contenido neutro, override por CATALOG_ROOT"
```

### Task D2: Documentar selección de adapters por config

**Files:**
- Modify: `docs/ARCHITECTURE.md` (sección adapters), `docs/CONNECTING_CLIENTS.md`
- (Sin cambios de código: `IntegrationConfigStore` ya resuelve por workspace/project.)

- [ ] **Step 1: Documentar** cómo `sdlc.config.yaml` mapea `workspaces[].adapters` a los providers (`memory` default) y cómo agregar un adapter propio implementando `adapters-contracts`. Ejemplo mínimo con `backlog: github`.

- [ ] **Step 2: Commit**

```bash
git add docs
git commit -m "docs(adapters): selección por config y cómo agregar el propio"
```

---

## Workstream E — Higiene OSS

### Task E1: Defaults neutros + scrub

**Files:**
- Modify: `apps/server/src/config.ts` (`tenantId` default `default`), `infra/*` (placeholders), `docs/*`, `examples/*`
- Test: `apps/server/test/config.test.ts`

- [ ] **Step 1: Test** — `loadConfig()` con env vacío da `tenantId === 'default'` y `allowedEmailDomains === []`.

- [ ] **Step 2: Ver fallar** — Run: `pnpm --filter @sdlc/server test config` → FAIL (default sigue `acme`).

- [ ] **Step 3: Implementar** cambios de default; `grep -rniI "acme" apps packages infra docs examples` y reemplazar por placeholders (`your-org`, `example.com`).

- [ ] **Step 4: Ver pasar** — Run: `pnpm --filter @sdlc/server test config` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(oss): defaults neutros (tenant=default) + scrub de nombres propios"
```

### Task E2: LICENSE, CONTRIBUTING, ejemplos y README

**Files:**
- Create: `LICENSE` (MIT), `CONTRIBUTING.md`, `.env.example`, `sdlc.config.example.yaml`
- Modify: `README.md`

- [ ] **Step 1: Crear** `LICENSE` (MIT, año 2026, holder a definir), `CONTRIBUTING.md` (setup dev, TDD, cómo correr tests), `.env.example` (todas las env con comentarios), `sdlc.config.example.yaml` (un group + dos workspaces + preset OIDC Google comentado).

- [ ] **Step 2: Reescribir `README.md`** como framework genérico: qué es, quickstart in-memory, quickstart con Postgres + `sdlc.config.yaml`, cómo conectar un cliente MCP, cómo elegir/agregar adapters. Sin "MCP compartido de una sola organización".

- [ ] **Step 3: Verificación final** — Run: `npx turbo run typecheck test build --force`
Expected: todo verde.

- [ ] **Step 4: Commit + PR**

```bash
git add -A
git commit -m "docs(oss): LICENSE (MIT) + CONTRIBUTING + .env.example + sdlc.config.example + README"
```

---

## Self-Review

**Cobertura del spec:**
- A (rename squad→workspace + group + migración): Tasks A1–A7 (A8 opcional para `flows.project`). ✅
- B (OIDC genérico + allowedEmailDomains): Tasks B1–B2. ✅
- C (config declarativa + reconcile + labels): Tasks C1–C3. ✅
- D (de-Acme catálogo/adapters): Tasks D1–D2. ✅
- E (higiene OSS): Tasks E1–E2. ✅
- No-goals respetados (sin multi-tenant, sin group-claims→roles, sin extraer adapters, sin loop de dogfooding). ✅

**Consistencia de tipos:** `workspace_id`/`workspaces`/`WorkspaceRecord`/`assertWorkspaceAccess` usados consistente entre A1–A7 y consumidos por B/C. `IdentityProvider`/`OidcIdentityProvider` definidos en B1 y usados por B2. `FileConfig` definido en C1 y consumido por C2/C3.

**Orden de ejecución:** A1→A2→A3→A4→A5→A6→A7 dejan la suite verde recién al final de A6 (A1 rompe typecheck a propósito). Luego B, C, D, E son independientes entre sí. Si se ejecuta con subagentes, A debe correr secuencial; B/C/D/E pueden paralelizarse tras A.

**Riesgo principal:** el rename de A toca ~30 archivos; cada task Ax verifica su slice, pero el typecheck global recién cierra en A6. Mantener los commits por task para poder bisectar.
