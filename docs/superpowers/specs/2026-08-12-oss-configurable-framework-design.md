# sdlc-mcp como framework self-host configurable — Design

**Fecha:** 2026-08-12
**Objetivo:** Convertir `sdlc-mcp` de un deploy con la identidad de una sola organización horneada
a un **framework self-host reusable**: cualquier equipo (desde un freelancer con
varias empresas cliente hasta una compañía con tribus y squads) lo clona y lo corre
con SU identidad, SU estructura organizativa, SUS adapters — sin editar SQL ni código.

## Motivación

El proyecto ya tiene los cimientos correctos (contratos de adapters, factory con
fakes in-memory como default, `IntegrationConfigStore` por workspace). Lo que bloquea
el open-source son "org-ismos" concretos:

1. Seed de 5 squads con nombre propio en la migración `0008`.
2. Google como único IdP (`oauth/google.ts`) + `googleHostedDomain` default `example.com`.
3. `tenantId` default `acme`.
4. Catálogo de roles/skills con posible contenido específico de la organización.
5. Vocabulario "squad" (jerga interna) en tools, claim JWT, API y tablas.

## Decisiones tomadas (brainstorming)

- **Objetivo:** framework self-host reusable, máxima abstracción. La organización original es un usuario más.
- **Identidad:** OIDC genérico; Google pasa a ser una config de OIDC de ejemplo.
- **Modelo:** entidad genérica `workspace` (relabelable) + `group` opcional (metadato);
  config-driven; single-tenant por deploy. **Rename completo** `squad`→`workspace`.
- **Config:** archivo declarativo `sdlc.config.yaml` como fuente de verdad de la
  estructura, reconciliado al boot; panel admin muta en runtime; secrets por `SecretResolver`.
- **Dogfooding** (usar el propio MCP para desarrollarlo): **spec aparte**, después.

## Alcance

Este spec cubre cinco workstreams. Son razonablemente independientes; en la fase de
plan se secuencian (A dominio+migración → B OIDC → C/D/E config+hygiene). Pueden
partirse en specs separados si se prefiere.

### A. Modelo de dominio: `squad` → `workspace` + `group`

`workspace` reemplaza a `squad` en **todas** las capas:

| Capa | Antes | Después |
|---|---|---|
| Tool helper | `assertSquadAccess` | `assertWorkspaceAccess` (`assertFlowAccess` queda igual) |
| Claim JWT | `squads` | `workspaces` |
| Ctx | `TenantCtx.squads` | `TenantCtx.workspaces` |
| API | `/admin/api/squads` | `/admin/api/workspaces` |
| Tabla | `squads` | `workspaces` |
| Tabla | `squad_members` | `workspace_members` (`email, workspace_id, roles`) |
| Columna | `flows.project` | `flows.workspace_id` |
| Grants | `oauth_codes.squads`, `oauth_refresh_tokens.squads` | `...workspaces` |

- **`group`**: nueva tabla `groups (group_id, name)` + `workspaces.group_id` nullable.
  Es metadato de agrupación (tribu/departamento/cliente). **No** es frontera de auth ni
  de config de integración.
- **Labels configurables**: `labels.workspace{singular,plural}` y `labels.group{...}`
  en `sdlc.config.yaml`, usados **solo** en textos de UI y mensajes de error. No afectan
  rutas, keys, claims ni nombres de tabla.
- **Single-tenant**: `tenantId` default pasa de `acme` a `default`. El workspace es
  la unidad de aislamiento (auth vía `assertFlowAccess`, credenciales vía
  `IntegrationConfigStore`, membresía). Un freelancer usa un workspace por cliente en un
  único deploy; si un cliente exige aislamiento físico, corre un deploy aparte. **No** se
  implementa multi-tenant real.
- **Migración `0009_workspaces.sql`**: `ALTER TABLE ... RENAME` de tablas/columnas +
  rename del claim en las columnas jsonb; backfill sin pérdida de datos; crea `groups`
  y `workspaces.group_id`. Idempotente (`IF EXISTS`).

**Cómo sirve a las dos personas:**

| Persona | workspace | group | tenant |
|---|---|---|---|
| Freelancer | uno por cliente (creds propias, miembro = él) | — | 1 deploy |
| Empresa | squad | tribu | 1 deploy |

### B. Identidad: OIDC genérico

- `oauth/google.ts` se generaliza a `oauth/oidc.ts`: config `auth.oidc` con
  `issuer`/`discoveryUrl`, `clientId`, `clientSecretRef`, `scopes[]`,
  `claimMappings{ email, name }`. El broker usa OIDC discovery (PKCE + state ya existen).
- **Google** queda documentado como preset (su discovery URL + scopes), sin código especial.
- `googleHostedDomain` (default `example.com`) → `auth.allowedEmailDomains: string[]`
  opcional y genérico (vacío = sin restricción de dominio).
- **Membresía sigue en el directorio** (seed por config / panel). El IdP solo autentica
  identidad (email verificado). Mapear group-claims del IdP a roles queda **fuera de scope**.
- Se conserva el path dev sin IdP (fakes in-memory; `ctx` sin `workspaces` no bloquea) para
  probar el framework sin levantar un IdP.

### C. Configuración declarativa + panel runtime

- **`sdlc.config.yaml`** (path por `SDLC_CONFIG`, default `./sdlc.config.yaml`) = fuente de
  verdad de la estructura:
  - `tenantId`, `labels`, `adminEmails[]`
  - `auth.oidc` + `auth.allowedEmailDomains`
  - `groups[]` (`id`, `name`)
  - `workspaces[]` (`id`, `name`, `group?`, `adapters{ backlog, docs, pr }`)
- **Reconciliación al boot**: upsert de groups/workspaces/labels; **nunca borra**
  automáticamente (loguea drift para que el operador decida). Reemplaza al seed SQL de `0008`.
- **Secrets**: nunca en el YAML. Se referencian por `SecretResolver`
  (`aws-sm://…` / `env`). Las credenciales de integración por workspace siguen en
  `IntegrationConfigStore` (env/AWS SM), no en el YAML.
- **Panel admin**: muta en runtime (miembros, config de integración por workspace). El YAML
  es el estado base reproducible/versionable (GitOps-friendly).
- Si no hay YAML y no hay `DATABASE_URL`: arranque in-memory sin estructura (modo demo),
  igual que hoy.

### D. Adapters y catálogo (contenido neutro)

- Adapters **in-repo como opcionales**, seleccionables por config (`memory` default).
  ADO/GitHub/Google Drive/AWS-SM son genéricos y sirven de ejemplo/uso real. Se documenta
  cómo agregar uno propio implementando `adapters-contracts`.
- **Catálogo neutro por default**: revisar y limpiar contenido específico de la organización en los
  `role.md` / `phases/*.md` / `skills/*.md` / `templates/*.md`. Override vía `CATALOG_ROOT`
  (ya existe). Se deja **preparado** el hook para que el bundle de `skills` de una fase pueda
  referenciar skills externas (p. ej. superpowers), pero el loop de dogfooding es spec aparte.

### E. Higiene OSS

- `LICENSE` (a elegir), `CONTRIBUTING.md`, `.env.example` completo, `sdlc.config.example.yaml`.
- Scrub de secretos y nombres propios en `docs/`, `examples/`, `infra/` (compose/terraform
  con placeholders).
- README reescrito como framework genérico (no "MCP compartido de una sola organización").
- Definir scope de package: mantener `@sdlc/*` o renombrar a algo neutro (decisión abierta,
  se resuelve en el plan).

## No-goals (YAGNI)

- Multi-tenant real (varios tenants aislados en un mismo deploy).
- Mapeo de group-claims del IdP a roles/workspaces.
- Extracción de adapters a paquetes npm separados.
- El loop de dogfooding completo (catalog→superpowers, workspace propio, adapters livianos).
- SAML/LDAP como IdP (solo OIDC).

## Testing

- **A:** tests existentes de squads renombrados; el suite `tools-workspace-access` (ex
  `tools-squad-access`) sigue verde; test de migración `0009` (backfill preserva datos).
- **B:** test del broker OIDC con un discovery fake (issuer/jwks stub); Google deja de tener
  test especial. Se conserva el path sin IdP.
- **C:** test de reconciliación al boot desde un `sdlc.config.yaml` de fixture (crea/actualiza,
  no borra, loguea drift); validación zod del schema de config.
- **D:** catálogo neutro carga; override por `CATALOG_ROOT` sigue funcionando.
- Toda estructura de tests actual (in-memory + fakes, sin DB ni IdP) se mantiene.

## Riesgos

- **A es el de mayor blast radius**: toca casi todo lo shippeado en la feature de squads,
  incluida una migración con backfill. Es ~60% del esfuerzo. Se mitiga haciéndolo pre-OSS
  (sin consumidores externos) y con tests de migración.
- Rename del claim JWT `squads`→`workspaces` invalida tokens vigentes: aceptable (tokens
  cortos, pre-release).
