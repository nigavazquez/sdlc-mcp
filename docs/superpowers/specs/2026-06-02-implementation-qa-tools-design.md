---
title: Fase 3 (slice 1) — Implementation & QA tools
date: 2026-06-02
status: approved
authors: [vazquez.n.g@gmail.com]
phase: implementation+qa
---

# Fase 3 slice 1 — Implementation & QA tools

## Contexto

Las fases anteriores (Fase 1: PRD + RFC, Fase 2: shaping con `InMemoryTaskSystemAdapter` shape Azure DevOps) dejan el flow en `backlog_ready` con un epic y N stories creadas en el sistema de tasks. Los system prompts del **developer** (`roles/developer/phases/implement.md`) y del **QA** (`roles/qa/phases/qa.md`) ya están escritos y referencian tools que aún no existen: `claim_story`, `report_progress`, `get_implementation_context`, `generate_qa_plan`, `submit_qa_results`, `block_story`.

Este slice construye esas 6 tools, el modelo de datos por-story que necesitan, y ajusta los prompts para reflejar las firmas finales. **Reviewer queda fuera** — se cubre en slice 2.

## Objetivo

Cerrar el loop `developer ↔ QA` end-to-end sobre el InMemoryAdapter:

- Un developer puede claimear una story creada, reportar progreso, abrir PR.
- Un QA puede pedir contexto, generar un plan, ejecutarlo y emitir veredicto.
- Una story bloqueada vuelve al developer; el ciclo puede repetirse.
- Cada transición de estado se refleja en Azure DevOps via `taskSystem.transition()`.

## Out of scope (deferred)

- Reviewer tools (`request_code_review`, `submit_review_outcome`) → slice 2.
- Avance del `flow.status` global a `qa_passed`/`merged` → slice 2 (más natural una vez que existe Reviewer).
- Real Azure DevOps adapter (REST + PAT) → Fase 2 slice 3.
- Vault de credenciales por tenant → Fase 2 slice 2.
- Validación de que `pr_url` exista realmente en GitHub/ADO Repos → futuro.
- Cleanup de stories cuando un flow se abortea.

## Arquitectura

Capas (siguiendo Fase 2):

- **`@sdlc/core`** — nuevos tipos: `StoryStatus`, `Story`, `StoryQaCase`, `StoryQaPlan`, `StoryQaResult`. Nuevo evento de flow ya está enumerado (`story.claimed`, `progress.reported`, `qa.plan.generated`, `qa.results.submitted`, `story.blocked`).
- **`apps/server/src/state/`** — `FlowStore` se extiende con `createStory`, `getStory`, `listStoriesByFlow`, `updateStory`. InMemoryFlowStore (Map por `story_id`) y PostgresFlowStore (tabla `stories`) implementan.
- **`apps/server/src/stories/`** — lógica pura:
  - `transitions.ts` — FSM `canTransition(from, to): boolean` + tabla de transiciones.
  - `qa-plan.ts` — `generatePlan(acceptance_criteria): StoryQaPlan` determinista.
- **`apps/server/src/mcp/tools/`** — 6 archivos (una tool cada uno).
- **`packages/catalog/`** — bumps a `developer/phases/implement.md` y `qa/phases/qa.md`.

## Modelo de datos

### Tipos (`packages/core/src/story.ts`)

```ts
export const StoryStatus = z.enum([
  'created',         // creada por create_stories, sin claim
  'claimed',         // un developer la tomó
  'in_progress',     // developer reportó progreso
  'in_review',       // PR abierto, listo para QA
  'qa_passed',       // QA verdict passed
  'blocked',         // QA verdict blocked
  'merged',          // PR mergeado (futuro slice)
]);

export const StoryQaCase = z.object({
  case_id: z.string(),                       // ej: 'AC-1', 'EDGE-1'
  description: z.string(),
  ac_ref: z.string().optional(),
  type: z.enum(['ac', 'edge', 'perf']),
});

export const StoryQaPlan = z.object({
  cases: z.array(StoryQaCase).min(1),
  generated_at: z.string(),
});

export const StoryQaResult = z.object({
  case_id: z.string(),
  status: z.enum(['passed', 'failed']),
  evidence_url: z.string().optional(),
  notes: z.string().optional(),
});

export const Story = z.object({
  story_id: z.string(),                       // UUID interno (PK)
  flow_id: z.string(),
  external_id: z.string(),                    // ej: 'ADO-42'
  external_url: z.string(),
  title: z.string(),
  acceptance_criteria: z.array(z.string()),
  status: StoryStatus,
  assignee: z.string().optional(),
  pr_url: z.string().optional(),
  qa_plan: StoryQaPlan.optional(),
  qa_verdict: z.enum(['passed', 'blocked']).optional(),
  qa_block_reason: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
```

### Cambio a Fase 2

`create_stories` actualmente solo crea el work item externo y emite `stories.created`. Ahora también inserta una fila en `stories` con `status='created'` por cada story creada. Stories de flows previos al deploy no van a tener fila — no claimeables; documentado en CHANGELOG.

### Postgres migration

`apps/server/drizzle/0003_stories.sql`:

```sql
CREATE TABLE stories (
  story_id UUID PRIMARY KEY,
  flow_id UUID NOT NULL REFERENCES flows(flow_id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  external_url TEXT NOT NULL,
  title TEXT NOT NULL,
  acceptance_criteria JSONB NOT NULL,
  status TEXT NOT NULL,
  assignee TEXT,
  pr_url TEXT,
  qa_plan JSONB,
  qa_verdict TEXT,
  qa_block_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (flow_id, external_id)
);

CREATE INDEX stories_flow_status_idx ON stories (flow_id, status);
```

## FSM (`apps/server/src/stories/transitions.ts`)

Transiciones válidas:

```
created      → claimed         (claim_story)
claimed      → in_progress     (report_progress status=in_progress)
claimed      → in_review       (report_progress status=in_review)
in_progress  → in_review       (report_progress status=in_review)
in_review    → qa_passed       (submit_qa_results verdict=passed)
in_review    → blocked         (submit_qa_results verdict=blocked OR block_story)
blocked      → in_progress     (report_progress status=in_progress)
blocked      → in_review       (report_progress status=in_review)
```

Cualquier otra transición → `{ ok:false, error:'invalid transition X→Y' }`.

## Las 6 tools

Todas viven en `apps/server/src/mcp/tools/`, reciben `TenantCtx`, validan tenant, retornan `{ ok, data?, error?, next_actions? }`.

### `claim_story`

```
input:  { story_id: string, developer_id: string }
guards:
  - story existe, tenant match
  - status === 'created' (idempotente si ya claimed por mismo developer_id)
  - error si claimed por otro
effects:
  - taskSystem.transition(external_id, 'Active')
  - updateStory({ status:'claimed', assignee: developer_id })
  - appendEvent('story.claimed', { story_id, external_id, developer_id })
returns: { story, rfc_ref, epic_external_id, architecture_mode, codebase_status, skills }
```

`skills` es scenario-resolved usando `flow.architecture_mode` y `flow.codebase_status` (mismo helper que ya consume `get_role_prompt`).

### `report_progress`

```
input:  { story_id, status: 'in_progress' | 'in_review', pr_url?, notes? }
guards:
  - story existe, tenant match
  - story.assignee === ctx.userId
  - transición válida por FSM
  - si status='in_review', pr_url requerido
effects:
  - taskSystem.transition(external_id, status==='in_review' ? 'Resolved' : 'Active')
  - updateStory({ status, pr_url? })
  - appendEvent('progress.reported', { story_id, status, pr_url })
```

### `get_implementation_context`

```
input:  { story_id, rfc_markdown? }
guards:
  - story existe, tenant match
  - story.status !== 'created' (debe haber sido claimed al menos)
effects: ninguno (lectura)
returns:
  - story
  - rfc_ref, architecture_mode, codebase_status (del flow)
  - pr_url (de la story)
  - rfc_excerpt: si rfc_markdown viene, extractSections devuelve '## Design' + '## Risks'; si no, null
  - skills: scenario-resolved para 'qa.qa'
```

### `generate_qa_plan`

```
input:  { story_id }
guards:
  - story existe, tenant match
  - status ∈ { in_review, qa_passed, blocked }
effects:
  - updateStory({ qa_plan })   (reemplaza si existía)
  - appendEvent('qa.plan.generated', { story_id, case_count })
returns: { qa_plan }
```

Lógica pura en `stories/qa-plan.ts`:

```ts
function generatePlan(ac: string[]): StoryQaPlan {
  const cases: StoryQaCase[] = [];
  ac.forEach((text, i) => cases.push({
    case_id: `AC-${i + 1}`,
    description: text,
    ac_ref: `AC-${i + 1}`,
    type: 'ac',
  }));
  cases.push({ case_id: 'EDGE-1', description: 'Boundary / empty / max input', type: 'edge' });
  cases.push({ case_id: 'EDGE-2', description: 'Concurrent or duplicate request', type: 'edge' });
  return { cases, generated_at: new Date().toISOString() };
}
```

### `submit_qa_results`

```
input:  {
  story_id,
  results: Array<{ case_id, status:'passed'|'failed', evidence_url?, notes? }>,
  verdict: 'passed' | 'blocked',
  block_reason?,
}
guards:
  - story existe, tenant match
  - status === 'in_review'
  - story.qa_plan existe (forzar generate_qa_plan antes)
  - cada result.case_id debe coincidir con un case del plan
  - cobertura completa: cada case del plan tiene exactamente un result (sin duplicados, sin omitidos)
  - if verdict='passed': todos los results.status='passed'
  - if verdict='blocked': block_reason no vacío AND ≥1 result.status='failed' con evidence_url
effects:
  - taskSystem.transition(external_id, verdict==='passed' ? 'Closed' : 'Active')
  - updateStory({ status: verdict==='passed' ? 'qa_passed' : 'blocked', qa_verdict, qa_block_reason? })
  - appendEvent('qa.results.submitted', { story_id, verdict, case_count })
```

No avanza `flow.status` global — slice 2.

### `block_story`

```
input:  { story_id, reason: string }
guards:
  - story existe, tenant match
  - status === 'in_review'
  - reason no vacío
effects:
  - taskSystem.transition(external_id, 'Active')
  - updateStory({ status:'blocked', qa_verdict:'blocked', qa_block_reason: reason })
  - appendEvent('story.blocked', { story_id, reason })
```

## Catalog (prompts)

### `roles/developer/phases/implement.md` → 0.2.0

- Paso 1: clarificar return de `claim_story` (`{ story, rfc_ref, epic_external_id, architecture_mode, codebase_status, skills }`).
- Paso 6: `report_progress` admite `status: 'in_progress' | 'in_review'`; `pr_url` requerido para `in_review`.
- Agregar Paso 0 opcional: `get_flow_state({flow_id})` para ver stories vecinas.

### `roles/qa/phases/qa.md` → 0.2.0

- Paso 1: firma final `get_implementation_context({story_id, rfc_markdown?})`. Si el agent tiene el RFC en repo, pasarlo para recibir excerpt.
- Paso 4: clarificar formato de `results[]` y que `case_id` debe match con el plan.
- Paso 5/6: diferencia entre `submit_qa_results({verdict:'blocked'})` (con plan + evidence) y `block_story({reason})` (atajo sin plan completo).

### `catalog.yaml`

- `developer.phases.implement.version`: 0.1.0 → 0.2.0
- `qa.phases.qa.version`: 0.1.0 → 0.2.0
- `catalog_version`: 0.3.0 → 0.4.0

Sin skills nuevas.

## Tests (vitest)

### Pure

- `test/stories/transitions.test.ts` — tabla de transiciones válidas + inválidas.
- `test/stories/qa-plan.test.ts` — N AC → N+2 cases; orden determinista; EDGE-1/EDGE-2 siempre presentes.
- `test/in-memory-store-stories.test.ts` — CRUD InMemory.

### Tool-level — `test/implementation-qa.test.ts`

1. **Happy path completo** — backlog_ready + 2 stories → claim → report(in_progress) → report(in_review,pr) → generate_qa_plan → submit_qa_results(passed). Verifica eventos, transitions del adapter (espía sobre `taskSystem.transition`), final state.
2. **Block + retry** — claim → report(in_review) → generate_qa_plan → submit_qa_results(blocked, evidence) → report(in_progress) → report(in_review) → submit_qa_results(passed). qa_block_reason persiste hasta el siguiente verdict.
3. **Block atajo** — claim → report(in_review) → block_story(reason). Sin plan.
4. **Guard rails**:
   - claim story ya claimed por otro dev → error.
   - report_progress por user ≠ assignee → error.
   - report_progress sin pr_url cuando status=in_review → error.
   - submit_qa_results sin plan previo → error.
   - submit_qa_results verdict=passed con case failed → error.
   - submit_qa_results verdict=blocked sin block_reason → error.
   - submit_qa_results con case_id desconocido → error.
   - submit_qa_results con cobertura incompleta (falta un case del plan) → error.
   - submit_qa_results con case_id duplicado → error.
   - generate_qa_plan en status=created → error.
   - transición FSM inválida (ej: created → in_review directo) → error.
5. **Idempotencia / determinismo**:
   - claim_story doble por mismo developer → no-op, sin doble evento.
   - generate_qa_plan dos veces → reemplaza plan; emite evento cada vez.

## Wiring

- `apps/server/src/mcp/tools/index.ts` — registrar las 6 tools en `buildToolRegistry`.
- `apps/server/src/state/in-memory.ts` y `postgres.ts` — implementar nuevos métodos del store.
- `apps/server/src/mcp/tools/create-stories.ts` — extender para que también persista cada story en la tabla (status='created').

## Open questions (resueltas)

| Pregunta | Decisión |
|---|---|
| Estado por story | Tabla `stories` con FSM explícito |
| Side-effects Azure DevOps | `taskSystem.transition()` en cada tool de transición |
| RFC excerpt en QA | Caller pasa `rfc_markdown?` opcional |
| Block lifecycle | blocked → in_progress (loop dev↔QA) |
| QA plan storage | `stories.qa_plan` (jsonb) |
| Slice scope | 6 tools en un PR |

## Roadmap subsiguiente

1. **Fase 3 slice 2 — Reviewer**: `request_code_review`, `submit_review_outcome` + bump al reviewer prompt + ledger en eventos + avance del `flow.status` global a `qa_passed` → `merged`.
2. **Fase 2 slice 2** — Vault de credenciales por tenant.
3. **Fase 2 slice 3** — Real Azure DevOps adapter (REST + PAT).
4. **Smoke end-to-end** — PRD → RFC → shaping → claim → QA → review → merge en un tenant beta con Azure DevOps real.
