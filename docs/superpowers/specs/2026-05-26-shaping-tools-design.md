# Design — Fase 2 Shaping (slice 1: tools + adapter fake)

**Fecha:** 2026-05-26
**Autor:** vazquez.n.g@gmail.com
**Estado:** draft
**Target task system:** Azure DevOps (adapter real en spec siguiente)

## Context

La Fase 2 del roadmap (`docs/ARCHITECTURE.md`) cubre el shaping del backlog: descomponer un RFC aprobado en una épica + historias + sub-tareas y crearlas en el sistema externo del tenant. Los prompts del rol PMO (`packages/catalog/roles/pmo/phases/shaping.md`) y el `breakdown-template` ya existen y referencian 5 tools (`propose_breakdown`, `create_epic`, `create_stories`, `link_subtasks`, `sync_backlog`) que todavía no están implementadas como código. La interface `TaskSystemAdapter` ya existe en `packages/adapters-contracts/src/tasksys.ts` pero no tiene implementaciones concretas, y el `resolveSecret` de `TenantCtx` lanza error (no hay vault).

La Fase 2 completa son tres piezas encadenadas: (A) vault de credenciales + `resolveSecret`, (B) adapter Azure DevOps real, (C) las 5 tools de shaping. Este spec cubre **solo (C) + un adapter fake en-memoria**, entregando un flujo de shaping testeable end-to-end sin red ni credenciales. El adapter Azure DevOps real y el vault son specs/planes siguientes; el modelo de datos de este slice se diseña para que el adapter real encaje sin reescribir las tools.

## Goals

- Implementar las 5 tools de shaping como código, conectadas a un `TaskSystemAdapter`.
- Proveer un `InMemoryTaskSystemAdapter` testeable (sin red) que implementa la interface completa.
- Cubrir el happy path completo `rfc_ready → backlog_ready` con tests, más guard rails.
- Dejar el modelo de datos compatible con Azure DevOps (Epic → User Story → Task) para que el adapter real encaje después.

## Non-goals

- No se implementa el adapter Azure DevOps real (REST API, PAT auth). Spec siguiente.
- No se implementa el vault de credenciales ni `resolveSecret` productivo. Spec siguiente.
- No se agrega tabla nueva de persistencia (las refs viven en `flow_events`; el sistema externo es la verdad).
- No se toca el nivel Feature de Azure DevOps (se usa Epic → User Story → Task de 3 niveles).
- No se implementan tools de implementación/QA/review (Fase 3).

## Architecture context

### Architecture mode

`reuse` — extiende el patrón existente sin tecnologías nuevas: factory polimórfico (espejo de `FlowStore`), una tool por archivo en `apps/server/src/mcp/tools/`, validadores puros en `apps/server/src/validation/`, tipos zod en `packages/core`. La interface `TaskSystemAdapter` ya existe y se reusa tal cual.

### Existing components reused

- `packages/adapters-contracts/src/tasksys.ts` — `TaskSystemAdapter`, `EpicInput`, `StoryInput`, `SubtaskInput`, `TaskItem`, `ExternalRef`, `TaskQuery`. Se extiende `TaskSystemKind` con `'azure-devops'`.
- `packages/core/src/flow.ts` — `FlowStatus` (ya tiene `backlog_ready`), `CurrentPhase` (ya tiene `shaping`/`implementation`), `FlowEventType` (ya tiene `breakdown.proposed`, `epic.created`, `stories.created`, `subtasks.linked`).
- `apps/server/src/validation/markdown-sections.ts` — helper de extracción de secciones, reusado por la heurística de `propose_breakdown`.
- `apps/server/src/state/store.ts` (`FlowStore`) — `updateFlow` (ya soporta `epic_external_id`), `appendEvent`, `getFlow`.
- `apps/server/src/mcp/tools/index.ts` — `BuildRegistryDeps`, `buildToolRegistry`.

### Codebase context

Monorepo pnpm + turbo, TypeScript estricto (`exactOptionalPropertyTypes: true`). Tests con vitest (los de integración se skippean sin `TEST_DATABASE_URL`). Convención: una tool por archivo, factory para piezas polimórficas, validadores puros que devuelven `{ ok, issues[] }`. Tools devuelven `{ ok, data?, error?, next_actions? }`.

### Integration points

- **Tools ↔ TaskSystemAdapter**: las tools de creación llaman al adapter inyectado en `BuildRegistryDeps.taskSystem`. El adapter recibe `ctx: TenantCtx` (el fake lo ignora; el real lo usará para `resolveSecret`).
- **Tools ↔ FlowStore**: `create_epic` persiste `epic_external_id`; todas emiten `flow_events` con las refs; `sync_backlog` avanza el status.
- **propose_breakdown ↔ markdown-sections**: la heurística parsea el `rfc_markdown` recibido como input (el server no almacena el cuerpo del RFC).

## Design

### Capa de adapter

1. **Enum**: agregar `'azure-devops'` a `TaskSystemKind` en `tasksys.ts`. La interface `TaskSystemAdapter` no cambia.
2. **`InMemoryTaskSystemAdapter`** (`apps/server/src/adapters/in-memory-task-system.ts`): implementa los 7 métodos. Guarda work items en un `Map<string, TaskItem>` con contador incremental. Genera refs deterministas:
   - `external_id`: `"ADO-<n>"` (n incremental por instancia).
   - `url`: `"https://dev.azure.com/<org>/<project>/_workitems/edit/<n>"` (org fijo `"sdlc-demo"` o derivado del `project_key`).
   - `kind: 'azure-devops'`.
   - `createEpic/Story/Subtask` crean un `TaskItem` con type `epic`/`story`/`subtask`, status inicial `"New"`.
   - `linkChildToParent` setea `parent_id`.
   - `getItem` lee del Map (throw si no existe).
   - `transition` cambia `status`.
   - `search` filtra el Map por `TaskQuery`.
3. **Factory** (`apps/server/src/adapters/factory.ts`): `makeTaskSystemAdapter(config): TaskSystemAdapter`. En este slice siempre devuelve `new InMemoryTaskSystemAdapter()`. Documentado que el adapter real se seleccionará por config/env en el spec siguiente.

### Tipos del breakdown (zod en core)

Nuevo `packages/core/src/shaping.ts`:

```ts
EpicInput     = { title: string(min 1), description: string, labels?: string[] }
SubtaskInput  = { title: string(min 1), description?: string }
StoryInput    = { title: string(min 1), description: string, acceptance_criteria: string[], labels?: string[], estimate?: number, subtasks?: SubtaskInput[] }
Breakdown     = { epic: EpicInput, stories: StoryInput[] (min 1) }
ExternalRefZ  = { external_id: string, url: string }
```

Exportados desde `packages/core/src/index.ts`. Espejan las interfaces TS de `adapters-contracts` pero con validación zod para los inputs de las tools.

### Heurística de propose_breakdown

`apps/server/src/shaping/propose.ts`, función pura `proposeBreakdown(rfcMarkdown, flowTitle, rfcRef): Breakdown`:
- Parsea el markdown con `extractSections` (reusado de markdown-sections, exportando el helper si hace falta).
- Épica: `title = flowTitle`, `description = "Derivado del RFC: <rfcRef>"`.
- Historias: una por sub-sección H3 dentro de `## Design` (ej. `### Data model`, `### API / Contracts`), más una por bullet de `## Goals`. Cada story sugerida lleva `acceptance_criteria: []` (el agente las completa) y `description` con el texto de la sección.
- Determinista: misma entrada → misma salida. No usa LLM ni aleatoriedad.

### Validación del breakdown

`apps/server/src/validation/breakdown.ts`, `validateBreakdown(b): ValidationResult`:
- Error si `epic.title` vacío.
- Error si `stories.length < 1`.
- Error si alguna story tiene `title` vacío o `acceptance_criteria.length < 1`.
- Warning si una story tiene `acceptance_criteria.length > 5` (heurística de tamaño).

### Las 5 tools

Cada una en su archivo bajo `apps/server/src/mcp/tools/`, registrada en `tools/index.ts`. Todas validan `flow.tenant_id === ctx.tenantId` y devuelven `{ ok, data?, error?, next_actions? }`.

1. **`propose_breakdown({flow_id, rfc_markdown})`** — requiere `flow.status === 'rfc_ready'` (si no, error). Corre `proposeBreakdown`, emite `breakdown.proposed`, devuelve `{ suggested_breakdown, template }` (el `template` es el contenido de `breakdown-template` vía catálogo). No muta estado externo ni avanza status.
2. **`create_epic({flow_id, epic})`** — requiere `rfc_ready`. Valida el `epic` (título no vacío). Llama `taskSystem.createEpic`, persiste `epic_external_id` en el flow vía `updateFlow`, emite `epic.created` con la `ExternalRef`. Devuelve `{ epic_ref }`.
3. **`create_stories({flow_id, epic_id, stories})`** — requiere que `flow.epic_external_id` exista (si no, error "create_epic first"). Por cada story: `taskSystem.createStory` + `linkChildToParent(epic_id, story_id)`. Emite un único `stories.created` con el array de refs. Devuelve `{ story_refs: ExternalRef[] }`.
4. **`link_subtasks({flow_id, story_id, subtasks})`** — por cada subtask: `taskSystem.createSubtask` + `linkChildToParent(story_id, subtask_id)`. Emite `subtasks.linked` con las refs. Devuelve `{ subtask_refs: ExternalRef[] }`.
5. **`sync_backlog({flow_id})`** — agrega las refs de los `flow_events` previos (`epic.created`, `stories.created`, `subtasks.linked`). **Requiere ≥1 story creada** (si no, error "no stories created yet" y no avanza). Avanza `status=backlog_ready` + `current_phase=implementation`. Emite un `stories.created` final con el snapshot completo (o reusa el último; ver Open Questions). Devuelve `{ epic, stories[], subtasks[] }`.

### Wiring

- `BuildRegistryDeps` suma `taskSystem: TaskSystemAdapter`.
- `buildToolRegistry` registra las 5 tools nuevas pasando `store`, `catalog` (para `propose_breakdown` que lee el template) y `taskSystem`.
- Bootstrap (`apps/server/src/index.ts` y `mcp-stdio.ts`): crean el adapter vía `makeTaskSystemAdapter(config)` y lo inyectan.
- Tests construyen el registry con `new InMemoryTaskSystemAdapter()`.

### Persistencia y status

- Sin tabla nueva. `epic_external_id` en `flows` (ya existe).
- Refs completas en payloads de `flow_events`.
- `sync_backlog` avanza `status=backlog_ready`, `current_phase=implementation`.

### Catálogo

Ajuste menor a `roles/pmo/phases/shaping.md`: aclarar que `propose_breakdown` recibe `rfc_markdown`. Bump de la phase `shaping` a `0.2.0` en `catalog.yaml`. Sin skills/templates nuevos, sin bump de `catalog_version` salvo que se prefiera (el cambio es aditivo/documental).

## Alternatives considered

1. **Server genera el breakdown desde el RFC (parsing pesado)** — descartada: parsing de markdown libre es frágil; el agente tiene mejor contexto. La heurística queda como sugerencia, no como verdad.
2. **Tabla `flow_backlog_items`** — descartada: duplica estado que vive en Azure DevOps (drift), agrega migration. Las refs en `flow_events` alcanzan para audit + `sync_backlog`.
3. **Implementar el adapter Azure DevOps real ya** — descartada para este slice: requiere vault + mock de REST API; el adapter fake permite avanzar las tools end-to-end primero.
4. **Jerarquía con Feature (Epic→Feature→Story→Task)** — descartada: 3 niveles cubren la mayoría; agregar Feature complica el modelo sin valor inmediato.

## Risks

| Riesgo | Tipo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|---|
| El modelo del adapter fake no encaja con Azure DevOps real y hay que reescribir tools | integ | M | M | El modelo se basa en la interface `TaskSystemAdapter` ya pensada para múltiples backends; Epic→Story→Task mapea directo a Azure DevOps work item types. |
| `sync_backlog` agregando refs desde eventos es frágil si el orden/estructura de payloads cambia | data | L | M | Tipar los payloads de los eventos de shaping; tests cubren el agregado. |
| La heurística de `propose_breakdown` produce historias pobres y el equipo la ignora | maintainability | M | L | Es explícitamente una sugerencia; el prompt PMO ya dice "no la aceptes ciegamente". |

## Rollout

- Slice 1 (este spec): tools + adapter fake. Merge a main.
- Slice 2 (spec siguiente): vault de credenciales + `resolveSecret` productivo.
- Slice 3 (spec siguiente): adapter Azure DevOps real seleccionable por config, con mock de REST API en tests.

## Rollback

Si el slice rompe algo:
1. Las 5 tools son aditivas; revertir el commit de wiring (`tools/index.ts`) las desregistra sin afectar las tools existentes.
2. El enum `'azure-devops'` y los tipos de core son aditivos (no rompen nada existente).
3. No hay migration ni cambio de schema, así que no hay rollback de DB.

## Observability

- Logs en cada tool: `{ flow_id, tool, refs_count }`.
- Eventos de audit ya cubiertos por `flow_events` (`breakdown.proposed`, `epic.created`, `stories.created`, `subtasks.linked`).
- Métricas formales: Fase 5.

## Open Questions

- `sync_backlog`: ¿emite un event nuevo de snapshot o reusa el agregado de los existentes? Propuesto: agrega desde los eventos previos y emite un `stories.created` final con el snapshot. A confirmar en implementación si conviene un tipo de evento `backlog.synced` (requeriría sumarlo al enum `FlowEventType`).
- ¿`create_stories` debe ser idempotente si se llama dos veces? Propuesto: no idempotente en este slice (cada llamada crea nuevos work items); el agente controla. Idempotencia real llega con el adapter Azure DevOps.
