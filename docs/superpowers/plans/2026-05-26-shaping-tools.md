# Fase 2 Shaping Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar las 5 tools de shaping (`propose_breakdown`, `create_epic`, `create_stories`, `link_subtasks`, `sync_backlog`) conectadas a un `TaskSystemAdapter`, con un `InMemoryTaskSystemAdapter` fake testeable, dejando el modelo compatible con Azure DevOps.

**Architecture:** Factory polimórfico para el adapter (espejo de `FlowStore`). Una tool por archivo. Tipos zod en `@sdlc/core`. El agente arma el breakdown; las tools lo reciben estructurado y lo crean vía el adapter. Las refs se persisten en `flow_events`; `epic_external_id` en `flows`. `sync_backlog` avanza `status=backlog_ready`.

**Tech Stack:** TypeScript estricto (`exactOptionalPropertyTypes: true`), vitest, zod. Sin libs nuevas. Sin red ni migrations en este slice.

**Spec:** [docs/superpowers/specs/2026-05-26-shaping-tools-design.md](../specs/2026-05-26-shaping-tools-design.md)

---

## File Structure

**Crear:**
- `packages/core/src/shaping.ts` — tipos zod `EpicInput`, `SubtaskInput`, `StoryInput`, `Breakdown`, `ExternalRefZ`.
- `apps/server/src/adapters/in-memory-task-system.ts` — `InMemoryTaskSystemAdapter`.
- `apps/server/src/adapters/factory.ts` — `makeTaskSystemAdapter`.
- `apps/server/src/adapters/index.ts` — barrel.
- `apps/server/src/shaping/propose.ts` — heurística pura `proposeBreakdown`.
- `apps/server/src/validation/breakdown.ts` — `validateBreakdown`.
- `apps/server/src/mcp/tools/propose-breakdown.ts`
- `apps/server/src/mcp/tools/create-epic.ts`
- `apps/server/src/mcp/tools/create-stories.ts`
- `apps/server/src/mcp/tools/link-subtasks.ts`
- `apps/server/src/mcp/tools/sync-backlog.ts`
- `apps/server/test/in-memory-task-system.test.ts`
- `apps/server/test/propose-breakdown.test.ts`
- `apps/server/test/breakdown-validation.test.ts`
- `apps/server/test/shaping.test.ts`

**Modificar:**
- `packages/adapters-contracts/src/tasksys.ts` — agregar `'azure-devops'` a `TaskSystemKind`.
- `packages/core/src/index.ts` — exportar `./shaping.js`.
- `apps/server/src/validation/markdown-sections.ts` — exportar `extractSections`.
- `apps/server/src/mcp/tools/index.ts` — `BuildRegistryDeps.taskSystem` + registrar 5 tools.
- `apps/server/src/index.ts` — crear adapter vía factory e inyectar.
- `apps/server/src/mcp-stdio.ts` — idem.
- `packages/catalog/roles/pmo/phases/shaping.md` — aclarar `propose_breakdown` recibe `rfc_markdown`.
- `packages/catalog/catalog.yaml` — bump phase `shaping` a `0.2.0`.

---

## Task 1: Agregar `'azure-devops'` a `TaskSystemKind`

**Files:**
- Modify: `packages/adapters-contracts/src/tasksys.ts:3`

- [ ] **Step 1: Editar el enum**

En `packages/adapters-contracts/src/tasksys.ts`, reemplazar la línea:

```ts
export type TaskSystemKind = 'jira' | 'linear' | 'github';
```

por:

```ts
export type TaskSystemKind = 'jira' | 'linear' | 'github' | 'azure-devops';
```

- [ ] **Step 2: Build**

Run:
```bash
pnpm --filter @sdlc/adapters-contracts build
```
Expected: pasa sin errores.

- [ ] **Step 3: Commit**

```bash
git add packages/adapters-contracts/src/tasksys.ts
git commit -m "feat(adapters): add azure-devops to TaskSystemKind"
```

---

## Task 2: Tipos zod del breakdown en core

**Files:**
- Create: `packages/core/src/shaping.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Crear `packages/core/src/shaping.ts`**

```ts
import { z } from 'zod';

export const EpicInput = z.object({
  title: z.string().min(1),
  description: z.string(),
  labels: z.array(z.string()).optional(),
});
export type EpicInput = z.infer<typeof EpicInput>;

export const SubtaskInput = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
});
export type SubtaskInput = z.infer<typeof SubtaskInput>;

export const StoryInput = z.object({
  title: z.string().min(1),
  description: z.string(),
  acceptance_criteria: z.array(z.string()),
  labels: z.array(z.string()).optional(),
  estimate: z.number().optional(),
  subtasks: z.array(SubtaskInput).optional(),
});
export type StoryInput = z.infer<typeof StoryInput>;

export const Breakdown = z.object({
  epic: EpicInput,
  stories: z.array(StoryInput).min(1),
});
export type Breakdown = z.infer<typeof Breakdown>;

export const ExternalRefZ = z.object({
  external_id: z.string(),
  url: z.string(),
});
export type ExternalRefZ = z.infer<typeof ExternalRefZ>;
```

- [ ] **Step 2: Exportar desde el index**

En `packages/core/src/index.ts`, agregar al final:

```ts
export * from './shaping.js';
```

El archivo debe quedar:

```ts
export * from './roles.js';
export * from './flow.js';
export * from './artifacts.js';
export * from './shaping.js';
```

- [ ] **Step 3: Build + typecheck**

Run:
```bash
pnpm --filter @sdlc/core build && pnpm --filter @sdlc/core typecheck
```
Expected: pasa.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/shaping.ts packages/core/src/index.ts
git commit -m "feat(core): zod types for shaping breakdown"
```

---

## Task 3: `InMemoryTaskSystemAdapter` + tests

**Files:**
- Create: `apps/server/src/adapters/in-memory-task-system.ts`
- Create: `apps/server/test/in-memory-task-system.test.ts`

- [ ] **Step 1: Escribir el test fallido**

Crear `apps/server/test/in-memory-task-system.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';

const CTX: TenantCtx = {
  tenantId: 't1',
  userId: 'u1',
  roles: ['pmo'],
  async resolveSecret() {
    throw new Error('not used');
  },
};

describe('InMemoryTaskSystemAdapter', () => {
  it('reports kind azure-devops', () => {
    const a = new InMemoryTaskSystemAdapter();
    expect(a.kind).toBe('azure-devops');
  });

  it('creates an epic with a deterministic ref', async () => {
    const a = new InMemoryTaskSystemAdapter();
    const ref = await a.createEpic(
      { project_key: 'checkout', title: 'Cuotas', description: 'desc' },
      CTX,
    );
    expect(ref.external_id).toBe('ADO-1');
    expect(ref.url).toContain('checkout');
    expect(ref.url).toContain('/1');
  });

  it('creates stories/subtasks with incrementing ids and links them', async () => {
    const a = new InMemoryTaskSystemAdapter();
    const epic = await a.createEpic({ project_key: 'p', title: 'E', description: '' }, CTX);
    const story = await a.createStory(
      { project_key: 'p', epic_id: epic.external_id, title: 'S', description: '', acceptance_criteria: ['ac'] },
      CTX,
    );
    expect(story.external_id).toBe('ADO-2');
    const sub = await a.createSubtask(
      { project_key: 'p', parent_story_id: story.external_id, title: 'Sub' },
      CTX,
    );
    expect(sub.external_id).toBe('ADO-3');

    await a.linkChildToParent(story.external_id, sub.external_id, CTX);
    const fetched = await a.getItem(sub.external_id, CTX);
    expect(fetched.parent_id).toBe(story.external_id);
    expect(fetched.type).toBe('subtask');
  });

  it('transition changes status; getItem throws on unknown', async () => {
    const a = new InMemoryTaskSystemAdapter();
    const epic = await a.createEpic({ project_key: 'p', title: 'E', description: '' }, CTX);
    await a.transition(epic.external_id, 'Active', CTX);
    const fetched = await a.getItem(epic.external_id, CTX);
    expect(fetched.status).toBe('Active');
    await expect(a.getItem('ADO-999', CTX)).rejects.toThrow(/unknown/i);
  });

  it('search filters by type and parent', async () => {
    const a = new InMemoryTaskSystemAdapter();
    const epic = await a.createEpic({ project_key: 'p', title: 'E', description: '' }, CTX);
    await a.createStory(
      { project_key: 'p', epic_id: epic.external_id, title: 'S1', description: '', acceptance_criteria: [] },
      CTX,
    );
    const stories = await a.search({ parent_id: epic.external_id }, CTX);
    expect(stories.length).toBe(1);
    expect(stories[0]?.type).toBe('story');
  });
});
```

- [ ] **Step 2: Correr el test (esperado: FAIL)**

Run:
```bash
pnpm --filter @sdlc/server test -- in-memory-task-system
```
Expected: FAIL (módulo no existe).

- [ ] **Step 3: Implementar el adapter**

Crear `apps/server/src/adapters/in-memory-task-system.ts`:

```ts
import type {
  EpicInput,
  ExternalRef,
  StoryInput,
  SubtaskInput,
  TaskItem,
  TaskQuery,
  TaskSystemAdapter,
  TaskSystemKind,
  TenantCtx,
} from '@sdlc/adapters-contracts';

const ORG = 'sdlc-demo';

/**
 * Fake task system for tests/dev. No network. Generates deterministic refs
 * (ADO-1, ADO-2, …) and mirrors the Azure DevOps work item model
 * (Epic → User Story → Task) so the real adapter can slot in later.
 */
export class InMemoryTaskSystemAdapter implements TaskSystemAdapter {
  readonly kind: TaskSystemKind = 'azure-devops';
  private readonly items = new Map<string, TaskItem>();
  private counter = 0;

  private nextRef(projectKey: string): ExternalRef {
    this.counter += 1;
    const external_id = `ADO-${this.counter}`;
    const url = `https://dev.azure.com/${ORG}/${projectKey}/_workitems/edit/${this.counter}`;
    return { external_id, url };
  }

  async createEpic(input: EpicInput, _ctx: TenantCtx): Promise<ExternalRef> {
    const ref = this.nextRef(input.project_key);
    this.items.set(ref.external_id, {
      external_id: ref.external_id,
      url: ref.url,
      title: input.title,
      description: input.description,
      status: 'New',
      type: 'epic',
      labels: input.labels ?? [],
    });
    return ref;
  }

  async createStory(input: StoryInput, _ctx: TenantCtx): Promise<ExternalRef> {
    const ref = this.nextRef(input.project_key);
    this.items.set(ref.external_id, {
      external_id: ref.external_id,
      url: ref.url,
      title: input.title,
      description: input.description,
      status: 'New',
      type: 'story',
      parent_id: input.epic_id,
      labels: input.labels ?? [],
    });
    return ref;
  }

  async createSubtask(input: SubtaskInput, _ctx: TenantCtx): Promise<ExternalRef> {
    const ref = this.nextRef(input.project_key);
    this.items.set(ref.external_id, {
      external_id: ref.external_id,
      url: ref.url,
      title: input.title,
      description: input.description ?? '',
      status: 'New',
      type: 'subtask',
      parent_id: input.parent_story_id,
      labels: [],
    });
    return ref;
  }

  async linkChildToParent(parentId: string, childId: string, _ctx: TenantCtx): Promise<void> {
    const child = this.items.get(childId);
    if (!child) throw new Error(`Unknown work item: ${childId}`);
    child.parent_id = parentId;
  }

  async getItem(id: string, _ctx: TenantCtx): Promise<TaskItem> {
    const item = this.items.get(id);
    if (!item) throw new Error(`Unknown work item: ${id}`);
    return { ...item };
  }

  async transition(id: string, status: string, _ctx: TenantCtx): Promise<void> {
    const item = this.items.get(id);
    if (!item) throw new Error(`Unknown work item: ${id}`);
    item.status = status;
  }

  async search(query: TaskQuery, _ctx: TenantCtx): Promise<TaskItem[]> {
    let results = [...this.items.values()];
    if (query.parent_id !== undefined) {
      results = results.filter((i) => i.parent_id === query.parent_id);
    }
    if (query.status !== undefined) {
      results = results.filter((i) => i.status === query.status);
    }
    if (query.text !== undefined) {
      const t = query.text.toLowerCase();
      results = results.filter((i) => i.title.toLowerCase().includes(t));
    }
    if (query.limit !== undefined) results = results.slice(0, query.limit);
    return results.map((i) => ({ ...i }));
  }
}
```

NOTE: `EpicInput`/`StoryInput`/`SubtaskInput` aquí son los **TS interfaces de `@sdlc/adapters-contracts`** (que incluyen `project_key`, `epic_id`, etc.), NO los zod de core. Son tipos distintos con el mismo nombre; este archivo importa SOLO de `@sdlc/adapters-contracts`.

- [ ] **Step 4: Correr el test (esperado: PASS)**

Run:
```bash
pnpm --filter @sdlc/server test -- in-memory-task-system
```
Expected: 5/5 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/adapters/in-memory-task-system.ts apps/server/test/in-memory-task-system.test.ts
git commit -m "feat(server): InMemoryTaskSystemAdapter (azure-devops shaped fake)"
```

---

## Task 4: Factory del adapter + barrel

**Files:**
- Create: `apps/server/src/adapters/factory.ts`
- Create: `apps/server/src/adapters/index.ts`

- [ ] **Step 1: Crear `apps/server/src/adapters/factory.ts`**

```ts
import type { TaskSystemAdapter } from '@sdlc/adapters-contracts';
import { InMemoryTaskSystemAdapter } from './in-memory-task-system.js';

export interface MakeTaskSystemOptions {
  /** Reserved for future selection (e.g. 'azure-devops' real adapter). */
  kind?: string;
}

/**
 * Returns the task system adapter. In this slice it always returns the
 * in-memory fake. The real Azure DevOps adapter (REST + PAT via vault) will be
 * selected here by config/env in a later slice.
 */
export function makeTaskSystemAdapter(_opts: MakeTaskSystemOptions = {}): TaskSystemAdapter {
  return new InMemoryTaskSystemAdapter();
}
```

- [ ] **Step 2: Crear `apps/server/src/adapters/index.ts`**

```ts
export * from './in-memory-task-system.js';
export * from './factory.js';
```

- [ ] **Step 3: Typecheck**

Run:
```bash
pnpm --filter @sdlc/server typecheck
```
Expected: pasa.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/adapters/factory.ts apps/server/src/adapters/index.ts
git commit -m "feat(server): task system adapter factory + barrel"
```

---

## Task 5: Exportar `extractSections` + heurística `proposeBreakdown` + tests

**Files:**
- Modify: `apps/server/src/validation/markdown-sections.ts`
- Create: `apps/server/src/shaping/propose.ts`
- Create: `apps/server/test/propose-breakdown.test.ts`

- [ ] **Step 1: Exportar `extractSections` y su tipo**

En `apps/server/src/validation/markdown-sections.ts`, la función `extractSections` y la interface `ExtractedSection` son privadas. Agregar `export` a ambas:

Cambiar:
```ts
interface ExtractedSection {
```
por:
```ts
export interface ExtractedSection {
```

Y cambiar:
```ts
function extractSections(markdown: string): ExtractedSection[] {
```
por:
```ts
export function extractSections(markdown: string): ExtractedSection[] {
```

(No cambia comportamiento; solo expone el helper.)

- [ ] **Step 2: Escribir el test fallido**

Crear `apps/server/test/propose-breakdown.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { proposeBreakdown } from '../src/shaping/propose.js';

const RFC = `
# RFC: Pago en cuotas

## Context
ctx

## Goals
- Pagos en 3/6/12 cuotas.
- Idempotencia end-to-end.

## Design

### Data model
Tabla payments_plans.

### API / Contracts
POST /v1/checkout/plans.
`;

describe('proposeBreakdown', () => {
  it('builds an epic from the flow title and a story per Goal + Design subsection', () => {
    const b = proposeBreakdown(RFC, 'Pago en cuotas', '/docs/rfc/cuotas.md');
    expect(b.epic.title).toBe('Pago en cuotas');
    expect(b.epic.description).toContain('/docs/rfc/cuotas.md');
    // 2 goals + 2 design subsections = 4 stories
    expect(b.stories.length).toBe(4);
    const titles = b.stories.map((s) => s.title);
    expect(titles.some((t) => t.includes('Data model'))).toBe(true);
    expect(titles.some((t) => t.includes('API / Contracts'))).toBe(true);
  });

  it('is deterministic: same input → same output', () => {
    const a = proposeBreakdown(RFC, 'X', 'ref');
    const b = proposeBreakdown(RFC, 'X', 'ref');
    expect(a).toEqual(b);
  });

  it('always produces at least one story even with a minimal RFC', () => {
    const b = proposeBreakdown('# RFC\n\n## Context\nonly context', 'Title', 'ref');
    expect(b.stories.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 3: Correr el test (esperado: FAIL)**

Run:
```bash
pnpm --filter @sdlc/server test -- propose-breakdown
```
Expected: FAIL (módulo no existe).

- [ ] **Step 4: Implementar la heurística**

Crear `apps/server/src/shaping/propose.ts`:

```ts
import type { Breakdown, StoryInput } from '@sdlc/core';
import { extractSections } from '../validation/markdown-sections.js';

/**
 * Deterministic, heuristic breakdown suggestion from an RFC body. NOT
 * authoritative — the PMO agent reviews and rewrites it. One story per Goal
 * bullet plus one per H3 sub-section under "Design". Falls back to a single
 * story if neither is present.
 */
export function proposeBreakdown(rfcMarkdown: string, flowTitle: string, rfcRef: string): Breakdown {
  const sections = extractSections(rfcMarkdown);
  const stories: StoryInput[] = [];

  const goals = sections.find((s) => /^goals$/i.test(s.heading.trim()));
  if (goals) {
    for (const line of goals.body.split('\n')) {
      const m = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
      if (m && m[1]) {
        stories.push({
          title: truncate(m[1]),
          description: m[1],
          acceptance_criteria: [],
        });
      }
    }
  }

  // H3 sub-sections that look like design areas (Data model, API / Contracts, …).
  // extractSections flattens all headings; we pick the ones that commonly live
  // under Design. Heuristic: known design-area headings.
  const designAreas = ['Data model', 'API / Contracts', 'Security', 'Performance'];
  for (const s of sections) {
    if (designAreas.some((area) => normalize(s.heading) === normalize(area))) {
      stories.push({
        title: `Implementar: ${s.heading.trim()}`,
        description: s.body.trim() || s.heading.trim(),
        acceptance_criteria: [],
      });
    }
  }

  if (stories.length === 0) {
    stories.push({
      title: flowTitle,
      description: `Historia inicial derivada del RFC: ${rfcRef}`,
      acceptance_criteria: [],
    });
  }

  return {
    epic: {
      title: flowTitle,
      description: `Derivado del RFC: ${rfcRef}`,
    },
    stories,
  };
}

function truncate(s: string, max = 80): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}
```

- [ ] **Step 5: Correr el test (esperado: PASS)**

Run:
```bash
pnpm --filter @sdlc/server test -- propose-breakdown
```
Expected: 3/3 PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/validation/markdown-sections.ts apps/server/src/shaping/propose.ts apps/server/test/propose-breakdown.test.ts
git commit -m "feat(server): deterministic proposeBreakdown heuristic"
```

---

## Task 6: Validador `validateBreakdown` + tests

**Files:**
- Create: `apps/server/src/validation/breakdown.ts`
- Create: `apps/server/test/breakdown-validation.test.ts`

- [ ] **Step 1: Escribir el test fallido**

Crear `apps/server/test/breakdown-validation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { validateBreakdown } from '../src/validation/breakdown.js';

const VALID = {
  epic: { title: 'E', description: 'd' },
  stories: [
    { title: 'S1', description: 'd', acceptance_criteria: ['ac1', 'ac2'] },
  ],
};

describe('validateBreakdown', () => {
  it('passes a well-formed breakdown', () => {
    expect(validateBreakdown(VALID).ok).toBe(true);
  });

  it('fails when epic title is empty', () => {
    const r = validateBreakdown({ ...VALID, epic: { title: '', description: 'd' } });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.section === 'epic')).toBe(true);
  });

  it('fails when there are no stories', () => {
    const r = validateBreakdown({ ...VALID, stories: [] });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.section === 'stories')).toBe(true);
  });

  it('fails when a story has no acceptance criteria', () => {
    const r = validateBreakdown({
      ...VALID,
      stories: [{ title: 'S', description: 'd', acceptance_criteria: [] }],
    });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.message.includes('acceptance'))).toBe(true);
  });

  it('warns when a story has more than 5 acceptance criteria', () => {
    const r = validateBreakdown({
      ...VALID,
      stories: [
        { title: 'S', description: 'd', acceptance_criteria: ['1', '2', '3', '4', '5', '6'] },
      ],
    });
    expect(r.ok).toBe(true); // warning, not error
    expect(r.issues.some((i) => i.severity === 'warning')).toBe(true);
  });
});
```

- [ ] **Step 2: Correr el test (esperado: FAIL)**

Run:
```bash
pnpm --filter @sdlc/server test -- breakdown-validation
```
Expected: FAIL (módulo no existe).

- [ ] **Step 3: Implementar el validador**

Crear `apps/server/src/validation/breakdown.ts`:

```ts
import type { Breakdown, ValidationIssue, ValidationResult } from '@sdlc/core';

export function validateBreakdown(b: Breakdown): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!b.epic || !b.epic.title.trim()) {
    issues.push({ severity: 'error', section: 'epic', message: 'Epic title must not be empty.' });
  }

  if (!b.stories || b.stories.length < 1) {
    issues.push({ severity: 'error', section: 'stories', message: 'Breakdown must have at least one story.' });
  }

  (b.stories ?? []).forEach((s, idx) => {
    const where = `stories[${idx}]`;
    if (!s.title.trim()) {
      issues.push({ severity: 'error', section: where, message: `Story ${idx} title must not be empty.` });
    }
    if (!s.acceptance_criteria || s.acceptance_criteria.length < 1) {
      issues.push({
        severity: 'error',
        section: where,
        message: `Story ${idx} ("${s.title}") must have at least one acceptance criterion.`,
      });
    } else if (s.acceptance_criteria.length > 5) {
      issues.push({
        severity: 'warning',
        section: where,
        message: `Story ${idx} ("${s.title}") has more than 5 acceptance criteria — consider splitting it.`,
      });
    }
  });

  return { ok: issues.every((i) => i.severity !== 'error'), issues };
}
```

- [ ] **Step 4: Correr el test (esperado: PASS)**

Run:
```bash
pnpm --filter @sdlc/server test -- breakdown-validation
```
Expected: 5/5 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/validation/breakdown.ts apps/server/test/breakdown-validation.test.ts
git commit -m "feat(server): validateBreakdown for shaping inputs"
```

---

## Task 7: Wiring del adapter en `BuildRegistryDeps` + bootstrap

**Files:**
- Modify: `apps/server/src/mcp/tools/index.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/mcp-stdio.ts`

Este task agrega `taskSystem` a las deps SIN registrar tools nuevas todavía (las tools se agregan una por una en los tasks siguientes). Mantiene todo compilando y los tests existentes verdes.

- [ ] **Step 1: Extender `BuildRegistryDeps`**

En `apps/server/src/mcp/tools/index.ts`, agregar el import y el campo. Cambiar:

```ts
import type { FlowStore } from '../../state/index.js';
```

agregando debajo:

```ts
import type { TaskSystemAdapter } from '@sdlc/adapters-contracts';
```

Y cambiar:

```ts
export interface BuildRegistryDeps {
  catalog: Catalog;
  store: FlowStore;
}
```

por:

```ts
export interface BuildRegistryDeps {
  catalog: Catalog;
  store: FlowStore;
  taskSystem: TaskSystemAdapter;
}
```

**NO** cambies la desestructuración `const { catalog, store } = deps;` todavía — `taskSystem` se empieza a usar en el Task 9, y bajo `noUnusedLocals` una var declarada sin usar rompe el typecheck. En este task solo se agrega a la interface y al bootstrap.

- [ ] **Step 2: Wire en `apps/server/src/index.ts`**

Agregar el import:

```ts
import { makeTaskSystemAdapter } from './adapters/index.js';
```

Y cambiar:

```ts
  const registry = buildToolRegistry({ catalog, store: storeHandle.store });
```

por:

```ts
  const taskSystem = makeTaskSystemAdapter();
  const registry = buildToolRegistry({ catalog, store: storeHandle.store, taskSystem });
```

- [ ] **Step 3: Wire en `apps/server/src/mcp-stdio.ts`**

Agregar el import:

```ts
import { makeTaskSystemAdapter } from './adapters/index.js';
```

Y cambiar:

```ts
  const registry = buildToolRegistry({ catalog, store: storeHandle.store });
```

por:

```ts
  const taskSystem = makeTaskSystemAdapter();
  const registry = buildToolRegistry({ catalog, store: storeHandle.store, taskSystem });
```

- [ ] **Step 4: Typecheck + tests existentes**

Run:
```bash
pnpm --filter @sdlc/server typecheck && pnpm --filter @sdlc/server test
```
Expected: typecheck pasa; todos los tests existentes siguen verdes. (Si typecheck falla por `taskSystem` declarado sin usar, remové `taskSystem` de la desestructuración del Step 1 y dejalo en `deps.taskSystem` para usar desde el Task 8.)

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/mcp/tools/index.ts apps/server/src/index.ts apps/server/src/mcp-stdio.ts
git commit -m "feat(server): inject TaskSystemAdapter into tool registry deps"
```

---

## Task 8: Tool `propose_breakdown`

**Files:**
- Create: `apps/server/src/mcp/tools/propose-breakdown.ts`
- Modify: `apps/server/src/mcp/tools/index.ts`

- [ ] **Step 1: Crear el tool**

Crear `apps/server/src/mcp/tools/propose-breakdown.ts`:

```ts
import { z } from 'zod';
import type { Catalog } from '@sdlc/catalog';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';
import { proposeBreakdown } from '../../shaping/propose.js';

export const ProposeBreakdownInput = z.object({
  flow_id: z.string().min(1),
  rfc_markdown: z.string().min(1),
});
export type ProposeBreakdownInput = z.infer<typeof ProposeBreakdownInput>;

export function makeProposeBreakdownTool(store: FlowStore, catalog: Catalog) {
  return {
    name: 'propose_breakdown',
    description:
      'Suggests an epic + stories breakdown from the RFC markdown (deterministic heuristic — NOT authoritative). Requires the flow to be in status=rfc_ready. Returns the suggested breakdown and the breakdown template. Does not create anything external.',
    inputSchema: ProposeBreakdownInput,
    handler: async (input: ProposeBreakdownInput, ctx: TenantCtx) => {
      const flow = await store.getFlow(input.flow_id);
      if (!flow) return { ok: false, error: `Unknown flow: ${input.flow_id}` };
      if (flow.tenant_id !== ctx.tenantId) {
        return { ok: false, error: 'Flow belongs to a different tenant' };
      }
      if (flow.status !== 'rfc_ready') {
        return {
          ok: false,
          error: `Cannot propose breakdown: flow status is "${flow.status}", expected "rfc_ready".`,
        };
      }

      const rfcRef = flow.rfc_ref?.repo_path ?? flow.rfc_ref?.url ?? flow.flow_id;
      const suggested = proposeBreakdown(input.rfc_markdown, flow.title, rfcRef);
      const template = await catalog.getTemplate('breakdown-template');

      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'breakdown.proposed',
        actor: ctx.userId,
        payload: { story_count: suggested.stories.length },
      });

      return {
        ok: true,
        data: { suggested_breakdown: suggested, template: template.content },
        next_actions: ['create_epic', 'create_stories'],
      };
    },
  };
}
```

- [ ] **Step 2: Registrar en `index.ts`**

En `apps/server/src/mcp/tools/index.ts`:

(a) agregar el import junto a los otros `make*`:
```ts
import { makeProposeBreakdownTool } from './propose-breakdown.js';
```

(b) en el array `tools`, agregar después de `makeValidateRfcTool(store)`:
```ts
    makeProposeBreakdownTool(store, catalog) as unknown as ToolDef,
```

- [ ] **Step 3: Typecheck**

Run:
```bash
pnpm --filter @sdlc/server typecheck
```
Expected: pasa.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/mcp/tools/propose-breakdown.ts apps/server/src/mcp/tools/index.ts
git commit -m "feat(server): propose_breakdown tool"
```

---

## Task 9: Tool `create_epic`

**Files:**
- Create: `apps/server/src/mcp/tools/create-epic.ts`
- Modify: `apps/server/src/mcp/tools/index.ts`

- [ ] **Step 1: Crear el tool**

Crear `apps/server/src/mcp/tools/create-epic.ts`:

```ts
import { z } from 'zod';
import { EpicInput } from '@sdlc/core';
import type { TaskSystemAdapter, TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';

export const CreateEpicInput = z.object({
  flow_id: z.string().min(1),
  epic: EpicInput,
});
export type CreateEpicInput = z.infer<typeof CreateEpicInput>;

export function makeCreateEpicTool(store: FlowStore, taskSystem: TaskSystemAdapter) {
  return {
    name: 'create_epic',
    description:
      'Creates the epic for the flow in the external task system and persists its external id on the flow. Requires status=rfc_ready.',
    inputSchema: CreateEpicInput,
    handler: async (input: CreateEpicInput, ctx: TenantCtx) => {
      const flow = await store.getFlow(input.flow_id);
      if (!flow) return { ok: false, error: `Unknown flow: ${input.flow_id}` };
      if (flow.tenant_id !== ctx.tenantId) {
        return { ok: false, error: 'Flow belongs to a different tenant' };
      }
      if (flow.status !== 'rfc_ready') {
        return {
          ok: false,
          error: `Cannot create epic: flow status is "${flow.status}", expected "rfc_ready".`,
        };
      }

      const ref = await taskSystem.createEpic(
        {
          project_key: flow.project,
          title: input.epic.title,
          description: input.epic.description,
          ...(input.epic.labels ? { labels: input.epic.labels } : {}),
        },
        ctx,
      );

      const updated = await store.updateFlow(flow.flow_id, { epic_external_id: ref.external_id });
      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'epic.created',
        actor: ctx.userId,
        payload: { external_id: ref.external_id, url: ref.url },
      });

      return {
        ok: true,
        data: { epic_ref: ref, flow: updated },
        next_actions: ['create_stories'],
      };
    },
  };
}
```

- [ ] **Step 2: Registrar en `index.ts`**

(a) import:
```ts
import { makeCreateEpicTool } from './create-epic.js';
```
(b) este es el **primer uso de `taskSystem`**. Cambiar la desestructuración en `buildToolRegistry` de:
```ts
  const { catalog, store } = deps;
```
por:
```ts
  const { catalog, store, taskSystem } = deps;
```

(c) en el array `tools`, después de `makeProposeBreakdownTool(store, catalog)`:
```ts
    makeCreateEpicTool(store, taskSystem) as unknown as ToolDef,
```

- [ ] **Step 3: Typecheck**

Run:
```bash
pnpm --filter @sdlc/server typecheck
```
Expected: pasa.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/mcp/tools/create-epic.ts apps/server/src/mcp/tools/index.ts
git commit -m "feat(server): create_epic tool"
```

---

## Task 10: Tool `create_stories`

**Files:**
- Create: `apps/server/src/mcp/tools/create-stories.ts`
- Modify: `apps/server/src/mcp/tools/index.ts`

- [ ] **Step 1: Crear el tool**

Crear `apps/server/src/mcp/tools/create-stories.ts`:

```ts
import { z } from 'zod';
import { StoryInput } from '@sdlc/core';
import type { ExternalRef, TaskSystemAdapter, TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';

export const CreateStoriesInput = z.object({
  flow_id: z.string().min(1),
  epic_id: z.string().min(1),
  stories: z.array(StoryInput).min(1),
});
export type CreateStoriesInput = z.infer<typeof CreateStoriesInput>;

export function makeCreateStoriesTool(store: FlowStore, taskSystem: TaskSystemAdapter) {
  return {
    name: 'create_stories',
    description:
      'Creates user stories under the epic in the external task system and links them to the epic. Requires create_epic to have run (flow.epic_external_id present).',
    inputSchema: CreateStoriesInput,
    handler: async (input: CreateStoriesInput, ctx: TenantCtx) => {
      const flow = await store.getFlow(input.flow_id);
      if (!flow) return { ok: false, error: `Unknown flow: ${input.flow_id}` };
      if (flow.tenant_id !== ctx.tenantId) {
        return { ok: false, error: 'Flow belongs to a different tenant' };
      }
      if (!flow.epic_external_id) {
        return { ok: false, error: 'Cannot create stories: no epic exists yet. Call create_epic first.' };
      }

      const refs: ExternalRef[] = [];
      for (const story of input.stories) {
        const ref = await taskSystem.createStory(
          {
            project_key: flow.project,
            epic_id: input.epic_id,
            title: story.title,
            description: story.description,
            acceptance_criteria: story.acceptance_criteria,
            ...(story.labels ? { labels: story.labels } : {}),
            ...(story.estimate !== undefined ? { estimate: story.estimate } : {}),
          },
          ctx,
        );
        await taskSystem.linkChildToParent(input.epic_id, ref.external_id, ctx);
        refs.push(ref);
      }

      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'stories.created',
        actor: ctx.userId,
        payload: { epic_id: input.epic_id, refs },
      });

      return {
        ok: true,
        data: { story_refs: refs },
        next_actions: ['link_subtasks', 'sync_backlog'],
      };
    },
  };
}
```

- [ ] **Step 2: Registrar en `index.ts`**

(a) import:
```ts
import { makeCreateStoriesTool } from './create-stories.js';
```
(b) en el array `tools`, después de `makeCreateEpicTool(store, taskSystem)`:
```ts
    makeCreateStoriesTool(store, taskSystem) as unknown as ToolDef,
```

- [ ] **Step 3: Typecheck**

Run:
```bash
pnpm --filter @sdlc/server typecheck
```
Expected: pasa.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/mcp/tools/create-stories.ts apps/server/src/mcp/tools/index.ts
git commit -m "feat(server): create_stories tool"
```

---

## Task 11: Tool `link_subtasks`

**Files:**
- Create: `apps/server/src/mcp/tools/link-subtasks.ts`
- Modify: `apps/server/src/mcp/tools/index.ts`

- [ ] **Step 1: Crear el tool**

Crear `apps/server/src/mcp/tools/link-subtasks.ts`:

```ts
import { z } from 'zod';
import { SubtaskInput } from '@sdlc/core';
import type { ExternalRef, TaskSystemAdapter, TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';

export const LinkSubtasksInput = z.object({
  flow_id: z.string().min(1),
  story_id: z.string().min(1),
  subtasks: z.array(SubtaskInput).min(1),
});
export type LinkSubtasksInput = z.infer<typeof LinkSubtasksInput>;

export function makeLinkSubtasksTool(store: FlowStore, taskSystem: TaskSystemAdapter) {
  return {
    name: 'link_subtasks',
    description:
      'Creates technical subtasks (tasks) under a story in the external task system and links them to the story.',
    inputSchema: LinkSubtasksInput,
    handler: async (input: LinkSubtasksInput, ctx: TenantCtx) => {
      const flow = await store.getFlow(input.flow_id);
      if (!flow) return { ok: false, error: `Unknown flow: ${input.flow_id}` };
      if (flow.tenant_id !== ctx.tenantId) {
        return { ok: false, error: 'Flow belongs to a different tenant' };
      }

      const refs: ExternalRef[] = [];
      for (const sub of input.subtasks) {
        const ref = await taskSystem.createSubtask(
          {
            project_key: flow.project,
            parent_story_id: input.story_id,
            title: sub.title,
            ...(sub.description ? { description: sub.description } : {}),
          },
          ctx,
        );
        await taskSystem.linkChildToParent(input.story_id, ref.external_id, ctx);
        refs.push(ref);
      }

      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'subtasks.linked',
        actor: ctx.userId,
        payload: { story_id: input.story_id, refs },
      });

      return {
        ok: true,
        data: { subtask_refs: refs },
        next_actions: ['sync_backlog'],
      };
    },
  };
}
```

- [ ] **Step 2: Registrar en `index.ts`**

(a) import:
```ts
import { makeLinkSubtasksTool } from './link-subtasks.js';
```
(b) en el array `tools`, después de `makeCreateStoriesTool(store, taskSystem)`:
```ts
    makeLinkSubtasksTool(store, taskSystem) as unknown as ToolDef,
```

- [ ] **Step 3: Typecheck**

Run:
```bash
pnpm --filter @sdlc/server typecheck
```
Expected: pasa.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/mcp/tools/link-subtasks.ts apps/server/src/mcp/tools/index.ts
git commit -m "feat(server): link_subtasks tool"
```

---

## Task 12: Tool `sync_backlog`

**Files:**
- Create: `apps/server/src/mcp/tools/sync-backlog.ts`
- Modify: `apps/server/src/mcp/tools/index.ts`

- [ ] **Step 1: Crear el tool**

Crear `apps/server/src/mcp/tools/sync-backlog.ts`:

```ts
import { z } from 'zod';
import type { ExternalRef, TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';

export const SyncBacklogInput = z.object({
  flow_id: z.string().min(1),
});
export type SyncBacklogInput = z.infer<typeof SyncBacklogInput>;

interface RefsPayload {
  refs?: ExternalRef[];
  external_id?: string;
  url?: string;
}

export function makeSyncBacklogTool(store: FlowStore) {
  return {
    name: 'sync_backlog',
    description:
      'Aggregates the epic/stories/subtasks created during shaping (from the flow event log), requires at least one story, and advances the flow to status=backlog_ready / current_phase=implementation.',
    inputSchema: SyncBacklogInput,
    handler: async (input: SyncBacklogInput, ctx: TenantCtx) => {
      const flow = await store.getFlow(input.flow_id);
      if (!flow) return { ok: false, error: `Unknown flow: ${input.flow_id}` };
      if (flow.tenant_id !== ctx.tenantId) {
        return { ok: false, error: 'Flow belongs to a different tenant' };
      }

      const events = await store.listEvents(flow.flow_id);

      let epic: ExternalRef | undefined;
      const stories: ExternalRef[] = [];
      const subtasks: ExternalRef[] = [];
      for (const e of events) {
        const p = e.payload as RefsPayload;
        if (e.type === 'epic.created' && p.external_id && p.url) {
          epic = { external_id: p.external_id, url: p.url };
        }
        if (e.type === 'stories.created' && Array.isArray(p.refs)) {
          stories.push(...p.refs);
        }
        if (e.type === 'subtasks.linked' && Array.isArray(p.refs)) {
          subtasks.push(...p.refs);
        }
      }

      if (stories.length === 0) {
        return {
          ok: false,
          error: 'Cannot sync backlog: no stories have been created yet. Call create_stories first.',
        };
      }

      const updated = await store.updateFlow(flow.flow_id, {
        status: 'backlog_ready',
        current_phase: 'implementation',
      });
      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'stories.created',
        actor: ctx.userId,
        payload: {
          synced: true,
          epic_external_id: epic?.external_id ?? null,
          story_count: stories.length,
          subtask_count: subtasks.length,
        },
      });

      return {
        ok: true,
        data: { flow: updated, backlog: { epic, stories, subtasks } },
        next_actions: ['get_role_prompt({role:"developer", phase:"implement", flow_id})', 'claim_story'],
      };
    },
  };
}
```

- [ ] **Step 2: Registrar en `index.ts`**

(a) import:
```ts
import { makeSyncBacklogTool } from './sync-backlog.js';
```
(b) en el array `tools`, después de `makeLinkSubtasksTool(store, taskSystem)`:
```ts
    makeSyncBacklogTool(store) as unknown as ToolDef,
```

- [ ] **Step 3: Typecheck + build**

Run:
```bash
pnpm --filter @sdlc/server typecheck && pnpm turbo run build
```
Expected: pasa.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/mcp/tools/sync-backlog.ts apps/server/src/mcp/tools/index.ts
git commit -m "feat(server): sync_backlog tool advances flow to backlog_ready"
```

---

## Task 13: Integración — happy path de shaping + guard rails

**Files:**
- Create: `apps/server/test/shaping.test.ts`

- [ ] **Step 1: Escribir el test**

Crear `apps/server/test/shaping.test.ts`:

```ts
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Catalog } from '@sdlc/catalog';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { InMemoryFlowStore } from '../src/state/index.js';
import { InMemoryTaskSystemAdapter } from '../src/adapters/index.js';
import { buildToolRegistry } from '../src/mcp/tools/index.js';

const CATALOG_ROOT = resolve(__dirname, '../../../packages/catalog');

const CTX: TenantCtx = {
  tenantId: 'demo-tenant',
  userId: 'pat',
  roles: ['pmo'],
  async resolveSecret() {
    throw new Error('not used');
  },
};

const RFC = `---
architecture_mode: reuse
codebase_status: existing
existing_repo: https://github.com/acme/checkout
---

# RFC: Pago en cuotas

## Context
ctx

## Architecture context
### Architecture mode
reuse
### Existing components reused
- checkout
### Codebase context
mono
### Integration points
- evento

## Goals
- Pagos en cuotas.

## Non-goals
- nada

## Design
ddd
ddd
ddd

## Risks
| r | t | p | i | m |
| a | b | M | H | x |
| a | b | M | H | x |
| a | b | M | H | x |

## Rollout
- canary

## Rollback
1. flag off
`;

async function setup() {
  const catalog = await Catalog.load(CATALOG_ROOT);
  const store = new InMemoryFlowStore();
  const taskSystem = new InMemoryTaskSystemAdapter();
  const registry = buildToolRegistry({ catalog, store, taskSystem });
  const call = async <T>(name: string, input: unknown): Promise<{ ok: boolean; data?: T; error?: string }> => {
    const tool = registry.get(name);
    if (!tool) throw new Error(`Unknown tool ${name}`);
    const parsed = tool.inputSchema.parse(input ?? {});
    return (await tool.handler(parsed, CTX)) as never;
  };
  return { store, call };
}

async function toRfcReady(call: <T>(n: string, i: unknown) => Promise<{ ok: boolean; data?: T }>) {
  const start = await call<{ flow_id: string }>('start_flow', { project: 'checkout', title: 'Pago en cuotas' });
  const flow_id = (start.data as { flow_id: string }).flow_id;
  const PRD = `# PRD\n\n## Problem\nx problem here long enough to pass\n\n## Users\n- u\n\n## Success Metrics\n| m | b | t | p |\n\n## Scope\n- s\n\n## Out of Scope\n- o\n\n## Risks\n| r | p | i | m |`;
  await call('submit_prd', { flow_id, prd_markdown: PRD, repo_path: '/docs/prd/c.md' });
  await call('submit_rfc', { flow_id, rfc_markdown: RFC, repo_path: '/docs/rfc/c.md' });
  return flow_id;
}

describe('shaping flow', () => {
  it('full happy path: rfc_ready → backlog_ready', async () => {
    const { call } = await setup();
    const flow_id = await toRfcReady(call);

    const proposed = await call<{ suggested_breakdown: unknown; template: string }>('propose_breakdown', {
      flow_id,
      rfc_markdown: RFC,
    });
    expect(proposed.ok).toBe(true);
    expect(typeof proposed.data?.template).toBe('string');

    const epic = await call<{ epic_ref: { external_id: string } }>('create_epic', {
      flow_id,
      epic: { title: 'Cuotas', description: 'desc' },
    });
    expect(epic.ok).toBe(true);
    const epic_id = epic.data!.epic_ref.external_id;

    const stories = await call<{ story_refs: { external_id: string }[] }>('create_stories', {
      flow_id,
      epic_id,
      stories: [
        { title: 'S1', description: 'd', acceptance_criteria: ['ac1'] },
        { title: 'S2', description: 'd', acceptance_criteria: ['ac2'] },
      ],
    });
    expect(stories.ok).toBe(true);
    expect(stories.data?.story_refs.length).toBe(2);
    const story_id = stories.data!.story_refs[0]!.external_id;

    const subs = await call<{ subtask_refs: { external_id: string }[] }>('link_subtasks', {
      flow_id,
      story_id,
      subtasks: [{ title: 'Sub A' }],
    });
    expect(subs.ok).toBe(true);

    const sync = await call<{ flow: { status: string; current_phase: string }; backlog: { stories: unknown[] } }>(
      'sync_backlog',
      { flow_id },
    );
    expect(sync.ok).toBe(true);
    expect(sync.data?.flow.status).toBe('backlog_ready');
    expect(sync.data?.flow.current_phase).toBe('implementation');
    expect(sync.data?.backlog.stories.length).toBe(2);
  });

  it('propose_breakdown fails before rfc_ready', async () => {
    const { call } = await setup();
    const start = await call<{ flow_id: string }>('start_flow', { project: 'checkout', title: 'Early' });
    const flow_id = (start.data as { flow_id: string }).flow_id;
    const res = await call('propose_breakdown', { flow_id, rfc_markdown: RFC });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/rfc_ready/);
  });

  it('create_stories fails when no epic exists', async () => {
    const { call } = await setup();
    const flow_id = await toRfcReady(call);
    const res = await call('create_stories', {
      flow_id,
      epic_id: 'ADO-999',
      stories: [{ title: 'S', description: 'd', acceptance_criteria: ['ac'] }],
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/create_epic first/);
  });

  it('sync_backlog fails when no stories were created', async () => {
    const { call } = await setup();
    const flow_id = await toRfcReady(call);
    await call('create_epic', { flow_id, epic: { title: 'E', description: 'd' } });
    const res = await call('sync_backlog', { flow_id });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no stories/i);
  });

  it('rejects shaping access from another tenant', async () => {
    const { call, store } = await setup();
    const flow_id = await toRfcReady(call);
    // Re-create a registry with a different tenant ctx
    const otherCtx: TenantCtx = { tenantId: 'evil', userId: 'm', roles: ['pmo'], async resolveSecret() { throw new Error('no'); } };
    const catalog = await Catalog.load(CATALOG_ROOT);
    const taskSystem = new InMemoryTaskSystemAdapter();
    const registry = buildToolRegistry({ catalog, store, taskSystem });
    const tool = registry.get('create_epic')!;
    const res = (await tool.handler({ flow_id, epic: { title: 'E', description: 'd' } }, otherCtx)) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/different tenant/);
  });
});
```

- [ ] **Step 2: Correr el test**

Run:
```bash
pnpm --filter @sdlc/server test -- shaping
```
Expected: 5/5 PASS.

- [ ] **Step 3: Correr el suite completo**

Run:
```bash
pnpm --filter @sdlc/server test
```
Expected: todos verdes (Postgres integration skipped sin `TEST_DATABASE_URL`).

- [ ] **Step 4: Commit**

```bash
git add apps/server/test/shaping.test.ts
git commit -m "test(server): shaping happy path + guard rails"
```

---

## Task 14: Ajuste del prompt PMO + bump de phase

**Files:**
- Modify: `packages/catalog/roles/pmo/phases/shaping.md`
- Modify: `packages/catalog/catalog.yaml`

- [ ] **Step 1: Aclarar que `propose_breakdown` recibe `rfc_markdown`**

En `packages/catalog/roles/pmo/phases/shaping.md`, buscar:

```
3. Llama a `propose_breakdown({flow_id})`. El server devuelve una estructura propuesta basada en heurísticas + el RFC. **No la aceptes ciegamente** — revisala con el usuario.
```

Reemplazar por:

```
3. Llama a `propose_breakdown({flow_id, rfc_markdown})` pasando el cuerpo del RFC (el server no lo almacena). Devuelve una estructura sugerida (heurística determinista) + el breakdown-template. **No la aceptes ciegamente** — revisala y reescribila con el usuario.
```

También bumpear el `version` del frontmatter de `0.1.0` a `0.2.0`:

```
version: 0.2.0
```

- [ ] **Step 2: Bump de la phase en `catalog.yaml`**

En `packages/catalog/catalog.yaml`, dentro de `pmo.phases.shaping`, cambiar:

```yaml
      shaping:
        path: roles/pmo/phases/shaping.md
        version: 0.1.0
```

por:

```yaml
      shaping:
        path: roles/pmo/phases/shaping.md
        version: 0.2.0
```

- [ ] **Step 3: Smoke check del catálogo**

Run:
```bash
pnpm --filter @sdlc/catalog build && pnpm --filter @sdlc/server test -- catalog.smoke
```
Expected: PASS (la versión del catálogo no cambia; solo la phase).

- [ ] **Step 4: Commit**

```bash
git add packages/catalog/roles/pmo/phases/shaping.md packages/catalog/catalog.yaml
git commit -m "docs(catalog): shaping phase documents propose_breakdown rfc_markdown input"
```

---

## Task 15: Verificación final

**Files:** ninguno.

- [ ] **Step 1: Build completo**

Run:
```bash
pnpm turbo run build
```
Expected: 4 packages buildan OK.

- [ ] **Step 2: Typecheck completo**

Run:
```bash
pnpm turbo run typecheck
```
Expected: pasa.

- [ ] **Step 3: Test suite completo**

Run:
```bash
pnpm turbo run test
```
Expected: todos verdes; Postgres integration skipped sin `TEST_DATABASE_URL`.

- [ ] **Step 4: Verificar conteo de tools**

Run:
```bash
pnpm --filter @sdlc/server test -- shaping in-memory-task-system propose-breakdown breakdown-validation
```
Expected: los 4 archivos de test nuevos pasan.

- [ ] **Step 5: `git status` limpio**

Run:
```bash
git status
```
Expected: working tree clean (todo commiteado por las tasks previas).

---

## Checklist de cobertura del spec

- [x] **Task 1** — `'azure-devops'` en `TaskSystemKind` (§Capa de adapter).
- [x] **Task 2** — tipos zod del breakdown en core (§Tipos del breakdown).
- [x] **Task 3** — `InMemoryTaskSystemAdapter` + tests (§Capa de adapter).
- [x] **Task 4** — factory (§Capa de adapter / Wiring).
- [x] **Task 5** — heurística `proposeBreakdown` (§Heurística de propose_breakdown).
- [x] **Task 6** — `validateBreakdown` (§Validación del breakdown).
- [x] **Task 7** — `taskSystem` en deps + bootstrap (§Wiring).
- [x] **Task 8-12** — las 5 tools (§Las 5 tools).
- [x] **Task 13** — happy path + guard rails, incl. `sync_backlog` exige ≥1 story (§Las 5 tools / Risks).
- [x] **Task 14** — ajuste prompt PMO + bump phase (§Catálogo).
- [x] **Task 15** — gate final.

Sin tareas para vault/`resolveSecret` ni adapter Azure DevOps real — explícitamente fuera de este slice (§Non-goals).
