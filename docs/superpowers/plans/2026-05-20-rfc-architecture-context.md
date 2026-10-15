# RFC Architecture Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Forzar al Tech Lead a declarar `architecture_mode` y `codebase_status` en cada RFC, persistir esos campos en el flow, y entregar automáticamente skills extra a Developer / QA / Reviewer según el escenario.

**Architecture:** Frontmatter YAML + sección `## Architecture context` obligatoria en el RFC. `submit_rfc` parsea el frontmatter y lo persiste en `flows`. `get_role_prompt` acepta `flow_id` opcional y mergea skills extra desde un nuevo bloque `scenario_skills` en `catalog.yaml`.

**Tech Stack:** TypeScript estricto, vitest, drizzle-orm + postgres-js, zod, gray-matter (ya disponible en `@sdlc/catalog`), yaml (ya disponible). Sin libs nuevas.

**Spec:** [docs/superpowers/specs/2026-05-20-rfc-architecture-context-design.md](../specs/2026-05-20-rfc-architecture-context-design.md)

---

## File Structure

**Crear:**
- `apps/server/migrations/0001_architecture_context.sql`
- `packages/catalog/skills/skill-greenfield-implementation.md`
- `packages/catalog/skills/skill-reuse-implementation.md`
- `packages/catalog/skills/skill-existing-codebase-conventions.md`
- `packages/catalog/skills/skill-reuse-regression-checks.md`
- `packages/catalog/skills/skill-reuse-review-checklist.md`
- `packages/catalog/skills/skill-codebase-consistency-review.md`
- `apps/server/src/validation/rfc-frontmatter.ts` — parser puro del frontmatter del RFC.
- `apps/server/test/rfc-validation.test.ts` — tests del validador extendido.
- `apps/server/test/scenario-skills.test.ts` — tests del merge de scenario skills.

**Modificar:**
- `packages/core/src/flow.ts` — extender `Flow` zod schema.
- `packages/catalog/src/index.ts` — extender `CatalogIndex` con `scenario_skills` y agregar firma a `getRolePrompt`.
- `packages/catalog/templates/rfc-template.md`
- `packages/catalog/roles/tech-lead/phases/rfc-draft.md`
- `packages/catalog/roles/developer/phases/implement.md`
- `packages/catalog/roles/qa/phases/qa.md`
- `packages/catalog/roles/reviewer/phases/review.md`
- `packages/catalog/catalog.yaml`
- `apps/server/src/state/schema.ts`
- `apps/server/src/state/store.ts` — `UpdateFlowInput`.
- `apps/server/src/state/in-memory.ts` — (sin cambios funcionales, solo verificar).
- `apps/server/src/state/postgres.ts` — `updateFlow` + `rowToFlow`.
- `apps/server/src/validation/rfc.ts` — usar parser + nuevas reglas.
- `apps/server/src/mcp/tools/submit-rfc.ts` — persistir frontmatter parseado.
- `apps/server/src/mcp/tools/get-role-prompt.ts` — aceptar `flow_id` y delegar al catalog para mergear.
- `apps/server/test/catalog.smoke.test.ts` — actualizar version assertion a `0.3.0` + casos nuevos.
- `apps/server/test/flow.test.ts` — extender RFC válido + happy path con clasificación.

---

## Task 1: Extender el zod `Flow` con los 3 campos nuevos

**Files:**
- Modify: `packages/core/src/flow.ts:34-48`

- [ ] **Step 1: Editar `Flow` para sumar los 3 campos opcionales**

Editar `packages/core/src/flow.ts`. Antes de `created_at`, sumar los 3 fields. Reemplazar el bloque `export const Flow = z.object({ ... })` con:

```ts
export const ArchitectureMode = z.enum(['new', 'reuse', 'hybrid']);
export type ArchitectureMode = z.infer<typeof ArchitectureMode>;

export const CodebaseStatus = z.enum(['greenfield', 'existing']);
export type CodebaseStatus = z.infer<typeof CodebaseStatus>;

export const Flow = z.object({
  flow_id: z.string(),
  tenant_id: z.string(),
  project: z.string(),
  slug: z.string(),
  title: z.string(),
  status: FlowStatus,
  current_phase: CurrentPhase,
  prd_ref: ArtifactRef.optional(),
  rfc_ref: ArtifactRef.optional(),
  epic_external_id: z.string().optional(),
  architecture_mode: ArchitectureMode.optional(),
  codebase_status: CodebaseStatus.optional(),
  existing_repo: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Flow = z.infer<typeof Flow>;
```

- [ ] **Step 2: Build & typecheck**

Run:
```bash
pnpm --filter @sdlc/core build
pnpm --filter @sdlc/core typecheck
```
Expected: ambos comandos terminan sin errores.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/flow.ts
git commit -m "feat(core): add architecture_mode/codebase_status to Flow schema"
```

---

## Task 2: Storage — extender `UpdateFlowInput`

**Files:**
- Modify: `apps/server/src/state/store.ts:10-16`

- [ ] **Step 1: Agregar campos a `UpdateFlowInput`**

Editar `apps/server/src/state/store.ts`. Importar los nuevos tipos y sumar campos:

```ts
import type {
  ArchitectureMode,
  ArtifactRef,
  CodebaseStatus,
  CurrentPhase,
  Flow,
  FlowEvent,
  FlowEventType,
  FlowStatus,
} from '@sdlc/core';

// ... CreateFlowInput unchanged

export interface UpdateFlowInput {
  status?: FlowStatus;
  current_phase?: CurrentPhase;
  prd_ref?: ArtifactRef;
  rfc_ref?: ArtifactRef;
  epic_external_id?: string;
  architecture_mode?: ArchitectureMode;
  codebase_status?: CodebaseStatus;
  existing_repo?: string;
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
pnpm --filter @sdlc/server typecheck
```
Expected: pasa (los stores aún no usan los campos pero no falla compilación porque son opcionales).

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/state/store.ts
git commit -m "feat(server): extend UpdateFlowInput with architecture/codebase fields"
```

---

## Task 3: Storage — Drizzle schema + migración SQL

**Files:**
- Modify: `apps/server/src/state/schema.ts:11-24`
- Create: `apps/server/migrations/0001_architecture_context.sql`
- Modify: `apps/server/migrations/meta/_journal.json`

- [ ] **Step 1: Agregar las 3 columnas al `flows` table en Drizzle**

Editar `apps/server/src/state/schema.ts`. Reemplazar `export const flows = pgTable('flows', {` con el bloque completo incluyendo nuevos campos antes de `created_at`:

```ts
export const flows = pgTable('flows', {
  flow_id: text('flow_id').primaryKey(),
  tenant_id: text('tenant_id').notNull(),
  project: text('project').notNull(),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  status: text('status').notNull(),
  current_phase: text('current_phase').notNull(),
  prd_ref: jsonb('prd_ref'),
  rfc_ref: jsonb('rfc_ref'),
  epic_external_id: text('epic_external_id'),
  architecture_mode: text('architecture_mode'),
  codebase_status: text('codebase_status'),
  existing_repo: text('existing_repo'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Crear el archivo de migración SQL**

Crear `apps/server/migrations/0001_architecture_context.sql` con:

```sql
ALTER TABLE "flows" ADD COLUMN IF NOT EXISTS "architecture_mode" text;
ALTER TABLE "flows" ADD COLUMN IF NOT EXISTS "codebase_status" text;
ALTER TABLE "flows" ADD COLUMN IF NOT EXISTS "existing_repo" text;
```

- [ ] **Step 3: Registrar la migración en el journal de drizzle**

Editar `apps/server/migrations/meta/_journal.json`. Reemplazar el contenido por:

```json
{
  "version": "7",
  "dialect": "postgresql",
  "entries": [
    {
      "idx": 0,
      "version": "7",
      "when": 1746000000000,
      "tag": "0000_init",
      "breakpoints": true
    },
    {
      "idx": 1,
      "version": "7",
      "when": 1747740000000,
      "tag": "0001_architecture_context",
      "breakpoints": true
    }
  ]
}
```

- [ ] **Step 4: Typecheck del server**

Run:
```bash
pnpm --filter @sdlc/server typecheck
```
Expected: pasa.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/state/schema.ts apps/server/migrations/0001_architecture_context.sql apps/server/migrations/meta/_journal.json
git commit -m "feat(server): migration for architecture_mode/codebase_status/existing_repo"
```

---

## Task 4: Storage — `PostgresFlowStore.updateFlow` + `rowToFlow`

**Files:**
- Modify: `apps/server/src/state/postgres.ts`

- [ ] **Step 1: Importar los nuevos tipos**

En `apps/server/src/state/postgres.ts`, actualizar el import de `@sdlc/core`:

```ts
import type {
  ArchitectureMode,
  ArtifactRef,
  CodebaseStatus,
  CurrentPhase,
  Flow,
  FlowEvent,
  FlowEventType,
  FlowStatus,
} from '@sdlc/core';
```

- [ ] **Step 2: Extender `updateFlow` para persistir los 3 campos**

Reemplazar el bloque actual de `updateFlow` para que mapee los nuevos patches al update:

```ts
  async updateFlow(flowId: string, patch: UpdateFlowInput): Promise<Flow> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.current_phase !== undefined) update.current_phase = patch.current_phase;
    if (patch.prd_ref !== undefined) update.prd_ref = patch.prd_ref;
    if (patch.rfc_ref !== undefined) update.rfc_ref = patch.rfc_ref;
    if (patch.epic_external_id !== undefined) update.epic_external_id = patch.epic_external_id;
    if (patch.architecture_mode !== undefined) update.architecture_mode = patch.architecture_mode;
    if (patch.codebase_status !== undefined) update.codebase_status = patch.codebase_status;
    if (patch.existing_repo !== undefined) update.existing_repo = patch.existing_repo;

    const rows = await this.db
      .update(flows)
      .set(update)
      .where(eq(flows.flow_id, flowId))
      .returning();
    const row = rows[0];
    if (!row) throw new Error(`Unknown flow: ${flowId}`);
    return rowToFlow(row);
  }
```

- [ ] **Step 3: Extender `rowToFlow` para incluir los nuevos campos en la respuesta**

Reemplazar `rowToFlow` al pie del archivo:

```ts
function rowToFlow(row: typeof flows.$inferSelect): Flow {
  return {
    flow_id: row.flow_id,
    tenant_id: row.tenant_id,
    project: row.project,
    slug: row.slug,
    title: row.title,
    status: row.status as FlowStatus,
    current_phase: row.current_phase as CurrentPhase,
    prd_ref: (row.prd_ref as ArtifactRef | null) ?? undefined,
    rfc_ref: (row.rfc_ref as ArtifactRef | null) ?? undefined,
    epic_external_id: row.epic_external_id ?? undefined,
    architecture_mode: (row.architecture_mode as ArchitectureMode | null) ?? undefined,
    codebase_status: (row.codebase_status as CodebaseStatus | null) ?? undefined,
    existing_repo: row.existing_repo ?? undefined,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
```

- [ ] **Step 4: Typecheck**

Run:
```bash
pnpm --filter @sdlc/server typecheck
```
Expected: pasa.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/state/postgres.ts
git commit -m "feat(server): persist architecture_mode/codebase_status in PostgresFlowStore"
```

---

## Task 5: Storage — verificar `InMemoryFlowStore`

**Files:**
- Modify (verificar): `apps/server/src/state/in-memory.ts`

El `InMemoryFlowStore.updateFlow` actual usa `{ ...existing, ...patch, updated_at }` (línea 42-46). Con los nuevos campos opcionales en `UpdateFlowInput`, el spread los propaga automáticamente. No requiere cambios funcionales — pero hay que **agregar un test** que lo cubra explícitamente.

- [ ] **Step 1: Escribir el test fallido**

Crear `apps/server/test/in-memory-architecture-context.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { InMemoryFlowStore } from '../src/state/index.js';

describe('InMemoryFlowStore — architecture context fields', () => {
  it('updateFlow persists architecture_mode, codebase_status, existing_repo', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({
      tenant_id: 't1',
      project: 'p',
      slug: 'feat-a',
      title: 'feat-a',
    });
    const updated = await store.updateFlow(flow.flow_id, {
      architecture_mode: 'reuse',
      codebase_status: 'existing',
      existing_repo: 'https://github.com/acme/repo',
    });
    expect(updated.architecture_mode).toBe('reuse');
    expect(updated.codebase_status).toBe('existing');
    expect(updated.existing_repo).toBe('https://github.com/acme/repo');

    const reread = await store.getFlow(flow.flow_id);
    expect(reread?.architecture_mode).toBe('reuse');
  });

  it('new flows have undefined architecture fields by default', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({
      tenant_id: 't1',
      project: 'p',
      slug: 'feat-b',
      title: 'feat-b',
    });
    expect(flow.architecture_mode).toBeUndefined();
    expect(flow.codebase_status).toBeUndefined();
    expect(flow.existing_repo).toBeUndefined();
  });
});
```

- [ ] **Step 2: Correr el test**

Run:
```bash
pnpm --filter @sdlc/server test -- in-memory-architecture-context
```
Expected: PASS (no requiere cambios al store; el spread ya cubre los nuevos campos).

- [ ] **Step 3: Commit**

```bash
git add apps/server/test/in-memory-architecture-context.test.ts
git commit -m "test(server): cover architecture context fields in InMemoryFlowStore"
```

---

## Task 6: Validator — parser puro del frontmatter del RFC

**Files:**
- Create: `apps/server/src/validation/rfc-frontmatter.ts`

- [ ] **Step 1: Escribir el módulo del parser**

Crear `apps/server/src/validation/rfc-frontmatter.ts`:

```ts
import matter from 'gray-matter';
import type { ValidationIssue } from '@sdlc/core';

export type ArchitectureMode = 'new' | 'reuse' | 'hybrid';
export type CodebaseStatus = 'greenfield' | 'existing';

export interface RfcFrontmatter {
  architecture_mode?: ArchitectureMode;
  codebase_status?: CodebaseStatus;
  existing_repo?: string;
}

export interface ParsedRfcFrontmatter {
  /** Parsed values when known to be valid. Missing/invalid fields are absent. */
  frontmatter: RfcFrontmatter;
  /** Markdown body (frontmatter stripped). Falls back to original input on parse failure. */
  body: string;
  /** Validation issues — empty on full success. */
  issues: ValidationIssue[];
}

const ARCH_VALUES: ReadonlySet<string> = new Set(['new', 'reuse', 'hybrid']);
const CODEBASE_VALUES: ReadonlySet<string> = new Set(['greenfield', 'existing']);

export function parseRfcFrontmatter(markdown: string): ParsedRfcFrontmatter {
  const issues: ValidationIssue[] = [];
  let data: Record<string, unknown> = {};
  let body = markdown;
  try {
    const parsed = matter(markdown);
    data = (parsed.data ?? {}) as Record<string, unknown>;
    body = parsed.content;
  } catch (err) {
    issues.push({
      severity: 'error',
      section: 'frontmatter',
      message: `Failed to parse YAML frontmatter: ${(err as Error).message}`,
    });
    return { frontmatter: {}, body, issues };
  }

  if (!data || Object.keys(data).length === 0) {
    issues.push({
      severity: 'error',
      section: 'frontmatter',
      message:
        'Missing YAML frontmatter. The RFC must start with a "---" block declaring architecture_mode and codebase_status.',
    });
    return { frontmatter: {}, body, issues };
  }

  const fm: RfcFrontmatter = {};

  const mode = data.architecture_mode;
  if (typeof mode !== 'string' || !ARCH_VALUES.has(mode)) {
    issues.push({
      severity: 'error',
      section: 'frontmatter',
      message: `Field "architecture_mode" must be one of: new, reuse, hybrid (got ${JSON.stringify(mode)}).`,
    });
  } else {
    fm.architecture_mode = mode as ArchitectureMode;
  }

  const status = data.codebase_status;
  if (typeof status !== 'string' || !CODEBASE_VALUES.has(status)) {
    issues.push({
      severity: 'error',
      section: 'frontmatter',
      message: `Field "codebase_status" must be one of: greenfield, existing (got ${JSON.stringify(status)}).`,
    });
  } else {
    fm.codebase_status = status as CodebaseStatus;
  }

  const repo = data.existing_repo;
  if (repo !== undefined) {
    if (typeof repo !== 'string' || repo.trim().length === 0) {
      issues.push({
        severity: 'error',
        section: 'frontmatter',
        message: '"existing_repo" must be a non-empty string when provided.',
      });
    } else {
      fm.existing_repo = repo.trim();
    }
  }

  if (fm.codebase_status === 'existing' && !fm.existing_repo) {
    issues.push({
      severity: 'error',
      section: 'frontmatter',
      message: '"existing_repo" is required when codebase_status="existing".',
    });
  }

  return { frontmatter: fm, body, issues };
}
```

- [ ] **Step 2: Escribir tests para el parser**

Crear `apps/server/test/rfc-frontmatter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseRfcFrontmatter } from '../src/validation/rfc-frontmatter.js';

describe('parseRfcFrontmatter', () => {
  it('parses a valid frontmatter block', () => {
    const md = `---
architecture_mode: reuse
codebase_status: existing
existing_repo: https://github.com/acme/repo
---

# RFC body`;
    const result = parseRfcFrontmatter(md);
    expect(result.issues).toEqual([]);
    expect(result.frontmatter.architecture_mode).toBe('reuse');
    expect(result.frontmatter.codebase_status).toBe('existing');
    expect(result.frontmatter.existing_repo).toBe('https://github.com/acme/repo');
    expect(result.body.trim().startsWith('# RFC body')).toBe(true);
  });

  it('reports missing frontmatter', () => {
    const result = parseRfcFrontmatter('# RFC without frontmatter\n\nBody.');
    expect(result.issues.some((i) => i.message.includes('Missing YAML frontmatter'))).toBe(true);
  });

  it('reports invalid architecture_mode', () => {
    const md = `---
architecture_mode: weird
codebase_status: greenfield
---

# RFC`;
    const result = parseRfcFrontmatter(md);
    expect(result.issues.some((i) => i.message.includes('architecture_mode'))).toBe(true);
    expect(result.frontmatter.architecture_mode).toBeUndefined();
  });

  it('requires existing_repo when codebase_status=existing', () => {
    const md = `---
architecture_mode: reuse
codebase_status: existing
---

# RFC`;
    const result = parseRfcFrontmatter(md);
    expect(result.issues.some((i) => i.message.includes('existing_repo'))).toBe(true);
  });

  it('allows omitting existing_repo when codebase_status=greenfield', () => {
    const md = `---
architecture_mode: new
codebase_status: greenfield
---

# RFC`;
    const result = parseRfcFrontmatter(md);
    expect(result.issues).toEqual([]);
    expect(result.frontmatter.codebase_status).toBe('greenfield');
    expect(result.frontmatter.existing_repo).toBeUndefined();
  });
});
```

- [ ] **Step 3: Correr los tests**

Run:
```bash
pnpm --filter @sdlc/server test -- rfc-frontmatter
```
Expected: 5/5 PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/validation/rfc-frontmatter.ts apps/server/test/rfc-frontmatter.test.ts
git commit -m "feat(server): parser for RFC architecture-context frontmatter"
```

---

## Task 7: Validator — integrar frontmatter + sección Architecture context en `validateRfc`

**Files:**
- Modify: `apps/server/src/validation/rfc.ts`
- Create: `apps/server/test/rfc-validation.test.ts`

- [ ] **Step 1: Escribir tests fallidos**

Crear `apps/server/test/rfc-validation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { validateRfc } from '../src/validation/rfc.js';

const RFC_BODY = `
# RFC: Demo

## Context
Context paragraph.

## Architecture context

### Architecture mode
Reusamos la arquitectura existente del servicio checkout.

### Existing components reused
- packages/checkout/service
- packages/payments/api

### Codebase context
Monorepo TypeScript pnpm + turbo. Convenciones de naming kebab.

### Integration points
- Eventos checkout.order.created
- API REST /payments/installments

## Goals
- Cuotas 3/6/12 con p99 < 800ms.

## Non-goals
- Refinanciación.

## Design
Use processor X with idempotent webhook.
Add table payments_plans.
Add frontend selector.

## Risks
| r | t | p | i | m |
| webhook drop | integ | M | H | retry |
| migration | data | L | H | online |
| cost | perf | M | M | cap |

## Rollout
- Canary 5%.

## Rollback
1. Off feature flag.
2. Drain queue.
3. Revert migration.
`;

const VALID_FRONTMATTER = `---
architecture_mode: reuse
codebase_status: existing
existing_repo: https://github.com/acme/checkout
---
`;

describe('validateRfc — extended with architecture context', () => {
  it('passes when frontmatter + Architecture context are present and complete', () => {
    const md = VALID_FRONTMATTER + RFC_BODY;
    const result = validateRfc(md);
    expect(result.ok).toBe(true);
  });

  it('fails when frontmatter is missing', () => {
    const result = validateRfc(RFC_BODY);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes('frontmatter'))).toBe(true);
  });

  it('fails when "## Architecture context" section is missing', () => {
    const md =
      VALID_FRONTMATTER +
      `
# RFC

## Context
ctx

## Goals
- g

## Non-goals
- n

## Design
d
d
d

## Risks
| r | t | p | i | m |
| a | b | M | H | x |
| a | b | M | H | x |
| a | b | M | H | x |

## Rollout
- a

## Rollback
1. a
`;
    const result = validateRfc(md);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.section === 'architecture_context')).toBe(true);
  });

  it('requires Integration points when architecture_mode=reuse', () => {
    const md =
      VALID_FRONTMATTER +
      RFC_BODY.replace(
        /### Integration points\n[\s\S]*?(?=##\s)/,
        '### Integration points\n\n',
      );
    const result = validateRfc(md);
    expect(result.ok).toBe(false);
    expect(
      result.issues.some(
        (i) => i.section === 'integration_points' && i.severity === 'error',
      ),
    ).toBe(true);
  });

  it('allows empty Integration points when architecture_mode=new', () => {
    const md =
      `---
architecture_mode: new
codebase_status: greenfield
---
` +
      RFC_BODY
        .replace(/### Existing components reused\n[\s\S]*?(?=###\s)/, '### Existing components reused\nNinguno — arquitectura nueva.\n\n')
        .replace(/### Integration points\n[\s\S]*?(?=##\s)/, '### Integration points\n\nN/A — arquitectura nueva.\n\n');
    const result = validateRfc(md);
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Correr los tests (esperado: FAIL)**

Run:
```bash
pnpm --filter @sdlc/server test -- rfc-validation
```
Expected: la mayoría FAIL — el validador actual no conoce ni frontmatter ni Architecture context.

- [ ] **Step 3: Implementar la validación extendida**

Reemplazar el contenido de `apps/server/src/validation/rfc.ts`:

```ts
import type { ValidationIssue, ValidationResult } from '@sdlc/core';
import { validateMarkdownSections, type SectionRule } from './markdown-sections.js';
import { parseRfcFrontmatter } from './rfc-frontmatter.js';

const RFC_RULES: SectionRule[] = [
  { id: 'context', aliases: ['Context', 'Contexto'], minContentLines: 1 },
  { id: 'architecture_context', aliases: ['Architecture context', 'Contexto de arquitectura'], minContentLines: 1 },
  { id: 'goals', aliases: ['Goals', 'Objetivos'], minContentLines: 1 },
  { id: 'non_goals', aliases: ['Non-goals', 'Non Goals', 'No-objetivos'], minContentLines: 1 },
  { id: 'design', aliases: ['Design', 'Diseño', 'Diseno'], minContentLines: 3 },
  { id: 'risks', aliases: ['Risks', 'Riesgos'], minContentLines: 3 },
  { id: 'rollout', aliases: ['Rollout'], minContentLines: 1 },
  { id: 'rollback', aliases: ['Rollback'], minContentLines: 1 },
];

const ARCH_SUBSECTIONS: SectionRule[] = [
  { id: 'architecture_mode', aliases: ['Architecture mode', 'Modo de arquitectura'], minContentLines: 1 },
  { id: 'existing_components_reused', aliases: ['Existing components reused', 'Componentes reusados'], minContentLines: 1 },
  { id: 'codebase_context', aliases: ['Codebase context', 'Contexto de codebase'], minContentLines: 1 },
  // Integration points is conditionally required — handled after parsing frontmatter.
];

export function validateRfc(markdown: string): ValidationResult {
  const issues: ValidationIssue[] = [];

  const parsed = parseRfcFrontmatter(markdown);
  issues.push(...parsed.issues);

  // Validate body sections against the existing markdown-section helper.
  const bodyResult = validateMarkdownSections(parsed.body, RFC_RULES);
  issues.push(...bodyResult.issues);

  // Validate the 3 always-required Architecture context sub-sections.
  const subResult = validateMarkdownSections(parsed.body, ARCH_SUBSECTIONS);
  issues.push(...subResult.issues);

  // Conditionally require Integration points if architecture_mode requires it.
  const requiresIntegration =
    parsed.frontmatter.architecture_mode === 'reuse' ||
    parsed.frontmatter.architecture_mode === 'hybrid';
  if (requiresIntegration) {
    const ipResult = validateMarkdownSections(parsed.body, [
      { id: 'integration_points', aliases: ['Integration points', 'Puntos de integración'], minContentLines: 1 },
    ]);
    // architecture_mode ∈ {reuse, hybrid} hace que esta sección sea un requisito
    // duro: una sección vacía es ERROR, no warning. Promovemos la severidad.
    for (const issue of ipResult.issues) {
      if (issue.section === 'integration_points' && issue.severity === 'warning') {
        issues.push({ ...issue, severity: 'error' });
      } else {
        issues.push(issue);
      }
    }
  }

  return { ok: issues.every((i) => i.severity !== 'error'), issues };
}
```

- [ ] **Step 4: Correr los tests (esperado: PASS)**

Run:
```bash
pnpm --filter @sdlc/server test -- rfc-validation
```
Expected: 5/5 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/validation/rfc.ts apps/server/test/rfc-validation.test.ts
git commit -m "feat(server): validate RFC frontmatter + Architecture context sections"
```

---

## Task 8: `submit_rfc` — persistir frontmatter parseado en el flow

**Files:**
- Modify: `apps/server/src/mcp/tools/submit-rfc.ts`

- [ ] **Step 1: Persistir architecture_mode/codebase_status/existing_repo desde el frontmatter**

Reemplazar `apps/server/src/mcp/tools/submit-rfc.ts` completo:

```ts
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';
import { validateRfc } from '../../validation/rfc.js';
import { parseRfcFrontmatter } from '../../validation/rfc-frontmatter.js';
import type { UpdateFlowInput } from '../../state/store.js';

export const SubmitRfcInput = z.object({
  flow_id: z.string().min(1),
  rfc_markdown: z.string().min(50),
  repo_path: z.string().min(1),
});
export type SubmitRfcInput = z.infer<typeof SubmitRfcInput>;

export function makeSubmitRfcTool(store: FlowStore) {
  return {
    name: 'submit_rfc',
    description:
      'Submits the RFC markdown for a flow. Parses the YAML frontmatter to extract architecture_mode/codebase_status/existing_repo and persists them on the flow. Stores reference (repo_path + sha256) — not the body. Runs structural validation; on success advances to status=rfc_ready and current_phase=shaping.',
    inputSchema: SubmitRfcInput,
    handler: async (input: SubmitRfcInput, ctx: TenantCtx) => {
      const flow = await store.getFlow(input.flow_id);
      if (!flow) return { ok: false, error: `Unknown flow: ${input.flow_id}` };
      if (flow.tenant_id !== ctx.tenantId) {
        return { ok: false, error: 'Flow belongs to a different tenant' };
      }
      if (!flow.prd_ref) {
        return {
          ok: false,
          error: 'Cannot submit RFC: PRD has not been submitted yet for this flow.',
        };
      }

      const validation = validateRfc(input.rfc_markdown);
      const frontmatter = parseRfcFrontmatter(input.rfc_markdown).frontmatter;
      const sha256 = createHash('sha256').update(input.rfc_markdown).digest('hex');

      const patch: UpdateFlowInput = {
        rfc_ref: { repo_path: input.repo_path, sha256 },
        ...(frontmatter.architecture_mode ? { architecture_mode: frontmatter.architecture_mode } : {}),
        ...(frontmatter.codebase_status ? { codebase_status: frontmatter.codebase_status } : {}),
        ...(frontmatter.existing_repo ? { existing_repo: frontmatter.existing_repo } : {}),
        ...(validation.ok
          ? { status: 'rfc_ready' as const, current_phase: 'shaping' as const }
          : {}),
      };

      const updated = await store.updateFlow(flow.flow_id, patch);
      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'rfc.submitted',
        actor: ctx.userId,
        payload: {
          sha256,
          repo_path: input.repo_path,
          validation_ok: validation.ok,
          architecture_mode: frontmatter.architecture_mode ?? null,
          codebase_status: frontmatter.codebase_status ?? null,
        },
      });

      return {
        ok: validation.ok,
        data: { flow: updated, validation },
        next_actions: validation.ok ? ['validate_rfc', 'propose_breakdown'] : ['fix issues, resubmit'],
      };
    },
  };
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
pnpm --filter @sdlc/server typecheck
```
Expected: pasa.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/mcp/tools/submit-rfc.ts
git commit -m "feat(server): submit_rfc parses frontmatter and persists classification on flow"
```

---

## Task 9: Catalog — extender el schema con `scenario_skills`

**Files:**
- Modify: `packages/catalog/src/index.ts`

- [ ] **Step 1: Extender `CatalogIndex` zod schema y `getRolePrompt`**

Editar `packages/catalog/src/index.ts`. Reemplazar el bloque `CatalogIndex` y la firma de `getRolePrompt`:

```ts
const ScenarioSkillMap = z
  .object({
    architecture_mode: z
      .object({
        new: z.array(z.string()).default([]),
        reuse: z.array(z.string()).default([]),
        hybrid: z.array(z.string()).default([]),
      })
      .partial()
      .optional(),
    codebase_status: z
      .object({
        greenfield: z.array(z.string()).default([]),
        existing: z.array(z.string()).default([]),
      })
      .partial()
      .optional(),
  })
  .partial();

const CatalogIndex = z.object({
  schema: z.literal(1),
  catalog_version: z.string(),
  roles: z.record(RoleEntry),
  skills: z.record(SimpleEntry).default({}),
  templates: z.record(SimpleEntry).default({}),
  scenario_skills: z.record(ScenarioSkillMap).default({}),
});
export type CatalogIndex = z.infer<typeof CatalogIndex>;

export interface ScenarioContext {
  architecture_mode?: 'new' | 'reuse' | 'hybrid';
  codebase_status?: 'greenfield' | 'existing';
}
```

- [ ] **Step 2: Modificar `getRolePrompt` para aceptar `ScenarioContext` opcional y mergear skills**

Reemplazar el método entero por:

```ts
  async getRolePrompt(
    role: RoleId,
    phase: PhaseId,
    scenario?: ScenarioContext,
  ): Promise<RolePromptBundle> {
    const roleEntry = this.index.roles[role];
    if (!roleEntry) throw new Error(`Unknown role: ${role}`);
    const phaseEntry = roleEntry.phases[phase];
    if (!phaseEntry) throw new Error(`Unknown phase ${phase} for role ${role}`);

    const roleDoc = await this.readDoc(roleEntry.role_prompt);
    const phaseDoc = await this.readDoc(phaseEntry.path);
    const systemPrompt = `${roleDoc.content.trim()}\n\n---\n\n${phaseDoc.content.trim()}\n`;

    const skillIds = this.resolveSkillIds(role, phase, phaseEntry.skills, scenario);

    const skills = await Promise.all(
      skillIds.map(async (id) => {
        const entry = this.index.skills[id];
        if (!entry) throw new Error(`Unknown skill: ${id}`);
        const doc = await this.readDoc(entry.path);
        return { id, version: entry.version, markdown: doc.content };
      }),
    );

    const templates = await Promise.all(
      phaseEntry.templates.map(async (id) => {
        const entry = this.index.templates[id];
        if (!entry) throw new Error(`Unknown template: ${id}`);
        const content = await readFile(join(this.rootDir, entry.path), 'utf8');
        return { id, content };
      }),
    );

    return {
      role,
      phase,
      version: phaseEntry.version,
      system_prompt: systemPrompt,
      skills,
      templates,
    };
  }

  private resolveSkillIds(
    role: RoleId,
    phase: PhaseId,
    base: string[],
    scenario?: ScenarioContext,
  ): string[] {
    const merged = new Set<string>(base);
    if (!scenario) return [...merged];

    const key = `${role}.${phase}`;
    const map = this.index.scenario_skills[key];
    if (!map) return [...merged];

    if (scenario.architecture_mode && map.architecture_mode) {
      const extra = map.architecture_mode[scenario.architecture_mode] ?? [];
      for (const id of extra) merged.add(id);
    }
    if (scenario.codebase_status && map.codebase_status) {
      const extra = map.codebase_status[scenario.codebase_status] ?? [];
      for (const id of extra) merged.add(id);
    }
    return [...merged];
  }
```

- [ ] **Step 3: Build del catalog**

Run:
```bash
pnpm --filter @sdlc/catalog build
```
Expected: pasa.

- [ ] **Step 4: Commit**

```bash
git add packages/catalog/src/index.ts
git commit -m "feat(catalog): support scenario_skills merging via getRolePrompt scenario arg"
```

---

## Task 10: Catálogo de contenido — template del RFC

**Files:**
- Modify: `packages/catalog/templates/rfc-template.md`

- [ ] **Step 1: Reemplazar el template completo**

Sobreescribir `packages/catalog/templates/rfc-template.md`:

```markdown
---
architecture_mode: new | reuse | hybrid
codebase_status: greenfield | existing
existing_repo: <url o path — requerido si codebase_status=existing>
---

# RFC: <Título técnico>

**Autores:** <nombres>
**Fecha:** <YYYY-MM-DD>
**Estado:** draft
**PRD origen:** <link/path>

## Context

<1-3 párrafos. Por qué este RFC existe ahora. Cita el PRD, no lo copies.>

## Architecture context

### Architecture mode

<1-2 párrafos justificando new / reuse / hybrid. Si reuse: qué se extiende. Si new: por qué no se puede reusar.>

### Existing components reused

<Bullets. Si architecture_mode=new, escribir "Ninguno — arquitectura nueva."

- <componente 1 — path o referencia interna>
- <componente 2>

### Codebase context

<Si codebase_status=greenfield: nombre propuesto del repo + stack tentativo.
Si codebase_status=existing: paths/módulos relevantes y convenciones a respetar.>

### Integration points

<Obligatorio si architecture_mode ∈ {reuse, hybrid}. Permitido vacío si new.

- <contrato / API / evento 1>
- <contrato 2>

## Goals

- <objetivo técnico medible 1>
- <objetivo técnico medible 2>

## Non-goals

- <fuera de scope técnico explícito 1>
- <fuera de scope técnico explícito 2>

## Design

### Architecture overview

<Diagrama (mermaid/ASCII) + descripción de componentes.>

### Data model

<Schemas, ER, contratos. No prosa.>

### API / Contracts

<Endpoints, payloads, eventos.>

### Security

<AuthN/AuthZ, datos sensibles, secretos.>

### Performance

<SLAs, throughput esperado, hot paths.>

## Alternatives considered

1. **<Alternativa 1>** — Descartada porque <razón concreta>.
2. **<Alternativa 2>** — Descartada porque <razón concreta>.

## Risks

| Riesgo | Tipo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|---|
| <riesgo 1> | perf/sec/data/integ | L/M/H | L/M/H | |
| <riesgo 2> | | | | |
| <riesgo 3> | | | | |

## Rollout

- Fase 1 (<%>): <criterios de health, métricas a observar>
- Fase 2 (<%>): <criterios de avance>
- Fase 3 (100%): <gate final>

## Rollback

<Pasos ejecutables a las 3am. Cada paso con comando/acción concreta.>

1. <paso>
2. <paso>
3. <paso>

## Observability

- **Métricas:** <lista>
- **Logs:** <campos estructurados>
- **Alertas:** <thresholds y destinos>

## ADRs

- <link a ADR si hay decisión one-way>

## Open Questions

- <pregunta>
```

- [ ] **Step 2: Commit**

```bash
git add packages/catalog/templates/rfc-template.md
git commit -m "feat(catalog): RFC template adds frontmatter + Architecture context section"
```

---

## Task 11: Catálogo de contenido — actualizar fase `rfc-draft`

**Files:**
- Modify: `packages/catalog/roles/tech-lead/phases/rfc-draft.md`

- [ ] **Step 1: Actualizar `required_sections` + procedimiento**

Sobreescribir `packages/catalog/roles/tech-lead/phases/rfc-draft.md`:

```markdown
---
id: roles.tech-lead.phases.rfc-draft
version: 0.2.0
role: tech-lead
phase: rfc-draft
inputs: [prd_markdown]
outputs: [rfc_markdown]
required_sections:
  - context
  - architecture_context
  - goals
  - non_goals
  - design
  - risks
  - rollout
  - rollback
---

# Fase: Redacción del RFC

Tu tarea es producir un RFC técnico para un PRD ya aprobado.

Procedimiento:

1. Llama a `get_flow_state` y obtén la referencia al PRD.
2. Llama a `generate_rfc_skeleton` para tener un esqueleto pre-llenado con metadata del PRD.
3. Lee el template `rfc-template` y la skill `skill-rfc-template`.
4. **Clasificá el escenario antes de redactar el resto.** Completá el frontmatter YAML al inicio del RFC con valores reales (no placeholders):
   - `architecture_mode`: `new` si inaugurás una arquitectura, `reuse` si extendés una existente, `hybrid` si es mix.
   - `codebase_status`: `greenfield` si se crea un repo nuevo, `existing` si trabajás en uno existente.
   - `existing_repo`: URL o path — obligatorio cuando `codebase_status=existing`.
5. Completá la sección `## Architecture context` con sus 4 sub-secciones:
   - `### Architecture mode` — 1-2 párrafos justificando la elección.
   - `### Existing components reused` — bullets. Si `new`, escribí "Ninguno — arquitectura nueva."
   - `### Codebase context` — si `existing`, listá paths/módulos y convenciones a respetar; si `greenfield`, declará nombre propuesto y stack.
   - `### Integration points` — obligatorio si `reuse` o `hybrid`. Listá contratos, APIs, eventos, datos compartidos.
6. Completá cada sección restante. **No avances con secciones vacías.** Si falta input, preguntá al usuario.
7. Identificá decisiones one-way. Para cada una, decidí si necesita un ADR separado o queda inline.
8. La sección `rollback` es obligatoria y específica: pasos concretos, no "rollback del deploy".
9. La sección `risks` debe listar al menos 3 riesgos técnicos con probabilidad/impacto y mitigación.
10. Cuando termines, llama a `submit_rfc` con `flow_id`, el markdown y el path donde se commiteará en el repo. El server parsea tu frontmatter y persiste la clasificación en el flow.
11. Llama a `validate_rfc`. Corregí issues hasta que pase. Errores comunes:
    - "Missing YAML frontmatter" — agregá el bloque `---` al inicio.
    - "architecture_mode must be one of..." — usá uno de los 3 valores válidos.
    - "Integration points required when..." — completá la sub-sección.

No avances a shaping. Eso lo hace el PMO en una sesión separada con la tool `propose_breakdown`.
```

- [ ] **Step 2: Commit**

```bash
git add packages/catalog/roles/tech-lead/phases/rfc-draft.md
git commit -m "feat(catalog): rfc-draft phase guides architecture-context classification"
```

---

## Task 12: Catálogo — crear las 6 skills nuevas

**Files:**
- Create: 6 archivos en `packages/catalog/skills/`

- [ ] **Step 1: `skill-greenfield-implementation.md`**

Crear `packages/catalog/skills/skill-greenfield-implementation.md`:

```markdown
---
id: skill-greenfield-implementation
version: 0.1.0
---

# Skill: Bootstrap de implementación greenfield

Aplicable cuando `architecture_mode=new` o `codebase_status=greenfield`. Tu primera commit no es feature code: es un proyecto que arranca y otros pueden entender.

Checklist obligatorio antes del primer feature commit:

1. **Estructura base** — README.md con propósito + quickstart + license. `.editorconfig` y formateador del lenguaje (prettier, gofmt, ruff, etc.).
2. **CI mínimo** — workflow que corre lint + test + build en cada PR. Sin esto el repo no es revisable.
3. **ADR-0001** — `docs/adr/0001-stack-inicial.md` con: lenguaje + runtime + framework + storage + decisión clave única. Una frase por elección, con razón.
4. **Tests harness** — al menos un test trivial que corra en CI. Sin harness, los tests llegan tarde.
5. **Dependency hygiene** — lockfile commiteado. Versiones pinneadas o con tilde explícito.

Reglas:

- Antes de elegir lib o framework, busca si el equipo ya usa algo equivalente en otros repos. Si lo hay, justificá por qué desviás.
- No abras el primer PR sin pasar CI en local.
- Si introducís un patrón nuevo (DI, routing, ORM), documentalo en un ADR breve antes de adoptarlo en código.
```

- [ ] **Step 2: `skill-reuse-implementation.md`**

Crear `packages/catalog/skills/skill-reuse-implementation.md`:

```markdown
---
id: skill-reuse-implementation
version: 0.1.0
---

# Skill: Implementación con reuso de componentes existentes

Aplicable cuando `architecture_mode ∈ {reuse, hybrid}`. Tu trabajo es extender lo existente, no reemplazarlo.

Antes de escribir código:

1. **Mapeá lo referenciado** — abrí cada componente listado en `### Existing components reused` del RFC. Leé su API pública, sus tests, su última versión.
2. **Identificá los integration points** — confirmá que los contratos descritos en el RFC siguen vigentes en el código actual. Si cambiaron, paralizá y avisá al Tech Lead.
3. **Decidí por reuso, no por duplicación** — si encontrás una utility ya escrita que cubre un 80% de lo que necesitás, extendela en su package. No copies código a tu módulo.

Durante la implementación:

- Respetá los contratos públicos del componente reusado. Si necesitás cambiar la firma, eso requiere un sub-RFC o coordinación con el owner del componente.
- Si te tienta hacer un fork interno ("copio el módulo y lo modifico solo para este caso"), justificá el motivo en la descripción del PR y abrí un follow-up para consolidar.
- Tests: agregá los tuyos pero **no rompas los del componente reusado**. Si los rompiste, el cambio en el componente es responsabilidad tuya.

Antes de abrir el PR:

- Confirmá que ningún integration point quedó indocumentado (todos están en el RFC o en código autodescriptivo).
- Si introdujiste un wrapper alrededor del componente, justificá en el PR por qué no llamás directo.
```

- [ ] **Step 3: `skill-existing-codebase-conventions.md`**

Crear `packages/catalog/skills/skill-existing-codebase-conventions.md`:

```markdown
---
id: skill-existing-codebase-conventions
version: 0.1.0
---

# Skill: Respetar convenciones del codebase existente

Aplicable cuando `codebase_status=existing`. Antes de tu primer commit, descubrí "el estilo de la casa" y respetalo.

Inspección obligatoria antes de codear:

1. **Docs de contribución** — `CONTRIBUTING.md`, `docs/architecture.md`, `README.md`. Buscá reglas explícitas sobre branches, commits, PR templates.
2. **Tooling** — `.editorconfig`, `.prettierrc`, `.eslintrc`, `pyproject.toml`, `go.mod`. Conformá tu setup local antes de tocar nada.
3. **Estructura de directorios** — abrí 2 features comparables y leé cómo están organizadas. Imitá el layout (archivos por feature vs. por capa, ubicación de tests, naming).
4. **Tests** — leé 1-2 tests existentes del módulo que vas a tocar. Imitá el patrón (test framework, helpers, fixtures, mocking).
5. **Imports** — el orden y formato de imports. Si hay un patrón consistente (stdlib → 3rd party → local), respetalo.

Reglas:

- **No introduzcas libs nuevas** sin justificarlas. Si una utility similar ya está en `package.json` / `go.mod` / `pyproject.toml`, usá esa.
- **Naming** — si el repo usa `camelCase`, no metas `snake_case`. Si usa `kebab-case` en archivos, no metas `camelCase.ts`.
- **Logging y errores** — usá el wrapper que el resto del repo usa (`pino`, `zap`, `slog`, lo que sea). No metas `console.log` ni un logger paralelo.
- **Feature flags / config** — si hay un sistema, usalo. No leas `process.env` directo si todos los demás usan un módulo central.

Si encontrás algo del estilo de la casa que claramente está mal, abrí un issue separado. **No lo arregles en este PR**: scope creep.
```

- [ ] **Step 4: `skill-reuse-regression-checks.md`**

Crear `packages/catalog/skills/skill-reuse-regression-checks.md`:

```markdown
---
id: skill-reuse-regression-checks
version: 0.1.0
---

# Skill: Regression checks de QA cuando hay reuso

Aplicable cuando `architecture_mode ∈ {reuse, hybrid}`. El feature nuevo no es lo único a testear — los componentes reusados deben seguir funcionando.

Cobertura mínima:

1. **Camino nuevo del feature** — todos los AC del story.
2. **Regresión sobre componentes reusados** — para cada componente listado en `### Existing components reused` del RFC, ejecutá al menos un test representativo de su funcionalidad previa (usá su suite existente o un smoke específico).
3. **Contratos de integración** — para cada item de `### Integration points`, validá request/response (forma, status codes, error paths) y, si es event-driven, payload + side effects.
4. **SLA preexistente** — si el componente reusado tenía un SLA documentado (p99 latency, throughput), repetí la medición. Una degradación silenciosa cuenta como `failed`.

Reglas:

- Si descubrís que un componente reusado tiene tests rotos antes de tu cambio, **no los marques como failed del story actual**. Reportalo aparte (issue) y seguí. La excepción: si tu cambio los rompió.
- Evidencia obligatoria para regresiones: link al test run + diff de métricas si aplica.
- Si el componente reusado expone un health endpoint, incluí su validación pre/post deploy.
```

- [ ] **Step 5: `skill-reuse-review-checklist.md`**

Crear `packages/catalog/skills/skill-reuse-review-checklist.md`:

```markdown
---
id: skill-reuse-review-checklist
version: 0.1.0
---

# Skill: Code review checklist cuando hay reuso

Aplicable cuando `architecture_mode ∈ {reuse, hybrid}`. Verificá que el reuso declarado en el RFC se materializó en el código.

Bloqueadores típicos a buscar:

1. **Duplicación** — el PR contiene utilities o lógica que ya existe en uno de los componentes listados en `### Existing components reused`. Pedí reuso explícito.
2. **Wrappers innecesarios** — el PR envuelve un componente reusado en una clase/módulo nuevo sin agregar valor. Pedí justificación o eliminación.
3. **Ruptura de contratos públicos** — el PR modifica la API pública de un componente reusado sin coordinarlo. Si lo cambió, el RFC debería tener una sección sobre ese cambio.
4. **Fork interno** — el PR copió código del componente reusado a su propio módulo y lo modificó localmente. Pedí o reuso real, o un sub-RFC declarando el fork.
5. **Integration points no testeados** — para cada bullet de `### Integration points` del RFC, debe haber un test que lo cubra.

Cross-check obligatorio contra `### Integration points`:

- Cada contrato listado tiene su test correspondiente en el diff o ya estaba cubierto.
- Si el PR cambia un contrato declarado en el RFC, el RFC debería estar actualizado en el mismo PR (no en un follow-up).

Cuando encuentres alguno de estos, comentá como `Blocker (Required changes)`.
```

- [ ] **Step 6: `skill-codebase-consistency-review.md`**

Crear `packages/catalog/skills/skill-codebase-consistency-review.md`:

```markdown
---
id: skill-codebase-consistency-review
version: 0.1.0
---

# Skill: Code review checklist de consistencia con codebase existente

Aplicable cuando `codebase_status=existing`. El PR debe parecer escrito por alguien que conoce el repo.

Verificá:

1. **Naming y layering** — los archivos nuevos siguen el patrón del repo (kebab vs camel, ubicación, agrupación por feature vs por capa).
2. **Imports** — orden y agrupación consistentes con el resto del módulo.
3. **Logging y errores** — usa el wrapper estándar del repo. Sin `console.log` perdidos.
4. **Config / env** — usa el módulo central de config si existe. Sin `process.env` huérfanos en código de feature.
5. **Tests** — patrón de tests consistente (mismo framework, mismos helpers, ubicación correcta).
6. **Dependencias** — si el PR agrega una lib nueva, ¿se justificó? ¿hay una equivalente ya en el repo?

**Flag de "stack drift"** — un PR introduce silenciosamente una lib, un patrón o una abstracción nueva sin discusión:

- Una lib de HTTP/ORM/DI distinta a la que el resto del repo usa.
- Un patrón de async (callback en repo basado en promises, o RxJS en repo plain async/await).
- Una capa de abstracción nueva (DI container, mediator, repository pattern) cuando el repo no la usa en otros lugares.

Cuando detectes stack drift, comentá: "stack drift — el repo ya usa X para esto, ¿por qué Y?". Es bloqueante salvo que haya un ADR que lo justifique.

Nota: no es trabajo del reviewer reescribir convenciones. Si el "estilo de la casa" tiene un problema real, sugerí un issue/RFC separado, no fuerces el rework en este PR.
```

- [ ] **Step 7: Commit**

```bash
git add packages/catalog/skills/skill-greenfield-implementation.md packages/catalog/skills/skill-reuse-implementation.md packages/catalog/skills/skill-existing-codebase-conventions.md packages/catalog/skills/skill-reuse-regression-checks.md packages/catalog/skills/skill-reuse-review-checklist.md packages/catalog/skills/skill-codebase-consistency-review.md
git commit -m "feat(catalog): add 6 scenario skills for implementation/QA/review"
```

---

## Task 13: Catálogo — registrar skills nuevas + scenario_skills + bump de versión

**Files:**
- Modify: `packages/catalog/catalog.yaml`

- [ ] **Step 1: Reemplazar el archivo completo**

Sobreescribir `packages/catalog/catalog.yaml`:

```yaml
schema: 1
catalog_version: 0.3.0

roles:
  product-manager:
    role_prompt: roles/product-manager/role.md
    version: 0.1.0
    phases:
      prd-discovery:
        path: roles/product-manager/phases/prd-discovery.md
        version: 0.1.0
        skills: []
        templates: []
      prd-draft:
        path: roles/product-manager/phases/prd-draft.md
        version: 0.1.0
        skills:
          - skill-prd-template
        templates:
          - prd-template
      prd-validate:
        path: roles/product-manager/phases/prd-validate.md
        version: 0.1.0
        skills: []
        templates: []

  tech-lead:
    role_prompt: roles/tech-lead/role.md
    version: 0.1.0
    phases:
      rfc-draft:
        path: roles/tech-lead/phases/rfc-draft.md
        version: 0.2.0
        skills:
          - skill-rfc-template
        templates:
          - rfc-template
      rfc-validate:
        path: roles/tech-lead/phases/rfc-validate.md
        version: 0.1.0
        skills: []
        templates: []

  pmo:
    role_prompt: roles/pmo/role.md
    version: 0.1.0
    phases:
      shaping:
        path: roles/pmo/phases/shaping.md
        version: 0.1.0
        skills:
          - skill-story-shaping
        templates:
          - breakdown-template

  developer:
    role_prompt: roles/developer/role.md
    version: 0.1.0
    phases:
      implement:
        path: roles/developer/phases/implement.md
        version: 0.1.0
        skills:
          - skill-implementation-checklist
        templates: []

  qa:
    role_prompt: roles/qa/role.md
    version: 0.1.0
    phases:
      qa:
        path: roles/qa/phases/qa.md
        version: 0.1.0
        skills:
          - skill-qa-plan
        templates:
          - qa-plan-template

  reviewer:
    role_prompt: roles/reviewer/role.md
    version: 0.1.0
    phases:
      review:
        path: roles/reviewer/phases/review.md
        version: 0.1.0
        skills:
          - skill-code-review-checklist
        templates: []

skills:
  skill-prd-template:
    path: skills/skill-prd-template.md
    version: 0.1.0
  skill-rfc-template:
    path: skills/skill-rfc-template.md
    version: 0.1.0
  skill-story-shaping:
    path: skills/skill-story-shaping.md
    version: 0.1.0
  skill-implementation-checklist:
    path: skills/skill-implementation-checklist.md
    version: 0.1.0
  skill-qa-plan:
    path: skills/skill-qa-plan.md
    version: 0.1.0
  skill-code-review-checklist:
    path: skills/skill-code-review-checklist.md
    version: 0.1.0
  skill-greenfield-implementation:
    path: skills/skill-greenfield-implementation.md
    version: 0.1.0
  skill-reuse-implementation:
    path: skills/skill-reuse-implementation.md
    version: 0.1.0
  skill-existing-codebase-conventions:
    path: skills/skill-existing-codebase-conventions.md
    version: 0.1.0
  skill-reuse-regression-checks:
    path: skills/skill-reuse-regression-checks.md
    version: 0.1.0
  skill-reuse-review-checklist:
    path: skills/skill-reuse-review-checklist.md
    version: 0.1.0
  skill-codebase-consistency-review:
    path: skills/skill-codebase-consistency-review.md
    version: 0.1.0

templates:
  prd-template:
    path: templates/prd-template.md
    version: 0.1.0
  rfc-template:
    path: templates/rfc-template.md
    version: 0.2.0
  qa-plan-template:
    path: templates/qa-plan-template.md
    version: 0.1.0
  breakdown-template:
    path: templates/breakdown-template.md
    version: 0.1.0

scenario_skills:
  developer.implement:
    architecture_mode:
      new: [skill-greenfield-implementation]
      reuse: [skill-reuse-implementation]
      hybrid: [skill-greenfield-implementation, skill-reuse-implementation]
    codebase_status:
      greenfield: []
      existing: [skill-existing-codebase-conventions]
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
      greenfield: []
      existing: [skill-codebase-consistency-review]
```

- [ ] **Step 2: Commit**

```bash
git add packages/catalog/catalog.yaml
git commit -m "feat(catalog): register scenario skills + bump catalog_version to 0.3.0"
```

---

## Task 14: Tests del catalog — scenario_skills merging

**Files:**
- Create: `apps/server/test/scenario-skills.test.ts`

- [ ] **Step 1: Escribir tests**

Crear `apps/server/test/scenario-skills.test.ts`:

```ts
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Catalog } from '@sdlc/catalog';

const CATALOG_ROOT = resolve(__dirname, '../../../packages/catalog');

describe('catalog — scenario_skills', () => {
  it('developer.implement with architecture_mode=reuse adds skill-reuse-implementation', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const bundle = await catalog.getRolePrompt('developer', 'implement', {
      architecture_mode: 'reuse',
    });
    const ids = bundle.skills.map((s) => s.id);
    expect(ids).toContain('skill-implementation-checklist');
    expect(ids).toContain('skill-reuse-implementation');
    expect(ids).not.toContain('skill-greenfield-implementation');
  });

  it('developer.implement with architecture_mode=hybrid + codebase_status=existing adds three extras', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const bundle = await catalog.getRolePrompt('developer', 'implement', {
      architecture_mode: 'hybrid',
      codebase_status: 'existing',
    });
    const ids = bundle.skills.map((s) => s.id);
    expect(ids).toContain('skill-greenfield-implementation');
    expect(ids).toContain('skill-reuse-implementation');
    expect(ids).toContain('skill-existing-codebase-conventions');
  });

  it('developer.implement without scenario returns only base skills', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const bundle = await catalog.getRolePrompt('developer', 'implement');
    const ids = bundle.skills.map((s) => s.id);
    expect(ids).toEqual(['skill-implementation-checklist']);
  });

  it('qa.qa with architecture_mode=new returns only base skill', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const bundle = await catalog.getRolePrompt('qa', 'qa', { architecture_mode: 'new' });
    const ids = bundle.skills.map((s) => s.id);
    expect(ids).toEqual(['skill-qa-plan']);
  });

  it('reviewer.review with architecture_mode=reuse + codebase_status=existing adds both extras', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const bundle = await catalog.getRolePrompt('reviewer', 'review', {
      architecture_mode: 'reuse',
      codebase_status: 'existing',
    });
    const ids = bundle.skills.map((s) => s.id);
    expect(ids).toContain('skill-code-review-checklist');
    expect(ids).toContain('skill-reuse-review-checklist');
    expect(ids).toContain('skill-codebase-consistency-review');
  });

  it('skills are merged without duplicates', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const bundle = await catalog.getRolePrompt('developer', 'implement', {
      architecture_mode: 'hybrid',
      codebase_status: 'existing',
    });
    const ids = bundle.skills.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

- [ ] **Step 2: Correr los tests**

Run:
```bash
pnpm --filter @sdlc/catalog build && pnpm --filter @sdlc/server test -- scenario-skills
```
Expected: 6/6 PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/server/test/scenario-skills.test.ts
git commit -m "test(server): cover scenario_skills merging in catalog.getRolePrompt"
```

---

## Task 15: `get_role_prompt` — aceptar `flow_id` y pasar `ScenarioContext`

**Files:**
- Modify: `apps/server/src/mcp/tools/get-role-prompt.ts`

- [ ] **Step 1: Aceptar `flow_id` opcional y mergear scenario skills desde el flow**

Reemplazar `apps/server/src/mcp/tools/get-role-prompt.ts` completo:

```ts
import { z } from 'zod';
import { Catalog, type ScenarioContext } from '@sdlc/catalog';
import { PhaseId, RoleId } from '@sdlc/core';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';

export const GetRolePromptInput = z.object({
  role: RoleId,
  phase: PhaseId,
  flow_id: z.string().min(1).optional(),
});
export type GetRolePromptInput = z.infer<typeof GetRolePromptInput>;

export function makeGetRolePromptTool(catalog: Catalog, store: FlowStore) {
  return {
    name: 'get_role_prompt',
    description:
      'Returns the system prompt, skills and templates that the IDE-side agent must inject for the given role+phase. If flow_id is supplied and the flow has architecture_mode/codebase_status set (populated at submit_rfc), additional scenario skills are merged into the bundle.',
    inputSchema: GetRolePromptInput,
    handler: async (input: GetRolePromptInput, ctx: TenantCtx) => {
      let scenario: ScenarioContext | undefined;
      if (input.flow_id) {
        const flow = await store.getFlow(input.flow_id);
        if (!flow) return { ok: false, error: `Unknown flow: ${input.flow_id}` };
        if (flow.tenant_id !== ctx.tenantId) {
          return { ok: false, error: 'Flow belongs to a different tenant' };
        }
        scenario = {
          architecture_mode: flow.architecture_mode,
          codebase_status: flow.codebase_status,
        };
      }
      const bundle = await catalog.getRolePrompt(input.role, input.phase, scenario);
      return {
        ok: true,
        data: bundle,
        next_actions: nextActionsFor(input.role, input.phase),
      };
    },
  };
}

function nextActionsFor(role: RoleId, phase: PhaseId): string[] {
  if (role === 'product-manager' && phase === 'prd-draft') {
    return ['submit_prd', 'validate_prd'];
  }
  if (role === 'tech-lead' && phase === 'rfc-draft') {
    return ['generate_rfc_skeleton', 'submit_rfc', 'validate_rfc'];
  }
  return [];
}
```

- [ ] **Step 2: Actualizar el callsite del registry para pasar `store`**

Editar `apps/server/src/mcp/tools/index.ts:41`. Reemplazar:

```ts
    makeGetRolePromptTool(catalog) as unknown as ToolDef,
```

Por:

```ts
    makeGetRolePromptTool(catalog, store) as unknown as ToolDef,
```

- [ ] **Step 3: Typecheck**

Run:
```bash
pnpm --filter @sdlc/server typecheck
```
Expected: pasa.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/mcp/tools/get-role-prompt.ts apps/server/src/mcp/tools/index.ts
git commit -m "feat(server): get_role_prompt accepts flow_id and merges scenario skills"
```

---

## Task 16: Catálogo de prompts — mencionar scenario skills en implement/qa/review

**Files:**
- Modify: `packages/catalog/roles/developer/phases/implement.md`
- Modify: `packages/catalog/roles/qa/phases/qa.md`
- Modify: `packages/catalog/roles/reviewer/phases/review.md`

- [ ] **Step 1: Implement — agregar mención al inicio del procedimiento**

Editar `packages/catalog/roles/developer/phases/implement.md`. Después del bloque frontmatter y antes de "Tu tarea es...", reemplazar el bullet "1. Llama a `claim_story...`" para que mencione las scenario skills:

Buscar:
```
1. Llama a `claim_story({story_id, developer_id})`. El server devuelve:
   - El RFC excerpt relevante (sección design + risks).
   - La historia completa con sus AC.
   - Hint de archivos relacionados (cuando aplique).
   - Esta skill + `skill-implementation-checklist`.
```

Reemplazar por:
```
1. Llama a `claim_story({story_id, developer_id})`. El server devuelve:
   - El RFC excerpt relevante (sección design + risks).
   - La historia completa con sus AC.
   - Hint de archivos relacionados (cuando aplique).
   - Esta skill + `skill-implementation-checklist` + skills adicionales según `architecture_mode` y `codebase_status` del flow (ej: `skill-reuse-implementation`, `skill-existing-codebase-conventions`). Leelas todas antes de empezar.
```

- [ ] **Step 2: QA — análogo**

Editar `packages/catalog/roles/qa/phases/qa.md`. Buscar:
```
1. Llama a `get_implementation_context({story_id})` para tener acceptance criteria + RFC excerpt + pr_url.
```

Reemplazar por:
```
1. Llama a `get_implementation_context({story_id})` para tener acceptance criteria + RFC excerpt + pr_url. El bundle puede incluir skills adicionales (ej: `skill-reuse-regression-checks`) según `architecture_mode` del flow — aplicalas.
```

- [ ] **Step 3: Review — análogo**

Editar `packages/catalog/roles/reviewer/phases/review.md`. Buscar:
```
1. Llama a `request_code_review({pr_url, story_id})`. El server devuelve:
   - El RFC excerpt relevante.
   - Los AC de la historia.
   - Esta skill + `skill-code-review-checklist`.
   - QA results (si están).
```

Reemplazar por:
```
1. Llama a `request_code_review({pr_url, story_id})`. El server devuelve:
   - El RFC excerpt relevante.
   - Los AC de la historia.
   - Esta skill + `skill-code-review-checklist` + skills adicionales según `architecture_mode`/`codebase_status` (ej: `skill-reuse-review-checklist`, `skill-codebase-consistency-review`).
   - QA results (si están).
```

- [ ] **Step 4: Commit**

```bash
git add packages/catalog/roles/developer/phases/implement.md packages/catalog/roles/qa/phases/qa.md packages/catalog/roles/reviewer/phases/review.md
git commit -m "docs(catalog): mention scenario skills in implement/qa/review prompts"
```

---

## Task 17: Actualizar smoke test del catálogo a `0.3.0`

**Files:**
- Modify: `apps/server/test/catalog.smoke.test.ts:14-17`

- [ ] **Step 1: Bump version assertion + sumar caso de scenario_skills**

Editar `apps/server/test/catalog.smoke.test.ts`. Reemplazar:

```ts
  it('catalog_version reflects the 0.2 expansion', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    expect(catalog.version).toBe('0.2.0');
  });
```

Por:

```ts
  it('catalog_version reflects the 0.3 architecture-context expansion', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    expect(catalog.version).toBe('0.3.0');
  });
```

- [ ] **Step 2: Correr el smoke test**

Run:
```bash
pnpm --filter @sdlc/server test -- catalog.smoke
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/server/test/catalog.smoke.test.ts
git commit -m "test(server): bump catalog version assertion to 0.3.0"
```

---

## Task 18: Flow happy-path test actualizado al nuevo template

**Files:**
- Modify: `apps/server/test/flow.test.ts`

- [ ] **Step 1: Actualizar `VALID_RFC` con frontmatter + Architecture context**

Editar `apps/server/test/flow.test.ts`. Reemplazar `VALID_RFC` (líneas 52-84) por:

```ts
const VALID_RFC = `---
architecture_mode: reuse
codebase_status: existing
existing_repo: https://github.com/acme/checkout
---

# RFC: Pago en cuotas

## Context
Implementar el feature definido en el PRD del 2026-05-09.

## Architecture context

### Architecture mode
Reusamos la arquitectura existente del servicio checkout. No introducimos nuevos runtimes.

### Existing components reused
- packages/checkout/service
- packages/payments/api

### Codebase context
Monorepo TypeScript pnpm + turbo. Convenciones de naming kebab-case. Tests con vitest.

### Integration points
- Eventos checkout.order.created
- API REST POST /payments/installments

## Goals
- Pagos en 3/6/12 cuotas, p99 < 800ms en checkout.

## Non-goals
- Refinanciación post-compra.

## Design
Usaremos el processor X con webhook idempotente.
Tabla payments_plans nueva con migración online.
Frontend agrega selector de cuotas en step 3 del checkout.

## Risks
| Riesgo | Tipo | Probabilidad | Impacto | Mitigación |
| Webhook drop | integ | M | H | Cola de retry |
| Migración bloqueante | data | L | H | Backfill async |
| Costo por txn | perf | M | M | Cap por cliente |

## Rollout
- Canary 5% durante 48h.
- 25% durante 72h con health checks.
- 100%.

## Rollback
1. Feature flag off via dashboard.
2. Worker drena cola pendiente.
3. Revertir migración no destructiva.
`;
```

- [ ] **Step 2: Sumar assertion de architecture_mode/codebase_status en el happy path**

En el test `'full PRD → RFC happy path advances through both phases'`, después del bloque que verifica el `state`, sumá:

```ts
    expect(state.data?.flow.architecture_mode).toBe('reuse');
    expect(state.data?.flow.codebase_status).toBe('existing');
    expect(state.data?.flow.existing_repo).toBe('https://github.com/acme/checkout');
```

- [ ] **Step 3: Sumar un caso nuevo de regresión: RFC sin frontmatter falla**

Al final del describe block, antes del `'rejects flow access...'`, agregá:

```ts
  it('submit_rfc fails validation when frontmatter is missing', async () => {
    const { call } = await setup();
    const start = await call<{ flow_id: string }>('start_flow', {
      project: 'checkout',
      title: 'No frontmatter',
    });
    const flow_id = start.data!.flow_id;
    await call('submit_prd', { flow_id, prd_markdown: VALID_PRD, repo_path: '/docs/prd/c.md' });

    const rfcSinFrontmatter = VALID_RFC.replace(/^---[\s\S]*?---\n\n/, '');
    const res = await call<{ flow: { status: string }; validation: { ok: boolean; issues: { message: string }[] } }>(
      'submit_rfc',
      { flow_id, rfc_markdown: rfcSinFrontmatter, repo_path: '/docs/rfc/x.md' },
    );
    expect(res.ok).toBe(false);
    expect(res.data?.validation.issues.some((i) => i.message.includes('frontmatter'))).toBe(true);
    expect(res.data?.flow.status).toBe('prd_ready');
  });
```

- [ ] **Step 4: Correr el suite completo**

Run:
```bash
pnpm --filter @sdlc/server test
```
Expected: todos los tests pasan (los nuevos y los existentes).

- [ ] **Step 5: Commit**

```bash
git add apps/server/test/flow.test.ts
git commit -m "test(server): RFC happy path covers architecture_mode/codebase_status"
```

---

## Task 19: Actualizar el fixture del example end-to-end

**Files:**
- Modify: `examples/01-prd-rfc/fixtures/rfc.md`

- [ ] **Step 1: Leer el fixture actual**

Run:
```bash
cat examples/01-prd-rfc/fixtures/rfc.md
```

- [ ] **Step 2: Agregar frontmatter + sección Architecture context al fixture**

Editar `examples/01-prd-rfc/fixtures/rfc.md`. Al inicio del archivo (antes de `# RFC:`), agregar el bloque:

```markdown
---
architecture_mode: reuse
codebase_status: existing
existing_repo: https://github.com/acme/checkout
---

```

Y después de la sección `## Context` (antes de `## Goals`), agregar:

```markdown
## Architecture context

### Architecture mode
Reusamos la arquitectura existente del servicio checkout.

### Existing components reused
- packages/checkout/service
- packages/payments/api

### Codebase context
Monorepo TypeScript pnpm + turbo. Tests vitest.

### Integration points
- Eventos checkout.order.created
- API REST POST /payments/installments

```

- [ ] **Step 3: Correr el smoke e2e (solo si tenés tiempo / un server local)**

Run:
```bash
./examples/01-prd-rfc/run.sh
```
Expected: el flow llega a `rfc_ready` y `get_flow_state` devuelve `architecture_mode: "reuse"`.

Si no podés correrlo (no hay server local), saltealo — los tests cubren el comportamiento.

- [ ] **Step 4: Commit**

```bash
git add examples/01-prd-rfc/fixtures/rfc.md
git commit -m "test(examples): RFC fixture includes architecture-context block"
```

---

## Task 20: Integration test Postgres — los nuevos campos persisten

**Files:**
- Modify: `apps/server/test/postgres-flow-store.integration.test.ts`

- [ ] **Step 1: Leer el test de integración existente**

Run:
```bash
cat apps/server/test/postgres-flow-store.integration.test.ts
```

- [ ] **Step 2: Agregar un caso que actualice los 3 campos y los re-lea**

Al final del archivo (dentro del último `describe`), agregar:

```ts
  it('persists architecture_mode, codebase_status, existing_repo across reads', async () => {
    const flow = await store.createFlow({
      tenant_id: 'demo-tenant',
      project: 'arch-test',
      slug: 'a',
      title: 'a',
    });
    await store.updateFlow(flow.flow_id, {
      architecture_mode: 'hybrid',
      codebase_status: 'existing',
      existing_repo: 'https://github.com/acme/x',
    });
    const fresh = await store.getFlow(flow.flow_id);
    expect(fresh?.architecture_mode).toBe('hybrid');
    expect(fresh?.codebase_status).toBe('existing');
    expect(fresh?.existing_repo).toBe('https://github.com/acme/x');
  });
```

- [ ] **Step 3: Correr el test con TEST_DATABASE_URL (si está disponible)**

Run:
```bash
TEST_DATABASE_URL="postgres://sdlc:sdlc@localhost:5432/sdlc_test" \
  pnpm --filter @sdlc/server test -- postgres-flow-store
```
Expected: PASS. Si no tenés Postgres local, el test se skippea (es el patrón actual del repo) — sin error.

**Importante:** antes de correr esto, asegurate de aplicar la migration 0001:
```bash
TEST_DATABASE_URL="postgres://sdlc:sdlc@localhost:5432/sdlc_test" \
  DATABASE_URL="$TEST_DATABASE_URL" \
  pnpm --filter @sdlc/server db:migrate
```

- [ ] **Step 4: Commit**

```bash
git add apps/server/test/postgres-flow-store.integration.test.ts
git commit -m "test(server): integration coverage for architecture_mode in PostgresFlowStore"
```

---

## Task 21: Build & test final + push

**Files:** ninguno.

- [ ] **Step 1: Clean build de todo el monorepo**

Run:
```bash
pnpm turbo run build
```
Expected: todos los packages buildan sin errores.

- [ ] **Step 2: Typecheck completo**

Run:
```bash
pnpm turbo run typecheck
```
Expected: pasa en todos los packages.

- [ ] **Step 3: Test suite completo**

Run:
```bash
pnpm turbo run test
```
Expected: todos los tests pasan. Los que requieren Postgres se skippean si `TEST_DATABASE_URL` no está seteado.

- [ ] **Step 4: Verificación visual del flow estado en runtime (opcional)**

Si tenés un dev server corriendo (`pnpm --filter @sdlc/server dev`), ejecutá un flow completo:
- `start_flow` → `submit_prd` (con PRD válido del fixture) → `submit_rfc` (con el RFC nuevo del fixture).
- `get_flow_state` debe devolver `architecture_mode`, `codebase_status`, `existing_repo` poblados.
- `get_role_prompt({role:"developer", phase:"implement", flow_id})` debe devolver el bundle con `skill-reuse-implementation` + `skill-existing-codebase-conventions`.

- [ ] **Step 5: No commit final si todo ya fue commiteado por las tasks anteriores**

Verificar con `git status` que `working tree clean`. Si quedó algún archivo sin commitear, revisar y commitear ad-hoc.

---

## Checklist final de cobertura del spec

- [x] **Task 1** — `Flow` zod schema extendido (cubre §"Flow state — nuevos campos" del spec).
- [x] **Task 2-5** — `UpdateFlowInput` + Drizzle schema + migration + InMemory + Postgres impl (cubre §"Flow state — nuevos campos").
- [x] **Task 6-7** — Frontmatter parser + validador extendido (cubre §"Cambios en el RFC" + §"Validación (validate_rfc)").
- [x] **Task 8** — `submit_rfc` parsea y persiste (cubre §"Cambios en el RFC" / wiring).
- [x] **Task 9** — Catalog schema + `getRolePrompt` con scenario (cubre §"Resolución de skills por escenario").
- [x] **Task 10** — Template RFC actualizado (cubre §"Cambios en el RFC").
- [x] **Task 11** — Phase prompt `rfc-draft` (cubre §"Actualizaciones de prompts de fase" + UX).
- [x] **Task 12** — 6 skills nuevas (cubre §"Skills nuevas").
- [x] **Task 13** — `catalog.yaml` registra skills + `scenario_skills` + bump (cubre §"catalog.yaml — sección scenario_skills" + bump 0.3.0).
- [x] **Task 14-15** — Tests + `get_role_prompt` tool wired (cubre §"Resolución de skills por escenario" + §"get_role_prompt").
- [x] **Task 16** — Phase prompts implement/qa/review actualizados (cubre §"Actualizaciones de prompts de fase").
- [x] **Task 17-20** — Tests actualizados + smoke fixture (cubre observabilidad básica + rollout).
- [x] **Task 21** — Build/test gate final.

Sin tareas para "Observability" del spec (`mcp_get_role_prompt_with_flow_total` metric) — explícitamente trabajo futuro de Fase 5, no este plan.
