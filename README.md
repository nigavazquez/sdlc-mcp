# sdlc-mcp

Un **servidor MCP** que orquesta el ciclo de desarrollo tradicional con agentes
especializados por rol, configurable para cualquier organización.

A diferencia de las herramientas de Spec-Driven Development, `sdlc-mcp` **no impone
un método nuevo**. Mantiene el flujo SDLC clásico — PRD → RFC → tareas en el backlog →
implementación → QA → code review — pero obliga a que cada fase la acompañe un agente
con system prompt, skills y templates curados por tu equipo.

El MCP **no ejecuta los agentes**: entrega el prompt correcto según rol y fase, y
orquesta los efectos en sistemas externos (backlog, docs, PRs) vía adapters.

**Todo lo específico de tu organización es configuración**, no código: los workspaces
y su agrupación, cómo se llaman (`squads`/`tribus`, `teams`/`departments`, lo que
uses), el proveedor de identidad OIDC, los adapters de cada workspace y el catálogo
de prompts.

- **Licencia:** MIT · **Requisitos:** Node 20+, pnpm 9+ · Postgres opcional
- **25 tools MCP** registradas, ~850 tests (unit + integración).
- Arquitectura y roadmap: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Conceptos

| Concepto | Qué es |
|---|---|
| **Workspace** | La unidad de trabajo y de permisos. La membresía `(email, workspace) → roles` es lo que autoriza el login MCP y las tools de escritura. |
| **Group** | Agrupación opcional de workspaces. Puro metadato: no otorga permisos. |
| **Labels** | Cómo se muestran esos dos conceptos en la API, el panel y los mensajes de error. Configurable. |
| **Rol** | `product-manager`, `tech-lead`, `pmo`, `developer`, `qa`, `reviewer`. Cada uno con prompt + skills + templates por fase. |
| **Flow** | Una iniciativa recorriendo las fases, con su estado y audit trail. |
| **Adapter** | La integración concreta con el backlog / doc store / sistema de PRs de cada workspace. |

## Quickstart (in-memory, sin Postgres)

Sin `DATABASE_URL` el server usa `InMemoryFlowStore`: ideal para probar y para demos.
El estado se pierde al reiniciar.

```bash
# Requisitos: Node 20+, pnpm 9+
pnpm install
cp apps/server/.env.example apps/server/.env

pnpm turbo run build
pnpm --filter @sdlc/server dev   # tsx watch, http://localhost:3000

# O los dos pasos anteriores juntos:
pnpm local
```

Flujo completo Fase 1 (PRD → RFC end-to-end):

```bash
./examples/01-prd-rfc/run.sh
```

El script levanta su propio server en el puerto 3030 si nadie escucha ahí, corre el
flujo entero con un PRD/RFC reales y muestra el audit trail.

## Quickstart (Postgres + `sdlc.config.yaml`)

```bash
# 1. Postgres
docker compose -f infra/compose.yml up -d postgres

# 2. Migraciones
DATABASE_URL="postgres://sdlc:sdlc@localhost:5432/sdlc" \
  pnpm --filter @sdlc/server db:migrate

# 3. Estructura de tu organización
cp sdlc.config.example.yaml sdlc.config.yaml   # editar workspaces, groups, labels

# 4. Server
DATABASE_URL="postgres://sdlc:sdlc@localhost:5432/sdlc" \
SDLC_CONFIG=../../sdlc.config.yaml \
  pnpm --filter @sdlc/server dev
```

Verificar que `GET /health` devuelve `"store": "postgres"`.

### Qué hace `sdlc.config.yaml`

```yaml
tenantId: default

labels:                                   # cómo llamás a los conceptos
  workspace: { singular: squad, plural: squads }
  group: { singular: tribu, plural: tribus }

auth:
  allowedEmailDomains: [example.com]
  oidc:
    discoveryUrl: https://accounts.google.com/.well-known/openid-configuration
    clientId: ...
    clientSecretRef: aws-sm://sdlc/oidc#client_secret

groups:
  - { id: product, name: Product }

workspaces:
  - { id: platform, name: Platform, group: product }
  - { id: growth, name: Growth, group: product }
```

- Los **labels** se leen siempre (también en modo in-memory) y los consumen la API
  (`GET /admin/api/meta`), el SPA y los mensajes de autorización.
- La **estructura** (groups + workspaces) se reconcilia al boot cuando hay
  `DATABASE_URL`: es idempotente, crea lo que falta y **nunca borra**. Lo que existe
  en la base pero no en el archivo se loguea como *drift* (`warn`).
- El path por defecto es `./sdlc.config.yaml` relativo al cwd; overrideable con
  `SDLC_CONFIG`. En Docker el cwd es `/app`, así que alcanza con montarlo ahí.

**Precedencia frente a las env vars:** el archivo **gana** campo por campo y env
rellena lo que el archivo omite. Un campo presente pero vacío
(`allowedEmailDomains: []`) es una decisión explícita y también gana. El bloque
`auth.oidc` gana entero, y su `clientSecretRef` se resuelve por el backend de
secretos, así que acepta `aws-sm://<name>#<key>`. Al boot el server loguea de qué
fuente salió cada valor (`effective config resolved`).

Los **adapters no se declaran en este archivo**: viven en `tenant_integrations`,
editable desde el panel, porque esa fila lleva además las referencias de
credenciales que el YAML no tiene dónde expresar.

Referencia completa y comentada: [`sdlc.config.example.yaml`](sdlc.config.example.yaml).

## Identidad

El login es **OIDC genérico**: cualquier proveedor con discovery document sirve
(Google, Microsoft Entra ID, Okta, Auth0, Keycloak…). Se configura con
`OIDC_DISCOVERY_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`, o con el bloque
`auth.oidc` del archivo de config. El id_token se verifica contra el JWKS del
proveedor.

Dos filtros, en orden: `allowedEmailDomains` (opcional, restringe por dominio) y la
**membresía en al menos un workspace** (obligatoria, la da el admin). Los emails de
`ADMIN_EMAILS` son los que entran al panel.

Setup paso a paso con Google: [docs/runbook-google-sso.md](docs/runbook-google-sso.md).

## Conectar un cliente MCP

Una vez deployado el server (o corriendo local), agregá al `mcp.json` del cliente:

```json
{
  "mcpServers": {
    "sdlc": {
      "type": "http",
      "url": "https://sdlc-mcp.<tu-dominio>/mcp"
    }
  }
}
```

Sin header de auth, al primer request el server responde 401 con el resource metadata
OAuth y el cliente abre el login del proveedor configurado. También hay modo local
(stdio) para desarrollo. Guía por cliente (Claude Code, Claude Desktop, Cursor):
[docs/CONNECTING_CLIENTS.md](docs/CONNECTING_CLIENTS.md).

## Adapters

Cada workspace elige con qué sistemas habla. El default es un fake in-memory, así que
todo funciona sin integrar nada. Incluidos:

| Contrato | Adapters incluidos |
|---|---|
| `TaskSystemAdapter` (backlog) | Azure DevOps Boards, in-memory |
| `DocStoreAdapter` (PRD/RFC/ADR) | Google Drive, in-memory |
| `PullRequestAdapter` | Azure DevOps Repos, GitHub, no-op |

Se resuelven en tiempo de llamada según la configuración del workspace
(`tenant_integrations`, editable desde el panel admin). Las credenciales nunca se
guardan: solo **referencias** (`aws-sm://<name>#<key>`) que resuelve AWS Secrets
Manager, o `env` en dev.

Agregar el tuyo (Jira, Linear, lo que sea) es implementar el contrato de
`@sdlc/adapters-contracts` y registrar el provider — ejemplo completo en
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) § *Modelo de adapters*.

## Catálogo de prompts

`packages/catalog/` trae 6 roles con sus skills y templates, escritos en términos
genéricos. Para usar los prompts de tu organización, apuntá `CATALOG_ROOT` a tu propio
catálogo en vez de editar el bundleado. Convenciones de redacción:
[docs/PROMPT_AUTHORING.md](docs/PROMPT_AUTHORING.md).

## Panel admin

Panel web en `/admin` para dar de alta workspaces y groups, gestionar la membresía
`(workspace, email) → roles` —que es lo que habilita el login MCP de cada dev—,
configurar la integración de cada workspace (solo referencias a secretos) y ver el
estado de los flows con su timeline de eventos.

Login con el mismo OIDC, restringido a `ADMIN_EMAILS`. El SPA se buildea con
`pnpm --filter @sdlc/admin build` y el server lo sirve desde `apps/admin/dist`.

## Estructura del repo

```
apps/server/                 MCP server (Fastify + MCP SDK) + API del panel
apps/admin/                  SPA del panel admin (React + Vite)
packages/core/               Tipos compartidos + schemas zod
packages/adapters-contracts/ Interfaces de adapters + TenantCtx
packages/catalog/            Catálogo versionado de prompts/skills/templates
infra/                       Dockerfile, compose, terraform
docs/                        Arquitectura, runbooks, planes y specs
examples/                    Flujos end-to-end ejecutables
```

## Tests

```bash
pnpm turbo run test                    # suite completa; los de Postgres se skipean
TEST_DATABASE_URL="postgres://sdlc:sdlc@localhost:5432/sdlc_test" \
  pnpm --filter @sdlc/server test      # incluye integración contra Postgres real
```

Los tests contra sistemas externos (Azure DevOps, Drive, GitHub) se skipean salvo que
estén seteadas sus env vars.

## Contribuir

Ver [CONTRIBUTING.md](CONTRIBUTING.md) — setup, ciclo TDD, migraciones y convenciones
de PR.

## Licencia

[MIT](LICENSE)
