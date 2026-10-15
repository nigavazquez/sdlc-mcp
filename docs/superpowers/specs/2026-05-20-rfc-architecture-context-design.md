# Design — Architecture Context en RFC y propagación por escenario

**Fecha:** 2026-05-20
**Autor:** vazquez.n.g@gmail.com
**Estado:** draft
**Bump catálogo objetivo:** `0.2.0 → 0.3.0`

## Context

Hoy el flujo RFC → Implementation → QA → Code Review del MCP asume un escenario genérico: el Tech Lead redacta el RFC y los roles downstream reciben siempre el mismo bundle de prompt + skills + templates. No se distingue entre:

- Una feature que **inaugura una arquitectura nueva** vs. una que **reusa componentes de infraestructura existentes**.
- Un trabajo sobre un **codebase preexistente** (donde hay convenciones, tests, dependencias que respetar) vs. un **greenfield** (donde hay que bootstrapear).

Esa distinción cambia materialmente lo que debe hacer cada rol después del RFC (qué validar, qué tests sumar, qué buscar en code review, qué cubrir en QA). Sin clasificación explícita, se pierde guidance específico y aumenta el riesgo de duplicar utilities, romper contratos de componentes reusados, o introducir stack drift en codebases existentes.

Este diseño introduce **clasificación obligatoria dentro del RFC** y **propagación automática vía skills extra** por escenario, sin agregar fases nuevas al flow ni romper backwards-compat de los flows existentes.

## Goals

- Forzar al Tech Lead a declarar `architecture_mode` y `codebase_status` en cada RFC.
- Que los roles Developer / QA / Reviewer reciban automáticamente skills extra según el escenario declarado, sin que el agente client-side tenga que pasar parámetros adicionales.
- Mantener el modelo actual de "MCP entrega prompt+skills+templates por (role, phase)" — sin nuevas fases ni tools.
- Permitir flows preexistentes (sin clasificación) sigan funcionando: los nuevos campos son nullables hasta el `submit_rfc` correspondiente.

## Non-goals

- No se integra con el repo del cliente (el MCP no clona ni lee código).
- No se introduce catálogo de componentes de infraestructura por tenant (eso es trabajo futuro).
- No se cambian las fases PRD ni Shaping; la clasificación nace en RFC.
- No se versionan las skills nuevas más allá de `0.1.0` inicial; cada bump posterior sigue el proceso normal del catálogo.

## Architecture context

### Architecture mode

`reuse` — extiende el sistema actual (`sdlc-mcp`) sin introducir tecnologías nuevas. Se agregan campos a un schema existente, secciones a un template, entries a `catalog.yaml`, y una nueva regla en el validador del RFC. Toda la lógica vive en las capas ya presentes (`packages/core`, `packages/catalog`, `apps/server`).

### Existing components reused

- `packages/catalog/templates/rfc-template.md` — se extiende.
- `packages/catalog/catalog.yaml` — se le suma sección `scenario_skills` y se registran skills nuevas.
- `packages/catalog/roles/tech-lead/phases/rfc-draft.md` — se actualiza `required_sections` y procedimiento.
- `apps/server/src/validation/rfc.ts` — se le suman reglas para frontmatter + sub-secciones.
- `apps/server/src/state/schema.ts` — se le agregan 3 columnas a `flows`.
- `apps/server/src/mcp/tools/submit-rfc.ts` — parsea frontmatter y persiste.
- `apps/server/src/mcp/tools/get-role-prompt.ts` — acepta `flow_id` opcional y mergea skills por escenario.
- `apps/server/src/mcp/tools/get-flow-state.ts` — expone nuevos campos.
- `packages/core/src/flow.ts` (zod) — extiende `Flow` con los nuevos campos.

### Codebase context

Repo existente (`sdlc-mcp`), monorepo pnpm + turbo. Las convenciones a respetar:

- TypeScript estricto en todos los packages.
- Drizzle ORM para Postgres + `InMemoryFlowStore` paralelo (todo nuevo campo debe aparecer en ambas implementaciones).
- Tools del MCP: una tool por archivo en `apps/server/src/mcp/tools/`, registradas desde `tools/index.ts`.
- Validación: validators puros en `apps/server/src/validation/` que reciben markdown y devuelven `{ ok, issues[] }`.
- Tests con vitest. Los tests de integración Postgres se skippean si no hay `TEST_DATABASE_URL` (no romper CI sin DB).

### Integration points

- **`submit_rfc` ↔ FlowStore**: el frontmatter parseado se persiste como columnas tipadas. El parser tolera RFCs legacy sin frontmatter (deja los campos en `NULL` y reporta el issue en `validate_rfc`).
- **`get_role_prompt` ↔ FlowStore**: cuando se llama con `flow_id`, se hace un read del flow para resolver scenario skills. Sin `flow_id`, el server entrega base skills igual que hoy (modo exploración).
- **Migración Postgres**: nueva migration `0001_architecture_context.sql` con `ALTER TABLE flows ADD COLUMN architecture_mode TEXT NULL, ADD COLUMN codebase_status TEXT NULL, ADD COLUMN existing_repo TEXT NULL`. El runner actual de `pnpm db:migrate` la toma sin cambios.

## Design

### Cambios en el RFC

**Frontmatter YAML obligatorio** al inicio del markdown del RFC:

```yaml
---
architecture_mode: new | reuse | hybrid
codebase_status: greenfield | existing
existing_repo: <url o path>   # requerido si codebase_status=existing
---
```

**Nueva sección `## Architecture context`** entre `## Context` y `## Goals` del template, con 4 sub-secciones:

- `### Architecture mode` — 1-2 párrafos justificando la elección.
- `### Existing components reused` — bullets. Si `architecture_mode=new`, declarar explícitamente "ninguno" (no se acepta vacío).
- `### Codebase context` — descripción del repo target. Si `greenfield`, declarar nombre propuesto. Si `existing`, listar módulos/paths y convenciones relevantes.
- `### Integration points` — obligatorio si `architecture_mode ∈ {reuse, hybrid}`; permitido vacío si `new`.

**`required_sections`** del `rfc-draft.md` pasa a incluir `architecture_context` (se valida la sección H2 padre; las sub-secciones tienen reglas propias en el validador).

### Validación (`validate_rfc`)

Reglas nuevas, sumadas a las actuales:

1. Frontmatter YAML presente y parseable.
2. `architecture_mode` ∈ `{new, reuse, hybrid}`.
3. `codebase_status` ∈ `{greenfield, existing}`.
4. Si `codebase_status=existing` ⇒ `existing_repo` no vacío.
5. Sección `## Architecture context` presente con las 4 sub-secciones H3 esperadas.
6. Cada sub-sección H3 con contenido no-placeholder (mismo criterio que el validador actual usa para `[TBD]` vs placeholders sin rellenar).
7. Si `architecture_mode ∈ {reuse, hybrid}` ⇒ `### Integration points` no vacío.

Cada regla produce un issue específico (`code`, `path`, `message`) consistente con el formato actual del validador.

### Flow state — nuevos campos

Schema Drizzle (`apps/server/src/state/schema.ts`):

```ts
export const flows = pgTable("flows", {
  // ... campos existentes
  architectureMode: text("architecture_mode"),  // nullable
  codebaseStatus: text("codebase_status"),      // nullable
  existingRepo: text("existing_repo"),          // nullable
});
```

Mismo cambio en `InMemoryFlowStore` (en `Flow` type).

Se pueblan en `submit_rfc` al parsear el frontmatter. Si el RFC es legacy o el parseo falla, quedan en `NULL` y `validate_rfc` reporta el issue.

### Resolución de skills por escenario en `get_role_prompt`

Firma actual: `get_role_prompt({ role, phase })`. Nueva firma: `get_role_prompt({ role, phase, flow_id? })`.

Algoritmo:

1. Resolver `role_prompt`, `skills` base, `templates` desde `catalog.yaml` (igual que hoy).
2. Si `flow_id` viene en el call:
   - Read del flow → `architecture_mode`, `codebase_status`.
   - Lookup en `scenario_skills[<role>.<phase>]`.
   - Por cada eje (`architecture_mode`, `codebase_status`), si hay match y la lista no está vacía, unir al set de skills (sin duplicados).
3. Devolver bundle final.

Si `flow_id` no viene, o el flow no tiene clasificación aún (`NULL`), el bundle es exactamente el de hoy.

### `catalog.yaml` — sección `scenario_skills`

Nueva sección top-level (después de `templates:`):

```yaml
scenario_skills:
  developer.implement:
    architecture_mode:
      new: [skill-greenfield-implementation]
      reuse: [skill-reuse-implementation]
      hybrid: [skill-greenfield-implementation, skill-reuse-implementation]
    codebase_status:
      existing: [skill-existing-codebase-conventions]
      greenfield: []
  qa.qa:
    architecture_mode:
      new: []
      reuse: [skill-reuse-regression-checks]
      hybrid: [skill-reuse-regression-checks]
  reviewer.review:
    architecture_mode:
      new: []
      reuse: [skill-reuse-review-checklist]
      hybrid: [skill-reuse-review-checklist]
    codebase_status:
      existing: [skill-codebase-consistency-review]
      greenfield: []
```

Listas vacías son válidas y explicitan "no agregar nada extra para este valor". Claves omitidas también; un fase sin entrada en `scenario_skills` recibe solo base.

`catalog_version: 0.3.0` (minor — feature aditiva, no breaking para flows existentes sin clasificación).

### Skills nuevas (6 archivos en `packages/catalog/skills/`)

Cada una con frontmatter:

```yaml
---
id: skill-<name>
version: 0.1.0
---
```

Contenido (resumen — el body completo se redacta durante la implementación):

- **`skill-greenfield-implementation.md`** — bootstrap: estructura inicial, tooling, CI mínimo, ADR-0001 con stack inicial, primer commit con README + license + linter.
- **`skill-reuse-implementation.md`** — antes de codear, mapear los componentes referenciados en el RFC. Reusar módulos/utilities en vez de duplicar. Si tentación de fork interno, justificar en PR. Respetar contratos públicos del componente.
- **`skill-existing-codebase-conventions.md`** — leer `CONTRIBUTING.md`, `.editorconfig`, convenciones de naming, patrón de tests, layering de imports. Detectar "estilo de la casa". No introducir libs nuevas sin justificarlo contra las presentes.
- **`skill-reuse-regression-checks.md`** — cobertura mínima incluye tests de regresión sobre componentes reusados (no solo el camino nuevo). Validar contratos de integración. Si hay SLA preexistente del componente, no degradarlo.
- **`skill-reuse-review-checklist.md`** — verificar que el reuso es real: no duplicación de utilities existentes, no wrappers innecesarios, no ruptura de contratos. Cross-check contra `### Integration points` del RFC.
- **`skill-codebase-consistency-review.md`** — el diff respeta convenciones del repo. Flag de "stack drift": una lib o patrón nuevo introducido sin discusión.

Las 6 skills se registran en el bloque `skills:` de `catalog.yaml` con `version: 0.1.0`.

### `get_flow_state`

Devuelve los 3 campos nuevos en el response (`architecture_mode`, `codebase_status`, `existing_repo`). Roles downstream pueden decidir sin re-parsear el RFC.

### Actualizaciones de prompts de fase (referencia, no cambio de comportamiento)

- `roles/tech-lead/phases/rfc-draft.md` — sumar paso "completar `## Architecture context` y frontmatter".
- `roles/developer/phases/implement.md` — mencionar que `claim_story` devolverá skills adicionales según `architecture_mode`/`codebase_status` del flow.
- `roles/qa/phases/qa.md` y `roles/reviewer/phases/review.md` — análogo.

## Alternatives considered

1. **Nueva fase `discovery` antes del RFC** — descartada: agrega una fase formal que duplica responsabilidades del Tech Lead. El usuario eligió mantener una sola fase.
2. **Parámetros en `start_flow`** — descartada: la clasificación es decisión técnica del Tech Lead, no del PM al arrancar.
3. **Tool dedicada `analyze_codebase`** — descartada: el MCP no toca repos. El agente client-side ya hace esa exploración.
4. **Catálogo de componentes de infraestructura por tenant** — descartada para MVP; el RFC es texto libre por ahora. Es trabajo futuro.
5. **Prompts condicionales en lugar de skills extra** — descartada: skills extra dan más control y testabilidad (cada checklist se valida en aislado), aunque a costo de más archivos.

## Risks

| Riesgo | Tipo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|---|
| RFCs legacy (sin frontmatter) bloquean flows en `validate_rfc` | data | M | M | El parser tolera ausencia de frontmatter y reporta issue claro; los flows preexistentes con `current_phase` posterior a RFC no se revalidan automáticamente. |
| `get_role_prompt` con `flow_id` agrega latencia por read extra al store | perf | L | L | El read es por PK indexado. En `InMemoryFlowStore` es O(1). Se monitorea con OTEL cuando llegue (Fase 5). |
| Skills extra crecen sin control y un developer recibe 6+ skills | maintainability | M | M | Caps suaves: listas en `scenario_skills` deben revisarse en PR del catálogo. Cada skill tiene <500 palabras (regla informal del COE). |

## Rollout

- Fase 1 (dev): merge a `main`, bump `catalog_version` a `0.3.0`. Smoke test con `examples/01-prd-rfc/` agregando el nuevo frontmatter al fixture.
- Fase 2 (interno): pedir a 1-2 tenants beta que prueben el nuevo template con un RFC real, recoger feedback de nombres de secciones / skills.
- Fase 3 (general): doc en `docs/PROMPT_AUTHORING.md` sobre cómo extender `scenario_skills`.

## Rollback

Si los cambios rompen flows existentes:

1. Revertir el commit del bump de catálogo (`catalog_version: 0.2.0`).
2. En el server, las nuevas columnas Postgres son nullables — no requieren migration de rollback inmediato. Quedan inertes si la lógica no las lee.
3. Si hay datos persistidos en `architecture_mode`/`codebase_status` que se quieren limpiar: `UPDATE flows SET architecture_mode=NULL, codebase_status=NULL, existing_repo=NULL;`.
4. `get_role_prompt` vuelve a ignorar `flow_id` (devuelve base) — backwards compatible.

## Observability

- **Métricas:** `mcp_get_role_prompt_with_flow_total{role,phase,architecture_mode,codebase_status}` para entender adopción.
- **Logs:** `submit_rfc` loguea `{flow_id, architecture_mode, codebase_status, frontmatter_parse_status}`.
- **Alertas:** ninguna nueva.

## Open Questions

- ¿Qué pasa si el Tech Lead corrige el frontmatter en un `submit_rfc` posterior (re-submit)? Propuesto: el último submit gana, sobreescribe los 3 campos en `flows`. A confirmar durante la implementación.
- ¿Conviene exponer `scenario_skills` como tool independiente (`list_scenario_skills`) para debugging? Probablemente no para MVP; el bundle resuelto es observable desde `get_role_prompt`.
