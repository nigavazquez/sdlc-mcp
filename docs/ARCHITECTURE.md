# Arquitectura

## Estado actual (al cierre de Fase 3 + adapters reales)

Lo siguiente ya está en el repo y validado con tests + smoke e2e:

- **MCP server** con **25 tools registradas** (ver tabla [Tools](#tools-estado-actual)): universales, PRD/RFC, shaping, implementación, QA y review.
- **Catálogo 0.5.0** con los 6 roles del SDLC (`product-manager`, `tech-lead`, `pmo`, `developer`, `qa`, `reviewer`), 6 skills y 4 templates.
- **`FlowStore` polimórfico** con `InMemoryFlowStore` (default cuando `DATABASE_URL` no está seteado) y `PostgresFlowStore` (drizzle-orm + postgres-js). Factory en `src/state/factory.ts`. Incluye CRUD de `stories` y los campos `doc_folder_path`/`adr_refs`.
- **Selección de adapters por tenant/proyecto** — `IntegrationConfigStore` (tabla `tenant_integrations`, in-memory + Postgres) + providers (`ConfigBackedTaskSystemProvider`, `ConfigBackedDocStoreProvider`, `ConfigBackedPullRequestProvider`) resuelven el adapter en tiempo de llamada según la config de cada flow. `SecretResolver` (AWS Secrets Manager / env) respalda `ctx.resolveSecret`. El fake in-memory / NoOp es el default.
- **Adapters reales:**
  - **Backlog** → `AzureDevOpsTaskSystemAdapter` (REST work items v7.1, template Agile, WIQL search; PAT vía vault), `LinearTaskSystemAdapter` (GraphQL, issues encadenados por `parentId`) y `GitHubIssuesTaskSystemAdapter` (REST + API de sub-issues, tipos por label). Qué cede cada uno: § [Qué se pierde en cada mapeo del backlog](#qué-se-pierde-en-cada-mapeo-del-backlog).
  - **PRD/RFC/ADR** → `GoogleDriveDocStoreAdapter` (unidad compartida, carpetas derivadas del modelo (group/workspace) + la del flow + `adr/`; cada artefacto como `.md` fiel **y** Google Doc nativo, idempotente; service account vía vault).
  - **PRs** → `AzureDevOpsPullRequestAdapter` y `GitHubPullRequestAdapter` (actúan sobre un PR existente vía `pr_url`; sin auto-merge).
- **Loop dev↔QA↔Review completo** — `claim_story` → `report_progress` → `generate_qa_plan` → `submit_qa_results` → `request_code_review` → `submit_review_outcome`, gobernado por la FSM de `src/stories/transitions.ts`.
- **Migrations versionadas** (hasta `0013`) en `apps/server/migrations/` y runner propio (`pnpm db:migrate`, `src/state/migrate.ts`): se compila con el server para que el deploy pueda aplicarlas desde la misma imagen que arranca.
- **~355 tests verdes** — unit + integración contra Postgres real; las integraciones live de ADO/Drive/GitHub se skippean salvo que se seteen sus env vars (`TEST_DATABASE_URL`, `ADO_*`, `GDRIVE_*`, `GH_*`), no rompen CI.
- **Demo end-to-end** (`examples/01-prd-rfc/`) que ejecuta el flow PRD→RFC contra el server real, indistintamente del backend de storage.

Lo que **falta** y se aborda en las siguientes fases:

- Adapter de Jira, si se requiere, sobre la misma capa de providers (Linear y GitHub Issues ya están).
- Completar/mergear PRs automáticamente en `submit_review_outcome` (hoy solo registra y avanza el flow) — detrás de un flag explícito.

## Filosofía

`sdlc-mcp` materializa una idea simple: el flujo SDLC tradicional funciona, pero rara vez se respeta. Cuando un equipo abre un IDE con un agente potente, suele saltar directamente a código sin un PRD claro ni un RFC revisado. El resultado es scope creep, retrabajo y bugs prevenibles.

Este proyecto fuerza el respeto del flujo entregando, **a cada rol y en cada fase**, el system prompt + skills + templates correctos. El MCP no ejecuta el agente; el cliente (Cursor, Claude Desktop, Copilot) lo hace. El MCP es la fuente de verdad sobre qué se espera en cada fase y orquesta los efectos en sistemas externos.

## Modelo del flujo

| # | Fase | Rol | Artefacto | Storage | Estado |
|---|---|---|---|---|---|
| 1 | PRD | Product Manager | `prd.md` | Confluence/Notion + repo `/docs/prd/<slug>.md` | `prd_ready` |
| 2 | RFC | Tech Lead | `rfc.md` + ADRs | Repo `/docs/rfc/<slug>.md` | `rfc_ready` |
| 3 | Shaping | PMO | Epic + Stories + Subtasks | Sistema externo (Jira/Linear/GitHub) | `backlog_ready` |
| 4 | Implementation | Developer | Código + PR | Repo (branch) | `impl_in_review` |
| 5 | QA | QA Engineer | Test plan + reportes | Repo `/qa/<slug>/` + comentarios | *(story)* `qa_passed` |
| 6 | Review | Reviewer | PR aprobado | GitHub/GitLab PR | `merged` |

`flow_id = <tenant>:<project>:<slug>`. El MCP guarda referencias y metadatos, no los cuerpos largos. Las tareas viven en el sistema externo (verdad).

> **Ojo con la fila 5.** Ese `qa_passed` es el status de la **story**, no del flow: es la única
> fila de la tabla que no nombra un `FlowStatus`. En el eje del flow, QA transcurre con el estado
> quieto en `backlog_ready`, y el próximo movimiento es `impl_in_review`, que lo escribe
> `request_code_review`.
>
> `FlowStatus` tuvo hasta la migración de este cambio un `qa_passed` que ninguna tool escribía —un
> valor legal que ningún camino alcanzaba, igual que `aborted` antes de que existiera
> `abort_flow`—. Se sacó. **La regla que queda: todo valor de `FlowStatus` tiene que tener una tool
> que lo escriba**, y `flow-status-alcanzable.test.ts` la sostiene contra el enum.

### Tracks: cuánta ceremonia exige cada iniciativa

El `initiative_type` que `start_flow` exige **deriva** el track (`trackForInitiative`, en
`packages/core/src/flow.ts`). No se persiste aparte: `flow.initiative_type` es la única fuente de
verdad, así que no hay drift posible entre el tipo y el track.

| | `full` (feature, refactor) | `lite` (fix, improvement) |
|---|---|---|
| Descubrimiento | PRD (`submit_prd`) + RFC (`submit_rfc`) | Nota de cambio (`submit_change_note`) |
| Shaping | `propose_breakdown` → `create_epic` → `create_stories` → `sync_backlog` | incluido en la misma llamada |
| Llamadas hasta poder implementar | 6 | 1 |
| Quién abre el flow | product-manager, tech-lead, pmo | + developer |
| QA y review | idénticos | idénticos |

La nota de cambio tiene cuatro secciones —qué pasa, cómo lo sé, qué cambio, cómo se verifica— y
declara **el repo en su frontmatter**. Eso último no es documentación: `create_stories` exige que
toda story nazca con un repo declarado porque `submit_review_outcome` compara el PR contra él, así
que es la única parte del frontmatter del RFC que el track liviano no puede soltar.

**Se sube de track, no se baja.** Un flow liviano que resultó más grande llama `submit_prd` y sigue
el camino completo, sin código extra: esas tools sólo miran el status. Al revés no —
`submit_change_note` rechaza un flow `full` — porque degradar una feature a nota de cambio sería el
agujero, no la escalada. La tabla de `tools-track.test.ts` cruza esa decisión contra el registry,
así que una tool nueva no puede olvidarse de declarar de qué lado está.

**Lo que el track liviano no toca es la entrega.** El plan de QA, el sobre con `test_exit_code` /
`test_output_hash` / cobertura `N/M`, y `assertNotSelfSignoff` corren igual en los dos: un fix chico
es justamente donde más seguido se rompe algo sin que nadie mire.

## Componentes

```
apps/server/                  Fastify + MCP SDK + auth + tenancy + tools
└── src/
    ├── index.ts              Bootstrap HTTP
    ├── config.ts             Env config (OIDC, DB, secrets)
    ├── config/               sdlc.config.yaml: schema, labels, reconcile, precedencia
    ├── auth/                 Bearer JWT del AS propio
    ├── http/                 Hooks del borde HTTP (rate limit)
    ├── telemetry/            Traces OTEL de las tool calls (apagado por default)
    ├── oauth/                Authorization Server: broker OIDC, DCR, PKCE, tokens
    ├── tenancy/              TenantCtx (Fase 1)
    ├── adapters/             Implementaciones concretas + providers
    │   ├── task-system-provider.ts   ConfigBackedTaskSystemProvider
    │   ├── doc-store-provider.ts     ConfigBackedDocStoreProvider
    │   ├── pull-request-provider.ts  ConfigBackedPullRequestProvider
    │   ├── azure-devops-task-system.ts
    │   ├── linear-task-system.ts
    │   ├── github-issues-task-system.ts
    │   ├── google-drive-docstore.ts
    │   ├── github-repo-docstore.ts
    │   ├── azure-devops-pull-request.ts
    │   └── github-pr-adapter.ts
    ├── integrations/         IntegrationConfigStore (in-memory + Postgres)
    │   ├── types.ts          IntegrationConfigStore / IntegrationConfigAdmin
    │   ├── factory.ts        createIntegrationConfigStore (mirrors FlowStore)
    │   ├── in-memory.ts      InMemoryIntegrationConfigStore
    │   └── postgres.ts       PostgresIntegrationConfigStore
    ├── catalog/              Wrapper sobre @sdlc/catalog
    ├── state/                Drizzle schema (Fase 1)
    ├── mcp/
    │   ├── server.ts         McpServer + transport
    │   └── tools/            Una tool por archivo

packages/core/                Tipos + zod schemas (RoleId, PhaseId, Flow, …)
packages/adapters-contracts/  Interfaces TaskSystemAdapter, DocStoreAdapter, PullRequestAdapter, TenantCtx
packages/catalog/             Contenido curado: roles/, skills/, templates/, catalog.yaml
```

## Modelo de adapters

### Contratos (`packages/adapters-contracts`)

Tres interfaces definen el contrato que todo adapter debe satisfacer:

| Interface | Archivo | Propósito |
|---|---|---|
| `TaskSystemAdapter` | `tasksys.ts` | Crear epics/stories/subtasks, transicionar, buscar en el backlog |
| `DocStoreAdapter` | `docs.ts` | Publicar (`publish`) y leer (`fetch`) artefactos PRD/RFC/ADR. La ruta de carpetas la arma quien llama, vía `folder_path: string[]`: el adapter une los segmentos que recibe y no asume niveles ni vocabulario de organización. El server la deriva con `resolveDocFolderPath` (group + workspace del flow) y la fija en `flow.doc_folder_path` en el primer publish exitoso, para no mover documentos ya publicados si después se renombra el workspace |
| `PullRequestAdapter` | `pullrequest.ts` | Solicitar review, registrar outcome, parsear PR URLs |

`TenantCtx` (definido en `tenant-context.ts`) se pasa a cada método de adapter para que el adapter pueda resolver secretos on-demand vía `ctx.resolveSecret(ref)`.

### Selección en tiempo de llamada

Cada tool que necesita un adapter no toca el adapter directamente; llama al **provider** correspondiente (lo enforcea `lint:boundaries`, regla `tools-no-tocan-adapters`):

```
tool call
  └─ Provider.resolve(ctx, flow)
       └─ IntegrationConfigStore.getXxxConfig(tenantId, flow.project)
            └─ fila (tenant_id, project) de tenant_integrations
                 └─ { kind, secret_ref, settings }
                      └─ instancia concreta del adapter
```

Los providers son:
- `ConfigBackedTaskSystemProvider` — resuelve `task_system`; default `in-memory` si no hay config.
- `ConfigBackedDocStoreProvider` — resuelve `doc_store`; default `NoOpDocStoreAdapter` si no hay config.
- `ConfigBackedPullRequestProvider` — resuelve `pr_provider`; default `NoOpPullRequestAdapter` si no hay config.

`IntegrationConfigStore` implementa resolución en dos niveles: busca la fila exacta `(tenant_id, workspace_id)` y cae a `(tenant_id, "")` como default de tenant.

### Adapters incluidos

| Canal | Kind (config) | Clase | `settings` |
|---|---|---|---|
| Backlog | `azure-devops` | `AzureDevOpsTaskSystemAdapter` | `org`, `project` (req.); `epicType`, `storyType`, `subtaskType`, `stateMap`, `areaPath`, `iterationPath` |
| Backlog | `linear` | `LinearTaskSystemAdapter` | `teamId` (req.); `projectId`, `apiUrl`, `stateMap` |
| Backlog | `github` | `GitHubIssuesTaskSystemAdapter` | `owner`, `repo` (req.); `apiBaseUrl`, `typeLabelPrefix`, `statusLabelPrefix`, `estimateLabelPrefix`, `stateMap` |
| Backlog | `in-memory` | `InMemoryTaskSystemAdapter` | — |
| Docs | `google-drive` | `GoogleDriveDocStoreAdapter` | `sharedDriveId` |
| Docs | `github-repo` | `GitHubRepoDocStoreAdapter` | `owner`, `repo` (req.); `branch`, `basePath` (default `docs/sdlc`), `apiBaseUrl` |
| Docs | `repo` / sin config | `NoOpDocStoreAdapter` | — |
| PRs | `azure-devops-repos` | `AzureDevOpsPullRequestAdapter` | `org`, `project` |
| PRs | `github` | `GitHubPullRequestAdapter` | — |
| PRs | sin config | `NoOpPullRequestAdapter` | — |

Todos los de backlog salvo `in-memory` exigen `secret_ref`; el secreto se resuelve en
cada llamada con `ctx.resolveSecret(ref)` y nunca se guarda en la fila.

#### Qué se pierde en cada mapeo del backlog

El contrato `TaskSystemAdapter` tiene tres niveles (epic → story → subtask), criterios
de aceptación, estimación y un `status` de texto libre. Ninguno de los tres sistemas
externos tiene exactamente eso, así que cada adapter elige dónde ceder — y lo que no
tiene equivalente honesto falla explícito en vez de simularse:

| | `azure-devops` | `linear` | `github` |
|---|---|---|---|
| Jerarquía | nativa (Epic / User Story / Task + links de hierarchy) | Issues encadenados por `parentId` | Issues + API de sub-issues |
| Tipo del item | campo `System.WorkItemType` | **inferido de la profundidad del padre**: sin padre → epic, con padre y sin abuelo → story, más hondo → subtask | **label marcadora** (`sdlc:epic` / `sdlc:story` / `sdlc:subtask`); sin label → `task` |
| Criterios de aceptación | campo propio (`Microsoft.VSTS.Common.AcceptanceCriteria`) | checklist markdown al final de la descripción | task list markdown en el body |
| Estimación | `StoryPoints` | campo `estimate` del issue | **no existe**: `createStory` con `estimate` tira `GitHubIssuesUnsupportedError` salvo que se configure `estimateLabelPrefix` |
| Estados | `System.State`, texto libre | workflow states del team: si el nombre no existe, `transition` falla listando los que sí | sólo `open`/`closed`: `Active` y `Resolved` colapsan, y un status fuera de `stateMap` falla explícito. `statusLabelPrefix` conserva el status fino como label |
| `external_id` | id numérico del work item | **UUID del issue** (no el `ENG-42`, que vive en la `url`) | número visible del issue |
| `project_key` del input | ignorado (manda `settings.project`) | ignorado (manda `settings.teamId`) | ignorado (mandan `settings.owner`/`repo`) |

El detalle de cada decisión, y por qué, está en el encabezado de cada archivo de
adapter.

### Cómo selecciona un operator el adapter de un workspace

**Mecanismo en producción (live):** editar la fila `tenant_integrations` para `(tenant_id, workspace_id)` a través del panel admin (`PUT /admin/api/workspaces/:id/integration`) o directamente en Postgres.

Ejemplo de config JSON almacenada en la fila:

```json
{
  "task_system": {
    "kind": "azure-devops",
    "secret_ref": "aws-sm://ado/workspace-1-pat",
    "settings": {
      "org": "your-org",
      "project": "Workspace 1"
    }
  },
  "doc_store": {
    "kind": "google-drive",
    "secret_ref": "aws-sm://gdrive/service-account-json",
    "settings": { "sharedDriveId": "0APm8ey..." }
  },
  "pr_provider": {
    "kind": "github",
    "secret_ref": "aws-sm://github/token"
  }
}
```

**Campo declarativo en `sdlc.config.yaml` (intención, no wiring runtime):**

`sdlc.config.yaml` acepta un campo `adapters` por workspace:

```yaml
workspaces:
  - id: workspace-1
    name: Workspace 1
    adapters:
      backlog: azure-devops
      docs: google-drive
      pr: github
```

Este campo es **parseado y validado** por `FileConfigSchema`, pero al momento **no está cableado al runtime**: `reconcileStructure` (que corre al boot) solo crea grupos y workspaces en el store, sin propagar el campo `adapters` a `tenant_integrations`. La fuente de verdad en runtime es exclusivamente la tabla `tenant_integrations`. El campo `workspaces[].adapters` existe para documentar intención y será el mecanismo de seed/sincronización en una iteración futura.

### Agregar un adapter propio

> **Antes de empezar — el `kind` es una unión cerrada.** `TaskSystemKind` en `packages/adapters-contracts/src/tasksys.ts` es `'jira' | 'linear' | 'github' | 'azure-devops'`. Si el `kind` de tu adapter **no** está ya en esa unión, `readonly kind = 'my-system' as const` no typechequea: agregá primero tu string a la unión `TaskSystemKind`. Lo mismo aplica a `DocStoreKind` (`docs.ts`) y `PrProviderKind` (`pullrequest.ts`) para adapters de docs / PRs. En el ejemplo de abajo (`jira`) el string ya existe en la unión, así que no hace falta tocarla.

1. **Implementar el contrato** en un nuevo archivo (puede vivir en `apps/server/src/adapters/` o en un package externo):

```typescript
// apps/server/src/adapters/jira-task-system.ts
import type { TaskSystemAdapter, TenantCtx, EpicInput, ExternalRef, /* … */ } from '@sdlc/adapters-contracts';

export class JiraTaskSystemAdapter implements TaskSystemAdapter {
  readonly kind = 'jira' as const;

  constructor(private readonly opts: { baseUrl: string; token: string }) {}

  async createEpic(input: EpicInput, ctx: TenantCtx): Promise<ExternalRef> {
    // llamar a la Jira REST API usando this.opts.token
    const res = await fetch(`${this.opts.baseUrl}/rest/api/3/issue`, { /* … */ });
    const data = await res.json();
    return { external_id: data.id, url: data.self };
  }

  // … implementar el resto: createStory, createSubtask, linkChildToParent,
  //     getItem, transition, search
}
```

2. **Registrar en el provider** — agregar un `case` en el `switch` de `ConfigBackedTaskSystemProvider.resolve()`:

```typescript
// apps/server/src/adapters/task-system-provider.ts
import { JiraTaskSystemAdapter } from './jira-task-system.js';

// dentro de resolve():
case 'jira': {
  if (!cfg.secret_ref) throw new Error('jira adapter: secret_ref required');
  const token = await ctx.resolveSecret(cfg.secret_ref);
  const s = cfg.settings as Record<string, unknown>;
  return new JiraTaskSystemAdapter({ baseUrl: s.baseUrl as string, token });
}
```

3. **Configurar el workspace** vía panel admin o directamente en Postgres:

```json
{
  "task_system": {
    "kind": "jira",
    "secret_ref": "aws-sm://jira/api-token",
    "settings": { "baseUrl": "https://my-org.atlassian.net" }
  }
}
```

Los mismos pasos aplican para `DocStoreAdapter` (`ConfigBackedDocStoreProvider`) y `PullRequestAdapter` (`ConfigBackedPullRequestProvider`).

## Tools (estado actual)

| Tool | Disponible | Descripción |
|---|---|---|
| `whoami` | Fase 0 ✅ | Verifica auth y entrega `tenant_id`/`user_id`/`roles` |
| `list_roles` | Fase 0 ✅ | Lista roles + fases del catálogo |
| `get_role_prompt` | Fase 0 ✅ | Devuelve system prompt + skills + templates para `(role, phase)` |
| `start_flow` | Fase 1 ✅ | Crea un flow para un proyecto |
| `submit_prd` / `validate_prd` | Fase 1 ✅ | Registrar y validar PRD |
| `submit_change_note` | Track liviano ✅ | La nota de cambio de un `fix`/`improvement`: valida, publica, crea epic y stories y deja el flow en `backlog_ready`. Reemplaza a las seis llamadas del track completo |
| `generate_rfc_skeleton` / `submit_rfc` / `validate_rfc` | Fase 1 ✅ | Ciclo RFC |
| `propose_breakdown` / `create_epic` / `create_stories` / `link_subtasks` / `sync_backlog` | Fase 2 ✅ | Shaping con adapter |
| `claim_story` / `get_implementation_context` / `report_progress` | Fase 3 ✅ | Implementation |
| `generate_qa_plan` / `submit_qa_results` / `block_story` | Fase 3 ✅ | QA |
| `discard_story` | Fase 3 ✅ | Descarta una story que no se va a hacer (rol tech-lead); es el único terminal además de `merged`, y sin él una story creada de más deja el flow sin poder cerrar |
| `request_code_review` / `submit_review_outcome` | Fase 3 ✅ | Review (ADO Repos / GitHub PRs). El outcome viaja con los **dos ejes** del review (estándares y spec) y el server verifica que sean coherentes: un `approved` sobre un eje que bloquea se rechaza |

## Catálogo

Un package versionado (`@sdlc/catalog`) con `catalog.yaml` como índice y semver por entrada. Editado vía PR con revisión obligatoria del COE. Cada role/phase es un markdown con frontmatter YAML (mismo patrón que spec-kit).

### El versionado es enforceable: el sello

`catalog_version` era un semver que se editaba a mano y que nada verificaba: se podía editar
una skill y dejar la versión quieta, y el server seguía reportando una versión que ya no
describía lo que servía. El sello cierra eso.

```yaml
catalog_version: 0.9.0
seal:
  sealed_version: 0.9.0
  digest: sha256:b4b8…
```

El **digest** cubre el índice (sin `catalog_version` ni el propio `seal`) más los bytes de cada
archivo que el índice referencia —roles, fases, skills, templates—, en orden estable. Deja la
versión afuera a propósito: así el digest responde una sola pregunta ("¿qué contenido hay
acá?") y el chequeo puede distinguir *se editó contenido* de *se bumpeó la versión*, que es lo
que hace accionable al mensaje de error.

`Catalog.verifySeal()` devuelve cuatro estados:

| Estado | Qué pasó | Dónde se ve |
|---|---|---|
| `ok` | el contenido es el que declara la versión | log de arranque (info) |
| `drift` | el contenido cambió y la versión no se movió | **falla el test**, log de arranque (error) |
| `stale-version` | se bumpeó pero no se reselló | **falla el test**, log de arranque (error) |
| `unsealed` | el catálogo no declara sello (catálogo propio vía `CATALOG_ROOT`) | log de arranque (warn) |

Dos mecanismos lo sostienen, uno de cada lado:

- **`apps/server/test/catalog-version.test.ts`** exige `ok` para el catálogo bundleado: tocar
  contenido sin resellar deja la suite en rojo.
- **`pnpm --filter @sdlc/catalog seal`** escribe el sello, y **se niega a sellar** si el
  contenido cambió y `catalog_version` sigue siendo la que ya estaba sellada. El camino feliz
  de quien edita el catálogo pasa por el script, así que el bump deja de depender de la memoria.

El server **sabe y dice** contra qué catálogo corre: lo loguea al arranque (versión + digest +
estado del sello) y `whoami` devuelve `catalog_version` y `catalog_digest` (el sellado; `null`
si el catálogo no está sellado — mejor `null` que un número que no se puede verificar). Dos
deploys con la misma versión y distinto digest son dos catálogos distintos, y sin exponerlo eso
sólo se descubre leyendo prompts.

Lo que el sello **no** puede hacer: no es una firma. Alguien que edite contenido y reselle a
mano bajo la misma versión pasa el chequeo — eso es un cambio visible en el diff del PR, y ahí
es donde se revisa. El sello cubre el olvido, no el engaño.

## Auth y modelo de workspaces

**Workspaces como eje del modelo.** Un tenant fijo (`TENANT_ID` o `tenantId` del archivo de
config, default `default`) y los **workspaces** como concepto de primera clase, declarados en
`sdlc.config.yaml` (sin nombres propios horneados). Una persona puede aportar a **varios
workspaces con roles distintos** (membresía N:M en `workspace_members`). Los **groups** agrupan
workspaces como puro metadato: no otorgan permisos. `flow.project = workspace_id` (ver nota
abajo); los proyectos son **iniciativas** tipadas (`initiative_type`: improvement | feature |
refactor | fix, requerido en `start_flow`).

Cómo se *muestran* esos dos conceptos es configurable (`labels` en el archivo): una organización
que habla de "squads" dentro de "tribus" cambia los labels, no el código. La API los expone en
`GET /admin/api/meta` y los consumen el SPA y los mensajes de autorización.

- **Identidad OIDC genérica:** el server actúa como OAuth 2.1 Authorization Server brokereando
  cualquier proveedor con discovery document (Google, Entra ID, Okta, Auth0, Keycloak): DCR +
  Authorization Code + PKCE S256 según el spec MCP (`/.well-known/oauth-*`,
  `/oauth/register|authorize|callback|token`). El `id_token` del proveedor se verifica contra su
  JWKS y se exige `email_verified`. Dos filtros en orden: `allowedEmailDomains` (opcional, vacío =
  sin restricción) y **membresía en ≥1 workspace** (obligatoria). Emite access tokens JWT HS256
  (1 h) con claims `sub`=email, `tenant_id`, `roles[]` (unión de todos los workspaces, compat) y
  `workspaces` (mapa `workspace_id → roles[]`), más refresh tokens opacos (30 días, hasheados,
  rotados). El endpoint MCP solo acepta esos JWT; el 401 devuelve `WWW-Authenticate` con el
  resource metadata, que dispara el flujo OAuth automático en el cliente. Las API keys y los
  headers `X-User-*` quedaron eliminados.
- **Autorización por workspace:** `assertFlowAccess(ctx, flow)` (tenant + workspace) se aplica
  apenas se resuelve el flow, antes de cualquier side-effect, en **las 25 tools que trabajan
  sobre un flow o una story, lectura incluida** (`start_flow` usa
  `assertWorkspaceAccess(ctx, project)` porque aún no hay flow). Exige membresía en el workspace
  dueño del flow (`flow.project`); si el ctx no trae el claim `workspaces`, falla cerrado
  (`mcp/tools/workspace-access.ts:17-24`), salvo que el proceso arranque con
  `SDLC_ALLOW_UNSCOPED_CTX=true`, apagado por default y sólo para tests/dev local.
- **El workspace es un límite de confidencialidad, no sólo de ownership de escritura.** Un
  miembro del workspace A no lee el PRD, el RFC ni el estado de un flow del workspace B, aunque
  compartan tenant: `get_flow_state`, `get_implementation_context`, `get_role_prompt`,
  `validate_prd`, `validate_rfc` y `generate_rfc_skeleton` pasan por el mismo gate que las
  tools de escritura. La alternativa —visibilidad cross-workspace para roles que revisan a
  otros— se descartó porque el modelo ya la cubre por membresía múltiple: un tech lead que
  tiene que ver dos workspaces se agrega a los dos, y eso queda registrado en el panel admin
  en vez de ser implícito en el código. Decidido en el issue
  [#10](https://github.com/nigavazquez/sdlc-mcp/issues/10).
- **Resolución de recursos.** Las 25 tools que trabajan sobre un flow o una story no lo
  resuelven a mano: llaman a `resolveFlowForCtx` / `resolveStoryForCtx`
  (`mcp/tools/flow-access.ts`), que resuelven y autorizan en un solo lugar. El orden es
  parte del contrato: como `flow_id` es `tenant:project:slug` y `project` *es* el
  `workspace_id`, la membresía se chequea **antes** de leer el store, así que a un
  no-miembro se le responde lo mismo exista o no el recurso. Un miembro sí ve "no
  existe" — podría verlo si existiera, así que no se le oculta nada y un typo sigue
  siendo debuggeable. El chequeo contra el record cargado se mantiene como backstop: el
  parseo del id es una heurística sobre un string del caller, la autoridad es el record.
  `tools-resource-access.test.ts` verifica contra el registry que toda tool declare cómo
  resuelve su recurso.
- **Panel admin:** login por el mismo broker OIDC (`mode=admin`) gateado por `ADMIN_EMAILS`;
  sesión cookie HMAC de 8 h. Administra workspaces, groups, membresías N:M, la integración de
  cada workspace y los flows.
- **Credenciales del task system:** una config de integración por workspace — la fila
  `(tenant_id, project=workspace_id)` de `tenant_integrations` — como **referencias**
  (`aws-sm://...`); el valor vive en AWS Secrets Manager y se resuelve on-demand vía
  `TenantCtx.resolveSecret`. Cada workspace mapea a su propio board.

> **Nota sobre `flow.project`:** la columna se llama `project` y su valor **es** el
> `workspace_id`. No se renombró porque `tenant_integrations` también keyea por `project` y los
> adapters lo usan como project key del sistema externo.

### Precedencia de configuración

Hay dos fuentes: el archivo `sdlc.config.yaml` y las env vars. **El archivo gana campo por
campo**; env rellena lo que el archivo omite. Un campo presente pero vacío en el archivo
(`allowedEmailDomains: []`) es una decisión explícita y también gana — por eso esos campos son
`optional` y no tienen `.default()` en el schema: hay que poder distinguir "ausente" de "vacío".

El bloque `auth.oidc` gana **entero** (discovery + clientId + secret + scopes): mezclar mitades
de dos fuentes es imposible de debuggear. Su `clientSecretRef` se resuelve con el `SecretResolver`
del deploy, así que acepta `aws-sm://<name>#<key>`.

Como el archivo gana, el server loguea al boot de qué fuente salió cada valor
(`effective config resolved`, con el mapa `sources`): agregar un `sdlc.config.yaml` a un deploy
existente no debe cambiar el auth en silencio. Resolver en `src/config/resolve.ts`.

Los **adapters no se declaran en el archivo**: su fuente de verdad es `tenant_integrations`,
editable desde el panel, porque esa fila lleva además las referencias de credenciales que el YAML
no tiene dónde expresar. Reconciliarlos al boot sobrescribiría lo que configuró el operador.

## Las superficies MCP

El server expone las tools por tres caminos. Los tres consumen el mismo `ToolRegistry`, así
que las guardas, el rate limit y las spans son las mismas; lo que cambia es para quién es cada uno.

| Superficie | Ruta | Para qué existe |
|---|---|---|
| **Streamable HTTP** | `POST /mcp` | Lo que usa un cliente MCP estándar (Claude Code, Claude Desktop, Cursor). Es la URL que se configura |
| **Debug HTTP** | `POST /mcp/tools/:name` | Un tool call con `curl`, sin handshake ni JSON-RPC. Lo usan los runbooks para verificar un deploy |
| **stdio** | `pnpm mcp` | Modo local, sin auth (ver `mcp-stdio.ts`) |

**`/mcp` y `/mcp/tools/:name` no son duplicados.** Verificar un deploy o debuggear una tool a las
tres de la mañana contra un transport MCP real requiere un cliente que haga el handshake; contra
el endpoint de debug alcanza con `curl`. Borrar el segundo por parecer redundante deja a los
runbooks sin su verificación.

**`/mcp` es stateless** (`src/http/mcp-transport.ts`): un transport y un `McpServer` efímeros por
request, sin `Mcp-Session-Id`, con respuesta JSON y no SSE. `GET` y `DELETE /mcp` contestan 405.
Encaja porque ninguna tool notifica ni streamea, y sobrevive a un reinicio sin que el cliente lo
note. **Lo que cede:** el server no puede iniciar nada hacia el cliente. El día que una tool larga
quiera reportar progreso (`sync_backlog` sobre un backlog grande es la candidata) hay que volver
acá, y eso trae sesiones en memoria por proceso y, con dos réplicas, sticky routing.

**El ctx.** El Bearer se autentica **antes** de construir el transport; el `TenantCtx` viaja en un
`AsyncLocalStorage` que el handler de cada tool lee vía `resolveCtx`. Lo fija el test de tokens en
paralelo de `test/mcp-http-transport.test.ts`.

**Los rechazos.** Una guarda que devuelve `{ ok: false }` sale por MCP con `isError: true`, igual
que un input que no pasa el schema: son respuestas válidas del protocolo (HTTP 200), no 500. Un
500 haría que el cliente reintente algo que nunca va a andar.

## Observabilidad: traces de las tool calls

OpenTelemetry, **apagado por default** (`apps/server/src/telemetry/tracing.ts`).

**Qué se instrumenta: el `ToolRegistry`.** Es el punto por donde pasan las dos superficies
—HTTP y stdio— y el único que conoce a la vez el nombre de la tool, el input y el
`TenantCtx`. Instrumentar la ruta HTTP dejaría stdio afuera; instrumentar cada tool a mano
se olvidaría en la próxima. Sale una span por tool call, `mcp.tool <nombre>`, kind `SERVER`.

| Atributo | De dónde sale |
|---|---|
| `mcp.tool.name` | la tool |
| `sdlc.tenant_id` | `ctx.tenantId` |
| `sdlc.workspace_id` | el `project` del `flow_id`, o `input.project` cuando todavía no hay flow |
| `sdlc.flow_id` / `sdlc.story_id` | el input, si los trae |
| `mcp.tool.ok` | `false` cuando la tool rechazó por negocio (`{ ok: false }`) |
| `error.type` | la **clase** de la excepción, cuando tiró |

**Lo que no viaja, y por qué.** Ni el input, ni el resultado, ni el mensaje del error —un
error de validación cita el documento que valida—, ni la identidad de la persona. Un trace
se exporta a un colector que puede ser de un tercero: lo que no puede estar ahí no se pone.
Los ids alcanzan para volver al flow y mirar `flow_events` en la base, que sí es nuestra.

**Costo cuando está apagado: ninguno.** Lo único que se carga siempre es
`@opentelemetry/api`, que sin provider global registrado es un no-op. El SDK y el exporter
—lo que pesa— entran por `import()` dinámico dentro de `startTelemetry`, así que un deploy
sin observabilidad no los carga nunca. Y apagado, `instrumentRegistry` devuelve el registry
**tal cual**: no hay wrapper, no hay span no-grabadora, no hay armado de atributos por
llamada.

Se prende con `OTEL_TRACES_ENABLED=true` + `OTEL_EXPORTER_OTLP_ENDPOINT` (OTLP/HTTP).
Prenderlo sin endpoint **rompe el arranque**: traces sin destino parecen andar y no exportan
nada. Métricas y logs quedan afuera por ahora — las métricas del server son las del
proceso y hoy las mira el healthcheck.

## Rate limiting

El server expone tres superficies HTTP (MCP, panel admin, OAuth) y hasta la Fase 5 ninguna
tenía techo. El límite vive en `apps/server/src/http/rate-limit.ts`, se registra como hook
`onRequest` antes de cualquier ruta (así cubre también el 404 y los estáticos del panel) y
está **prendido por default**.

**El eje es la identidad efectiva del caller cruzada con la familia de rutas.**

- *Por qué no el tenant:* el deploy es single-tenant, así que limitar por tenant es limitar a
  todos juntos — el primer agente en un loop deja sin server al resto.
- *Por qué no sólo la IP:* una oficina entera sale por una NAT y, detrás de un proxy, la IP es
  un header que el cliente escribe. Sí queda como **fallback** cuando todavía no hay
  credencial, que es justo el caso de `/oauth`.
- *La identidad, en orden:* access token Bearer → cookie de sesión del panel → IP. El token no
  se verifica en el limiter (eso es trabajo de `authenticate`, y duplicarlo costaría una
  verificación de firma por request antes de saber si el request siquiera entra): se usa
  **hasheado y truncado** como proxy de identidad, así la credencial no queda viva en el Map ni
  en un log.
- *Por qué además por familia de rutas:* los presupuestos razonables son de órdenes distintos.
  Un cupo único obligaría a poner el techo del más ruidoso y `/oauth` —donde vive el fuerza
  bruta— quedaría sin protección real.

| Bucket | Rutas | Default (por identidad / minuto) | Env var |
|---|---|---|---|
| `mcp` | `/mcp*` | 240 | `RATE_LIMIT_MCP_MAX` |
| `admin` | `/admin/api/*` | 300 | `RATE_LIMIT_ADMIN_MAX` |
| `oauth` | `/oauth/*`, `/.well-known/oauth-*` | 60 | `RATE_LIMIT_OAUTH_MAX` |
| `default` | el resto | 120 | `RATE_LIMIT_DEFAULT_MAX` |

Al excederse: **429** con `Retry-After` en segundos; toda respuesta limitada lleva
`x-ratelimit-limit` / `-remaining` / `-reset`. **`/health` queda exento**: lo pega el
healthcheck del compose cada pocos segundos desde una sola IP y un 429 ahí se lee como server
caído. `RATE_LIMIT_ENABLED=false` lo apaga entero; un valor inválido en cualquiera de las env
vars **rompe el arranque** en vez de caer al default, porque un typo que apague el límite en
silencio es peor que no tener límite.

Alcance: ventana fija **en memoria y por proceso**, que es lo que corresponde a un deploy de
una sola instancia. Con más de una réplica el contador tiene que mudarse a un store compartido;
por eso los tests miran el borde HTTP (status + headers) y no el contador.
### Env vars que llevan una referencia y no un valor

`DATABASE_URL`, `OAUTH_SIGNING_SECRET`, `ADMIN_SESSION_SECRET` y el client secret del OIDC por
env aceptan un `aws-sm://<name>#<key>` en lugar del valor, y se resuelven al boot con el
`SecretResolver` del deploy (`src/config/secret-env.ts`). Es la misma forma que ya tenían las
credenciales de los adapters y `auth.oidc.clientSecretRef`, extendida a lo que sólo existe como
env var: sin eso, el deploy obliga a materializar esos valores en un archivo de la instancia.

La lista es **cerrada**. Resolver cualquier env var contra Secrets Manager convertiría un typo en
una llamada a la API y haría imposible leer de un vistazo qué es secreto. Un valor literal no
dispara nada, así que dev y tests no cambian. Al boot se loguean los nombres de los campos
resueltos (`secretRefsResolved`), nunca los valores.

## Deploy

Una sola EC2 con docker compose; los secretos en AWS Secrets Manager resueltos con el **instance
role**, así que en el deploy viven referencias y ningún valor de credencial toca el disco.

| Pieza | Dónde |
|---|---|
| Imagen (server + SPA del panel + migraciones) | `infra/docker/Dockerfile` |
| Stack de prod (postgres, migrate, server, caddy) | `infra/compose.prod.yml` |
| EC2, security group, instance profile, ECR, secretos | `infra/terraform/` |
| Deploy en la instancia | `infra/scripts/deploy.sh` |
| Procedimiento completo | [`runbook-deploy-prod.md`](./runbook-deploy-prod.md) |

Una imagen sola para los tres usos —arrancar el server, servir el panel y aplicar las
migraciones— es deliberado: hace imposible migrar con un build y arrancar con otro. Por eso el
runner de migraciones vive en `src/state/` y se compila, en vez de correrse con tsx desde un
checkout.

## Estado y persistencia

Postgres 16 + Drizzle ORM (Fase 1+):

- `workspaces(workspace_id, name, group_id, created_at)` y `workspace_members(email, workspace_id, roles, created_at, PK(email, workspace_id))` — membresía N:M. Se reconcilian al boot desde `sdlc.config.yaml` (idempotente, nunca borra). (`tenant_members` quedó deprecada.)
- `groups(group_id, name, created_at)` — agrupación opcional de workspaces, sin efecto en permisos.
- `oauth_codes` / `oauth_refresh_tokens` llevan `workspaces jsonb` (el mapa que emite el JWT como claim)
- `flows(flow_id, tenant_id, project, slug, status, current_phase, initiative_type, prd_ref, rfc_ref, epic_external_id, …)`
- `flow_events(flow_id, type, actor, payload_jsonb, ts)` — audit + event sourcing ligero

El MCP es stateless respecto a artefactos largos (PRD/RFC viven en repo o Confluence) y a la verdad de tareas (sistema externo). Stateful solo para coordinación.

## Roadmap

| Fase | Entrega |
|---|---|
| 0 | Bootstrap monorepo + 3 tools + catálogo PM/TL — ✅ |
| 1 | Catálogo extendido + tools PRD/RFC + Postgres + flow state — ✅ |
| 2 | TaskSystemAdapter + tools de shaping — ✅ · adapter real Azure DevOps Boards + AWS Secrets Manager — ✅ |
| 3 | Roles dev/qa/reviewer + tools de impl/QA/review — ✅ · adapters reales (ADO Boards, Google Drive, ADO Repos + GitHub PRs) — ✅ (**HOY**) |
| 4 | panel admin web — ✅ · Google SSO (panel + MCP, OAuth 2.1 spec MCP) — ✅ · adapters Linear y GitHub Issues — ✅ · deploy prod (EC2 + compose + Terraform, [runbook](./runbook-deploy-prod.md)) — ✅ |
| 5 | Hardening: rate limiting (identidad × familia de rutas, 429 + `Retry-After`) — ✅ · versionado del catálogo enforceable (sello contenido↔versión) — ✅ · OTEL (una span por tool call, apagado por default) — ✅ · doc de prompt-authoring — ✅ · Streamable HTTP del MCP (`POST /mcp`, stateless) — ✅ · backups de Postgres |
