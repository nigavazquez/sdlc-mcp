# Real Adapters — Slice 1: Foundations (secrets + adapter selection)

**Fecha:** 2026-06-08
**Estado:** diseño aprobado, pendiente de plan de implementación

## Contexto

`sdlc-mcp` debe conectarse con sistemas externos reales:

- **Azure DevOps Boards** → backlog (epics/stories/subtasks) — reemplaza el `TaskSystemAdapter` in-memory.
- **Google Drive** (unidad compartida) → PRD/RFC/ADR, con carpetas **Tribu / Squad / Flow**.
- **Azure DevOps Repos + GitHub** → PRs (fase Review), configurable por tenant/proyecto.
- **AWS Secrets Manager** → credenciales, detrás de `resolveSecret`.

Ese alcance es demasiado grande para un solo spec. Se decompone en 4 slices, cada uno
con su propio ciclo spec → plan → implementación:

1. **Slice 1 (este doc) — Fundamentos:** secrets reales + selección de adapters por tenant/proyecto.
2. **Slice 2 — Azure DevOps Boards** (`TaskSystemAdapter` real).
3. **Slice 3 — Google Drive DocStore** (PRD/RFC/ADR, Tribu/Squad/Flow, + modelo de flow).
4. **Slice 4 — PR/Review** (Azure DevOps Repos + GitHub + tools `request_code_review` / `submit_review_outcome`).

Orden recomendado: 1 → 2 → 3 → 4. Slice 1 es la base de los otros tres.

### Estado del código relevante (hoy)

- Los adapters se inyectan **una sola vez en el bootstrap** como instancia global:
  `buildToolRegistry({ catalog, store, taskSystem })`. No hay selección por tenant.
- `makeTaskSystemAdapter()` siempre devuelve `InMemoryTaskSystemAdapter` (que ya imita
  el modelo de ADO: Epic → User Story → Task).
- `DocStoreAdapter` (contract) existe pero **no está cableado** en ningún lado.
- `TenantCtx.resolveSecret` está **stubbeado**: en `apps/server/src/auth/api-key.ts` tira
  `Error('Secret resolver not configured in bootstrap auth')`; idem en `mcp-stdio.ts`.
- La tabla `tenants` ya tiene columnas `task_system` / `doc_system` (text) **sin usar**.
- 7 tools consumen el task-system: `create_epic`, `create_stories`, `link_subtasks`,
  `claim_story`, `report_progress`, `submit_qa_results`, `block_story`.

## Objetivo del Slice 1

Entregar, probado de punta a punta:

1. **`SecretResolver` real** contra AWS Secrets Manager (+ impl `env` para dev/tests),
   reemplazando el stub de `ctx.resolveSecret`.
2. **`IntegrationConfigStore`** — config de integración por `(tenant, project)`
   (Postgres + in-memory).
3. **`TaskSystemProvider`** — selección del adapter en tiempo de llamada según config,
   resolviendo el secret-ref vía `ctx.resolveSecret`, con el fake in-memory como default.

Los adapters reales (ADO Boards / Drive / PRs) **no** se implementan acá. Para los kinds
reales, el provider valida que el secret-ref resuelve y luego lanza `NotImplementedError`
indicando el slice que lo entrega. Lo que se prueba en Slice 1 es **el cableado de
selección + secretos**, no el adapter real.

## Enfoque elegido

**Capa de "providers" resueltos en tiempo de llamada (Enfoque A).** Se descartaron:

- **B (adapters en el ctx al autenticar):** acopla auth a todos los adapters, resuelve
  secrets aunque no se usen, y no puede variar por proyecto/flow (en auth no se conoce el flow).
- **C (selección global por env):** no es por-tenant. Descartado por requisito.

## Arquitectura

```
tool handler (ej. create_epic)
  const ts = await taskSystemProvider.resolve(ctx, flow)
  await ts.createEpic(...)
        │ resolve(ctx, flow)
        ▼
  TaskSystemProvider ──lee config──▶ IntegrationConfigStore (tenant_integrations)
        │ si kind real → ctx.resolveSecret('aws-sm://...')
        ▼
  SecretResolver (AWS SM impl) ──▶ AWS Secrets Manager
```

Unidades nuevas (cada una testeable en aislamiento):

| Unidad | Propósito | Ubicación | Depende de |
|---|---|---|---|
| `SecretResolver` (+ `AwsSecretsManagerResolver`, `EnvSecretResolver`) | resolver un secret-ref a un string | `apps/server/src/secrets/` | AWS SDK / env |
| `IntegrationConfigStore` (+ Postgres + in-memory) | config de integración por `(tenant, project)` | `apps/server/src/state/` | Drizzle / nada |
| `TaskSystemProvider` (`ConfigBackedTaskSystemProvider`) | elegir + construir el adapter por config | `apps/server/src/adapters/` | config store + ctx.resolveSecret |

Las interfaces `DocStoreProvider` y `PullRequestProvider` se **definen** (contratos) pero su
resolución real queda para Slices 3 y 4. Slice 1 cablea de punta a punta **solo**
`TaskSystemProvider` (único consumido hoy).

## Contratos y modelo de datos

### Secret-ref

String opaco; la tool nunca lo interpreta, solo lo pasa a `resolveSecret`:

```
aws-sm://<secret-name>           → secreto entero (string)
aws-sm://<secret-name>#<key>     → campo <key> de un secreto JSON
```

```ts
interface SecretResolver {
  resolve(ref: string): Promise<string>;
}
```

- `AwsSecretsManagerResolver`: usa `@aws-sdk/client-secrets-manager` (`GetSecretValue`).
  Cachea por `secret-name` con TTL corto. Soporta el sufijo `#key` (parsea el secreto JSON).
  Credenciales de AWS por IAM role/env del server (no se configuran acá). No cachea errores.
- `EnvSecretResolver`: mapea el ref a una env var (ej. `aws-sm://ado-pat` → `SECRET_ADO_PAT`).
  Para dev/tests.

`ctx.resolveSecret` delega en el `SecretResolver` elegido por `config.secretsBackend`
(`'aws' | 'env'`, default `'env'` en dev).

### `tenant_integrations` (tabla nueva)

| columna | tipo | nota |
|---|---|---|
| `tenant_id` | text | PK parte 1 |
| `project` | text | PK parte 2; `''` = default del tenant (fallback) |
| `task_system` | jsonb | `IntegrationRef` (ver abajo) |
| `doc_store` | jsonb | `IntegrationRef` — usado en Slice 3 |
| `pr_provider` | jsonb | `IntegrationRef` — usado en Slice 4 |
| `created_at` / `updated_at` | timestamptz | |

```ts
interface IntegrationRef {
  kind: string;                       // task-system: 'in-memory' | 'azure-devops'
  secret_ref?: string;                // ej. 'aws-sm://ado-pat#token'
  settings: Record<string, unknown>;  // ej. { org, project } para ADO
}
```

Resolución: match exacto `(tenant, project)` → fallback al row `project=''` → si no hay
ninguno, default `{ kind: 'in-memory' }`. Esto preserva el comportamiento actual y mantiene
los tests verdes sin necesidad de sembrar config.

### `IntegrationConfigStore`

```ts
interface IntegrationConfigStore {
  getTaskSystemConfig(tenantId: string, project: string): Promise<IntegrationRef>;
  // getDocStoreConfig / getPrProviderConfig — definidos, usados en slices posteriores
}
```

Impl Postgres (`PostgresIntegrationConfigStore`, Drizzle) + in-memory
(`InMemoryIntegrationConfigStore`, arranca vacía, permite sembrar config en tests).
Factory que elige según `DATABASE_URL`, igual que `FlowStore`.

### `TaskSystemProvider`

```ts
interface TaskSystemProvider {
  resolve(ctx: TenantCtx, flow: Flow): Promise<TaskSystemAdapter>;
}
```

`ConfigBackedTaskSystemProvider.resolve`:

1. `cfg = configStore.getTaskSystemConfig(ctx.tenantId, flow.project)`.
2. `kind === 'in-memory'` → devuelve la instancia compartida de `InMemoryTaskSystemAdapter`.
3. `kind === 'azure-devops'` → resuelve `cfg.secret_ref` vía `ctx.resolveSecret` (prueba el
   cableado de secretos) y luego lanza `NotImplementedError('azure-devops task system arrives in Slice 2')`.
4. kind desconocido → `Error('unknown task_system kind: <kind>')`.

## Bootstrap y refactor de tools

- **`resolveSecret` wiring:** `loadConfig()` agrega `secretsBackend`. Se instancia el
  `SecretResolver` correspondiente y se inyecta en `authenticate(req)` (api-key.ts) y en
  `mcp-stdio.ts`. `ctx.resolveSecret = (ref) => resolver.resolve(ref)`.
- **Inyección de adapters:** `buildToolRegistry` pasa de recibir `{ taskSystem }` a
  `{ taskSystemProvider }`. Las 7 tools que consumen task-system cambian su factory para
  recibir `taskSystemProvider` y resolver dentro del handler:
  ```ts
  const flow = await store.getFlow(input.flow_id);
  const ts = await taskSystemProvider.resolve(ctx, flow);
  ```
  Las tools que no tocan task-system quedan igual.
- **`start_flow` / Tribu / Squad:** NO se tocan en Slice 1. Entran en Slice 3 (es donde se usan).
- **Config nueva** en `config.ts`: `SECRETS_BACKEND` (default `env`). El `env` resolver
  lee secretos desde env vars con naming convenido. AWS SM no necesita env extra (credenciales
  estándar del SDK).

## Manejo de errores

| Situación | Comportamiento |
|---|---|
| Secret no encontrado / error de AWS | `SecretResolutionError` (sin filtrar el valor); la tool responde `{ ok:false, error:'integration credential unavailable' }` (no expone el ref interno) |
| Config ausente | fallback a `in-memory` (no es error) |
| `kind` desconocido | `{ ok:false, error:'unknown task_system kind: X' }` |
| `NotImplementedError` (kinds reales en S1) | `{ ok:false, error }` claro indicando el slice que lo entrega; no rompe el server |
| Flow inexistente | lo manejan las tools (`Unknown flow`); el provider asume flow válido |

El cache del resolver no cachea fallos: en error de AWS reintenta la próxima.

## Testing

- **`AwsSecretsManagerResolver`** — unit con SDK mockeado (`aws-sdk-client-mock`): secreto
  plano, secreto JSON con `#key`, cache hit, error → `SecretResolutionError`. Sin red.
- **`EnvSecretResolver`** — lee env; error si falta.
- **`InMemoryIntegrationConfigStore`** — match exacto, fallback a `project=''`, default
  `in-memory` sin config.
- **`PostgresIntegrationConfigStore`** — integración (skippeable sin `TEST_DATABASE_URL`).
- **`ConfigBackedTaskSystemProvider`** — `in-memory` → fake; `azure-devops` → resuelve secret
  (mock) y luego `NotImplementedError`; kind desconocido → error.
- **Regresión:** los ~105 tests actuales siguen verdes (default `in-memory`; los tests de
  tools existentes siembran un provider que devuelve el fake).

## Fuera de scope (Slice 1)

- Adapter real de Azure DevOps Boards → **Slice 2**.
- Google Drive DocStore + Tribu/Squad + ADR + cambios al modelo de flow → **Slice 3**.
- PR/Review tools y adapters (Azure DevOps Repos + GitHub) → **Slice 4**.

Slice 1 entrega: secrets reales (AWS SM), config store por tenant/proyecto, y el
`TaskSystemProvider` cableado de punta a punta con el fake como default.
