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
- **28 tools MCP** registradas, ~850 tests (unit + integración).
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

## Flujo de trabajo

Esta sección junta en un solo lugar las tres cosas que hay que tener claras para usar
`sdlc-mcp`: cómo se configura, con qué sistemas habla y cómo es un ciclo de desarrollo
de punta a punta. El detalle de cada paso está en las secciones de más abajo y en
`docs/`.

### 1. Configuración del proyecto, paso a paso

Cada paso es opcional respecto del siguiente: con el paso 1 solo ya podés correr un
flow completo contra fakes in-memory. Los demás suman persistencia, identidad real e
integraciones.

| # | Paso | Cómo | Sin este paso… |
|---|---|---|---|
| 1 | **Instalar y levantar local** | `pnpm install` · `cp apps/server/.env.example apps/server/.env` · `pnpm local` | — |
| 2 | **Base de datos** | `docker compose -f infra/compose.yml up -d postgres` · setear `DATABASE_URL` · `pnpm --filter @sdlc/server db:migrate` | El estado vive en memoria y se pierde al reiniciar |
| 3 | **Estructura de la organización** | `cp sdlc.config.example.yaml sdlc.config.yaml`: labels, groups, workspaces, dominios permitidos. Se reconcilia al boot (crea, nunca borra) | Hay que dar de alta los workspaces a mano desde el panel |
| 4 | **Identidad (OIDC)** | Registrar una app en tu proveedor con redirect `<PUBLIC_URL>/oauth/callback` y setear `OIDC_DISCOVERY_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` (o `auth.oidc` en el YAML), más `OAUTH_SIGNING_SECRET` y `PUBLIC_URL` | `/oauth/*` responde 503: solo funciona el modo stdio local |
| 5 | **Admins del panel** | `ADMIN_EMAILS` + `ADMIN_SESSION_SECRET`; buildear el SPA con `pnpm --filter @sdlc/admin build` | Nadie entra a `/admin` |
| 6 | **Membresías y roles** | En el panel: `(email, workspace) → roles`. Es lo que habilita el login MCP de cada persona | Nadie puede loguearse por MCP |
| 7 | **Secretos** | `SECRETS_BACKEND=env` (variables `SECRET_<NAME>`, para dev) o `aws` (AWS Secrets Manager con `AWS_REGION`) | Solo andan los adapters in-memory / no-op |
| 8 | **Integraciones por workspace** | Desde el panel (`PUT /admin/api/workspaces/:id/integration`) o en lote con `pnpm --filter @sdlc/server seed:integrations infra/integrations.example.json` | Backlog in-memory, docs y PRs no-op |
| 9 | **Catálogo de prompts propio** | Copiar `packages/catalog/`, adaptarlo y apuntar `CATALOG_ROOT` a la copia | Se usan los prompts genéricos bundleados |
| 10 | **Conectar los clientes MCP** | Cada dev agrega el server a su `mcp.json` ([guía](docs/CONNECTING_CLIENTS.md)) | — |
| 11 | **Deploy** | Imagen única (`infra/docker/Dockerfile`), EC2 + compose + Terraform ([runbook](docs/runbook-deploy-prod.md)) | Queda corriendo solo en tu máquina |

Opcionales de operación: `OTEL_TRACES_ENABLED` + `OTEL_EXPORTER_OTLP_ENDPOINT` para
traces, `RATE_LIMIT_*` para ajustar límites y `QA_EVIDENCE_HOST_ALLOWLIST` para
restringir de dónde puede venir la evidencia de QA. Todas están documentadas en
[`apps/server/.env.example`](apps/server/.env.example).

### 2. Sistemas que se pueden conectar

| Pieza | Opciones | Dónde se configura |
|---|---|---|
| **Base de datos** | Postgres 16 (Drizzle, migraciones en `apps/server/migrations/`) · in-memory | `DATABASE_URL` |
| **Identidad** | Cualquier OIDC con discovery: Google, Microsoft Entra ID, Okta, Auth0, Keycloak… | `OIDC_*` o `auth.oidc` en `sdlc.config.yaml` |
| **Backlog** | Azure DevOps Boards · Linear · GitHub Issues · in-memory | `tenant_integrations.task_system` (panel) |
| **Docs (PRD / RFC / ADR / nota de cambio)** | Google Drive (Shared Drive, requiere Google Workspace) · repo de GitHub (commitea los docs en `docs/sdlc/…`) · no-op | `tenant_integrations.doc_store` (panel) |
| **Pull requests** | GitHub · Azure DevOps Repos · no-op | `tenant_integrations.pr_provider` (panel) |
| **Secretos** | AWS Secrets Manager (`aws-sm://<name>#<key>`) · variables de entorno | `SECRETS_BACKEND` |
| **Observabilidad** | Cualquier collector OTLP/HTTP (Jaeger, Tempo, Honeycomb, Datadog…) | `OTEL_*` |
| **Clientes MCP** | Claude Code, Claude Desktop, Cursor, VS Code y cualquier cliente MCP por HTTP (OAuth) o stdio (local) | `mcp.json` del cliente |
| **Infra** | AWS: EC2 + ECR + Secrets Manager + Caddy (TLS), vía Terraform | `infra/terraform/`, `infra/compose.prod.yml` |

Cada workspace elige sus propios adapters, así que un mismo deploy puede tener un
equipo en Azure DevOps y otro en Linear + GitHub. ¿Jira, Confluence, GitLab? Se
agregan implementando el contrato de `@sdlc/adapters-contracts`
([cómo](docs/ARCHITECTURE.md)).

### 3. Un ciclo de desarrollo, paso a paso

Cada fase la hace una persona con su agente (Claude Code, Cursor…). En todas, el
agente primero pide su prompt con `get_role_prompt(role, phase)`: el MCP le devuelve
el system prompt, las skills y el template de esa fase, y después valida y registra lo
que el agente produce. `get_flow_state` dice en qué punto está el flow en cualquier
momento.

```
Fase:    PRD ────► RFC ─────► Shaping ───────► Implementación ─► QA ─► Review ──────────► fin
Rol:     PM        TL         PMO              Developer          QA    Reviewer
Status:  draft ──► prd_ready ► rfc_ready ────► backlog_ready ─────────► impl_in_review ─► merged
```

**Track completo** (`feature`, `refactor`):

| # | Quién | Qué hace | Tools | Resultado |
|---|---|---|---|---|
| 1 | PM / TL / PMO | Abre la iniciativa con su `initiative_type` | `start_flow` | Flow en `draft`, fase `prd` |
| 2 | Product Manager | Discovery (el agente lo interroga) y redacción del PRD | `get_role_prompt(product-manager, prd-discovery / prd-draft)` · `validate_prd` · `submit_prd` | PRD publicado en el doc store, flow en `prd_ready` |
| 3 | Tech Lead | RFC: arquitectura, componentes y el repo de cada uno en el frontmatter. ADRs cuando hagan falta | `generate_rfc_skeleton` · `validate_rfc` · `submit_rfc` · `submit_adr` | RFC publicado, flow en `rfc_ready` |
| 4 | PMO / TL | Parte el trabajo en epic → stories (con criterios de aceptación) → subtasks y lo crea en el backlog | `propose_breakdown` · `create_epic` · `create_stories` · `link_subtasks` · `sync_backlog` | Items en el backlog externo, flow en `backlog_ready` |
| 5 | Developer | Toma una story, recibe el contexto (PRD, RFC, componente, convenciones) e implementa en su branch | `claim_story` · `get_implementation_context` · `report_progress` | Story `in_progress` → `in_review`, con PR abierto |
| 6 | QA (otra persona) | Genera el plan de QA desde los criterios y reporta resultados con evidencia, comando de test y exit code | `generate_qa_plan` · `submit_qa_results` · `block_story` | Story `qa_passed` (o `blocked`) |
| 7 | QA / TL | Pide el review del PR | `request_code_review` | Flow en `impl_in_review` |
| 8 | Reviewer | Review en dos ejes (estándares y spec) | `submit_review_outcome` | Story `merged`. Cuando todas lo están, el flow pasa a `merged` |

**Track liviano** (`fix`, `improvement`): los pasos 1 a 4 se reemplazan por una sola
llamada. El developer (o PM/TL/PMO) abre el flow y llama `submit_change_note` con una
nota de cuatro secciones (qué pasa, cómo lo sé, qué cambio, cómo se verifica), el repo
afectado y cómo se reproduce el problema. Eso publica la nota, crea epic y stories y
deja el flow en `backlog_ready`. Desde ahí sigue igual que el track completo: QA y
review no se relajan.

Reglas que el server hace cumplir en cualquier track:

- **Cada tool exige su rol** en el workspace del flow (por ejemplo, `submit_rfc` solo
  tech-lead y `claim_story` solo developer).
- **Nadie firma su propio trabajo**: quien implementó una story no puede firmar su QA
  ni su review.
- **QA necesita evidencia ejecutable**: URL de evidencia por caso, `test_exit_code` en
  0, hash del output y cobertura de los casos del plan.
- **El PR tiene que ser del repo declarado** para la story.
- **Se sube de track, no se baja**: un fix que creció puede pasar a PRD; una feature no
  puede degradarse a nota de cambio.
- **Salidas**: `discard_story` (TL) para una story que no se va a hacer y `abort_flow`
  (TL / PMO) para cancelar la iniciativa. `verify_artifact` comprueba que un PRD, RFC
  o nota publicados no se hayan editado después del submit.

Todo queda en el audit trail del flow (`flow_events`), visible en el panel admin.

Para verlo andar sin configurar nada: `./examples/01-prd-rfc/run.sh`. Para el ciclo
completo con integraciones reales, prompts, transcripts y fallas documentadas, ver
[`examples/02-fintech`](examples/02-fintech/README.md).

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
| `TaskSystemAdapter` (backlog) | Azure DevOps Boards, Linear, GitHub Issues, in-memory |
| `DocStoreAdapter` (PRD/RFC/ADR) | Google Drive, repo de GitHub, no-op |
| `PullRequestAdapter` | Azure DevOps Repos, GitHub, no-op |

Se resuelven en tiempo de llamada según la configuración del workspace
(`tenant_integrations`, editable desde el panel admin). Las credenciales nunca se
guardan: solo **referencias** (`aws-sm://<name>#<key>`) que resuelve AWS Secrets
Manager, o `env` en dev.

Agregar el tuyo (Jira, Confluence, GitLab, lo que sea) es implementar el contrato de
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
