# Instalar sdlc-mcp

Qué es y para qué sirve: [README.md](README.md). Esta guía es sólo cómo ponerlo en marcha.

## Qué hace falta

| | Para qué | ¿Obligatorio? |
|---|---|---|
| Node 20+ y pnpm 9+ | Buildear y correr el server | Sí |
| Docker | Postgres y la instancia propia (caminos B y C) | Para uso real |
| Un proveedor OIDC (Google, Entra ID, Okta, Auth0, Keycloak…) | Login al panel y de los clientes MCP | Para uso real |
| Cuenta en tu backlog, tu repo de PRs y tu doc store | Que el server escriba historias, comentarios en PRs y documentos | Para cerrar el ciclo |
| Claude Code (u otro cliente MCP) | El agente que trabaja en cada fase | Sí, para usarlo |

## Elegí tu camino

| Camino | Para qué | Tiempo |
|---|---|---|
| [A. Probar](#a-probar-sin-configurar-nada) | Ver un flow andar, sin base ni login | 5 min |
| [B. Instancia propia con Docker](#b-instancia-propia-con-docker) | Usarlo de verdad en tu máquina o un servidor | 30 min |
| [C. Producción en AWS](#c-producción-en-aws) | Un deploy compartido con TLS y secretos administrados | 1-2 h |
| [D. Habilitar un repo](#d-habilitar-un-repo-con-el-cli) | Hacer obligatorio el ciclo en un repo, con el gate | 10 min |

## A. Probar sin configurar nada

Sin `DATABASE_URL` el server guarda todo en memoria y se pierde al reiniciar.

```bash
pnpm install
cp apps/server/.env.example apps/server/.env
pnpm local                       # build + server en http://localhost:3000
./examples/01-prd-rfc/run.sh     # un flow PRD → RFC de punta a punta, con su historial
```

El script levanta su propio server en el puerto 3030 si no hay nada escuchando ahí.

Este modo no cierra el ciclo: sin base no hay integraciones, así que QA y review se
rechazan. Hasta dónde llega: [docs/CONNECTING_CLIENTS.md § A.0](docs/CONNECTING_CLIENTS.md#a0-hasta-dónde-llega-el-modo-local).

## B. Instancia propia con Docker

Server + Postgres con `infra/compose.yml`, una imagen buildeada del repo y la config en
archivos que no se versionan.

**1. Configuración**

```bash
cp infra/env.local.example infra/.env.local      # puertos, PUBLIC_URL, OIDC, secretos
cp sdlc.config.example.yaml sdlc.config.yaml     # tu organización (ver más abajo)
```

En `infra/.env.local`:

- `COMPOSE_PROJECT_NAME` separa contenedores, red y volumen de otras instancias.
- `SDLC_PORT` es el puerto del server en el host; `SDLC_PG_BIND` el de Postgres (dejalo en
  `127.0.0.1`).
- `PUBLIC_URL` tiene que coincidir con el redirect URI registrado en tu proveedor:
  `<PUBLIC_URL>/oauth/callback`.
- `OAUTH_SIGNING_SECRET` y `ADMIN_SESSION_SECRET`: `openssl rand -hex 32`. No los rotes sin
  avisar: invalidan todos los tokens y sesiones.

**2. Levantar**

```bash
dc() { docker compose --env-file infra/.env.local -f infra/compose.yml "$@"; }
dc build
dc --profile migrate run --rm migrate
dc up -d
curl -s localhost:3000/health          # → "store":"postgres"
```

Opcionales de operación, todos con default razonable: traces (`OTEL_TRACES_ENABLED` +
`OTEL_EXPORTER_OTLP_ENDPOINT`), límites (`RATE_LIMIT_*`) y de qué hosts se acepta evidencia
de QA (`QA_EVIDENCE_HOST_ALLOWLIST`). Están documentados en
[apps/server/.env.example](apps/server/.env.example).

**3. Actualizar y volver atrás**

Buildeá siempre desde `main`. Antes de reemplazar la imagen, guardá la actual con otro
tag para poder volver:

```bash
docker tag sdlc-mcp:local sdlc-mcp:pre-<algo>
git pull && dc build
dc --profile migrate run --rm migrate
dc up -d --no-build server
```

Para volver atrás: `docker tag sdlc-mcp:pre-<algo> sdlc-mcp:local && dc up -d server`.
Si en el medio corrió una migración, revisala antes en `apps/server/migrations/`: la mayoría
sólo agrega, pero algunas renombran o borran, y ahí la imagen anterior no anda contra la
base nueva. Para esos casos, un `pg_dump` antes de migrar.

## Configurar la organización: `sdlc.config.yaml`

```yaml
tenantId: default

labels:                                   # cómo llamás a los conceptos
  workspace: { singular: squad, plural: squads }
  group: { singular: tribu, plural: tribus }

auth:
  allowedEmailDomains: [example.com]      # opcional
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

- Un **workspace** es la unidad de trabajo y de permisos (un proyecto, un equipo). Un
  **group** sólo agrupa workspaces y no da permisos.
- Al arrancar con Postgres, el server **crea** los groups y workspaces que falten. Nunca
  borra: lo que está en la base y no en el archivo se loguea como *drift*.
- **El archivo gana sobre las variables de entorno**, campo por campo; env completa lo que
  el archivo no dice. El server loguea de dónde salió cada valor (`effective config resolved`).
- Las integraciones de cada workspace **no** van acá: van en el panel (ver abajo).

Referencia completa y comentada: [sdlc.config.example.yaml](sdlc.config.example.yaml).

## Identidad

El login es OIDC genérico: cualquier proveedor con discovery document. Se configura con
`auth.oidc` en el YAML o con `OIDC_DISCOVERY_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`
(para Google alcanzan `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`). Paso a paso con Google:
[docs/runbook-google-sso.md](docs/runbook-google-sso.md). Una cuenta @gmail sin Google
Workspace también sirve.

Quién entra:

1. **Al panel** (`/admin`): los emails de `ADMIN_EMAILS`.
2. **Por MCP**: quien tenga **membresía en al menos un workspace**. La da un admin en el
   panel, pestaña *Miembros*, con sus roles (`product-manager`, `tech-lead`, `pmo`,
   `developer`, `qa`, `reviewer`). Los roles valen por workspace.

En el panel, cada workspace tiene además **"QA y review propios"**: prendido por defecto,
deja que quien implementó firme su propio QA y review (queda marcado en el issue y en el
PR). Apagalo en los workspaces donde tiene que firmar otra persona.

## Integraciones por workspace

En el panel, pestaña *Integración* de cada workspace (o en lote con
`pnpm --filter @sdlc/server seed:integrations <archivo.json>`, ver
[infra/integrations.example.json](infra/integrations.example.json)). Sin integración, el
workspace usa un backlog en memoria y no publica documentos ni toca PRs.

| Pieza | `kind` | `settings` |
|---|---|---|
| Backlog | `github` | `owner`, `repo` |
| | `linear` | `teamId` (y opcional `projectId`) |
| | `azure-devops` | `org`, `project` |
| Documentos | `google-drive` | `rootFolderId` (Mi unidad, cuenta personal) **o** `sharedDriveId` (unidad compartida, service account) |
| | `github-repo` | `owner`, `repo` (y opcional `branch`): commitea los documentos en `docs/sdlc/…` |
| Pull requests | `github` · `azure-devops-repos` | — |

**Credenciales.** La integración guarda una referencia (`secret_ref`), nunca el valor:

- `SECRETS_BACKEND=env` (Docker local): `aws-sm://github-acme` se lee de la variable
  `SECRET_GITHUB_ACME` del contenedor (mayúsculas y `_`). Va en `infra/.env.local`.
- `SECRETS_BACKEND=aws` (producción): se lee de AWS Secrets Manager con el rol de la
  instancia; `#clave` toma un campo del JSON.

**GitHub:** un token fine-grained sobre los repos del workspace con **Issues** y **Pull
requests** en *Read and write*. Las firmas propias etiquetan y comentan el PR, así que
Pull requests de sólo lectura no alcanza.

**Google Drive en Mi unidad:** `pnpm --filter @sdlc/server drive:auth` abre el login y
devuelve la credencial `authorized_user`; va en una línea, entre comillas simples, en la
variable del secreto. El server sólo ve lo que crea él (scope `drive.file`), así que
`rootFolderId` es `root` o una carpeta creada por el server.

**Aislamiento.** Cada workspace resuelve sus propios adapters con sus propios secretos.
Si trabajás para varios clientes, usá un workspace por proyecto y nunca compartas token
ni carpeta de Drive entre clientes: el doc store no tiene destino por defecto justamente
para que un workspace mal configurado falle en vez de publicar en el de otro.

## C. Producción en AWS

EC2 + docker compose + Caddy (TLS) + Secrets Manager, con Terraform en `infra/terraform/`:
[docs/runbook-deploy-prod.md](docs/runbook-deploy-prod.md).

## D. Habilitar un repo con el CLI

En la raíz del repo, con el server ya andando:

```bash
npx @nigav/sdlc login --server https://sdlc.example.com
npx @nigav/sdlc init        # pregunta workspace y exclusiones, muestra el diff y confirma
npx @nigav/sdlc doctor      # diagnostica y prueba el gate
```

`init` escribe y protege `.claude/sdlc/config.json`, `.claude/hooks/sdlc-gate.mjs`, los
hooks en `.claude/settings.json` y el server en `.mcp.json`, y suma un bloque en `CLAUDE.md`
y entradas en `.gitignore`. Commiteá esos archivos: el gate corre para todo el que abra el
repo con Claude Code.

Desde ahí, el agente no edita código ni commitea sin una historia reclamada con
`claim_story` (salvo `CLAUDE.md`, `docs/**/*.md` y las skills, commands y agents de
`.claude/`). Si el server está caído, `sdlc bypass --reason "…"` da un permiso temporal
que queda registrado. `sdlc uninstall` saca todo. Detalle: [packages/cli/README.md](packages/cli/README.md).

## Conectar los clientes MCP

```json
{
  "mcpServers": {
    "sdlc": { "type": "http", "url": "https://sdlc.example.com/mcp" }
  }
}
```

Sin token, el server responde 401 y el cliente abre el login. En un repo habilitado con
`init` esto ya quedó en `.mcp.json`. Guía por cliente: [docs/CONNECTING_CLIENTS.md](docs/CONNECTING_CLIENTS.md).

## Primer flow

Con el cliente conectado, pedile al agente algo así:

> Abrí un flow en el workspace `platform` para "Reembolsos automáticos", tipo `feature`, y
> arrancá el discovery del PRD.

El agente llama `start_flow`, después `get_role_prompt(product-manager, prd-discovery)` y
sigue con las preguntas de discovery. `get_flow_state` dice en qué punto está el flow en
cualquier momento, y el panel muestra su historial. Para un arreglo chico usá tipo `fix` o
`improvement`: va por la nota de cambio en vez de PRD y RFC.

## Si algo falla

| Síntoma | Causa y salida |
|---|---|
| `/oauth/authorize` responde 503 `OIDC identity provider not configured` | Falta la config OIDC. Revisá `auth.oidc` o las variables `OIDC_*` / `GOOGLE_*` y el log `effective config resolved`. |
| El login termina en "Cuenta sin alta" | El email no tiene membresía en ningún workspace. Un admin lo da de alta en el panel. |
| Google rechaza el login con `redirect_uri_mismatch` | `PUBLIC_URL` no coincide con el redirect URI registrado: tiene que ser exactamente `<PUBLIC_URL>/oauth/callback`. |
| `submit_prd` devuelve `published: false` | El doc store falló (credencial, carpeta). El flow avanza igual y el hash queda guardado; el motivo está en `publish_error`. |
| `submit_qa_results` o `submit_review_outcome` rechazan "no-op" | El workspace no tiene `pr_provider`: sin un PR real no hay nada que firmar. Configurá la integración. |
| El gate bloquea todo con el server caído | Es a propósito: falla cerrado. `sdlc bypass --reason "…"` mientras tanto. |
| Una integración falla con `Env var SECRET_… not set` | Falta la variable del secreto en el contenedor. Agregala a `infra/.env.local` y recreá el server (`up -d server`). |
