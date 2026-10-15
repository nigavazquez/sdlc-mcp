# Implementation & QA Tools (Fase 3 slice 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the 6 MCP tools that close the developer↔QA loop (`claim_story`, `report_progress`, `get_implementation_context`, `generate_qa_plan`, `submit_qa_results`, `block_story`), backed by a new `stories` table with explicit FSM and server-driven side-effects on the InMemory task-system adapter.

**Architecture:** Per-story state lives in a new `stories` table managed by `FlowStore`. State transitions go through a pure FSM (`apps/server/src/stories/transitions.ts`). Each tool: validates tenant, runs FSM guard, calls `taskSystem.transition()` for the corresponding Azure DevOps status, updates the row, appends a flow event. QA plan generation is a deterministic pure function over the story's acceptance criteria.

**Tech Stack:** TypeScript strict, zod, vitest, drizzle-orm + postgres-js (for Postgres impl), MCP SDK, fastify (server entry already wired).

**Reference:** spec at `docs/superpowers/specs/2026-06-02-implementation-qa-tools-design.md`.

---

## File Structure

**Create:**
- `packages/core/src/story.ts` — zod schemas (`StoryStatus`, `Story`, `StoryQaCase`, `StoryQaPlan`, `StoryQaResult`).
- `apps/server/src/stories/transitions.ts` — FSM table + `canTransition`.
- `apps/server/src/stories/qa-plan.ts` — pure plan generator.
- `apps/server/src/stories/index.ts` — barrel.
- `apps/server/src/mcp/tools/claim-story.ts`
- `apps/server/src/mcp/tools/report-progress.ts`
- `apps/server/src/mcp/tools/get-implementation-context.ts`
- `apps/server/src/mcp/tools/generate-qa-plan.ts`
- `apps/server/src/mcp/tools/submit-qa-results.ts`
- `apps/server/src/mcp/tools/block-story.ts`
- `apps/server/migrations/0002_stories.sql`
- `apps/server/test/story-transitions.test.ts`
- `apps/server/test/qa-plan.test.ts`
- `apps/server/test/in-memory-stories.test.ts`
- `apps/server/test/implementation-qa.test.ts`

**Modify:**
- `packages/core/src/index.ts` — re-export `./story.js`.
- `apps/server/src/state/store.ts` — extend `FlowStore` with story methods + input types.
- `apps/server/src/state/in-memory.ts` — implement story methods.
- `apps/server/src/state/schema.ts` — add `stories` drizzle table.
- `apps/server/src/state/postgres.ts` — implement story methods.
- `apps/server/src/mcp/tools/create-stories.ts` — also persist each story row.
- `apps/server/src/mcp/tools/index.ts` — register 6 new tools.
- `packages/catalog/roles/developer/phases/implement.md` — version bump + signature clarifications.
- `packages/catalog/roles/qa/phases/qa.md` — version bump + signature clarifications.
- `packages/catalog/catalog.yaml` — version bumps.

---

## Task 1: Core types (`@sdlc/core`)

**Files:**
- Create: `packages/core/src/story.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Create the types file**

Write to `packages/core/src/story.ts`:

```ts
import { z } from 'zod';

export const StoryStatus = z.enum([
  'created',
  'claimed',
  'in_progress',
  'in_review',
  'qa_passed',
  'blocked',
  'merged',
]);
export type StoryStatus = z.infer<typeof StoryStatus>;

export const StoryQaCase = z.object({
  case_id: z.string().min(1),
  description: z.string().min(1),
  ac_ref: z.string().optional(),
  type: z.enum(['ac', 'edge', 'perf']),
});
export type StoryQaCase = z.infer<typeof StoryQaCase>;

export const StoryQaPlan = z.object({
  cases: z.array(StoryQaCase).min(1),
  generated_at: z.string(),
});
export type StoryQaPlan = z.infer<typeof StoryQaPlan>;

export const StoryQaResult = z.object({
  case_id: z.string().min(1),
  status: z.enum(['passed', 'failed']),
  evidence_url: z.string().optional(),
  notes: z.string().optional(),
});
export type StoryQaResult = z.infer<typeof StoryQaResult>;

export const QaVerdict = z.enum(['passed', 'blocked']);
export type QaVerdict = z.infer<typeof QaVerdict>;

export const Story = z.object({
  story_id: z.string().min(1),
  flow_id: z.string().min(1),
  external_id: z.string().min(1),
  external_url: z.string().min(1),
  title: z.string().min(1),
  acceptance_criteria: z.array(z.string()),
  status: StoryStatus,
  assignee: z.string().optional(),
  pr_url: z.string().optional(),
  qa_plan: StoryQaPlan.optional(),
  qa_verdict: QaVerdict.optional(),
  qa_block_reason: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Story = z.infer<typeof Story>;
```

- [ ] **Step 2: Re-export from the core barrel**

Edit `packages/core/src/index.ts` so it reads:

```ts
export * from './roles.js';
export * from './flow.js';
export * from './artifacts.js';
export * from './shaping.js';
export * from './story.js';
```

- [ ] **Step 3: Type-check the package**

Run: `pnpm --filter @sdlc/core build`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/story.ts packages/core/src/index.ts
git commit -m "feat(core): add Story / StoryStatus / StoryQaPlan zod schemas"
```

---

## Task 2: FSM transitions (pure module + tests)

**Files:**
- Create: `apps/server/src/stories/transitions.ts`
- Create: `apps/server/src/stories/index.ts`
- Test: `apps/server/test/story-transitions.test.ts`

- [ ] **Step 1: Write the failing test**

Write to `apps/server/test/story-transitions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canTransition, listAllowedTargets } from '../src/stories/transitions.js';
import type { StoryStatus } from '@sdlc/core';

describe('story FSM', () => {
  it('allows the documented transitions', () => {
    expect(canTransition('created', 'claimed')).toBe(true);
    expect(canTransition('claimed', 'in_progress')).toBe(true);
    expect(canTransition('claimed', 'in_review')).toBe(true);
    expect(canTransition('in_progress', 'in_review')).toBe(true);
    expect(canTransition('in_review', 'qa_passed')).toBe(true);
    expect(canTransition('in_review', 'blocked')).toBe(true);
    expect(canTransition('blocked', 'in_progress')).toBe(true);
    expect(canTransition('blocked', 'in_review')).toBe(true);
  });

  it('rejects invalid transitions', () => {
    expect(canTransition('created', 'in_review')).toBe(false);
    expect(canTransition('created', 'qa_passed')).toBe(false);
    expect(canTransition('qa_passed', 'in_review')).toBe(false);
    expect(canTransition('qa_passed', 'blocked')).toBe(false);
    expect(canTransition('claimed', 'qa_passed')).toBe(false);
    expect(canTransition('in_progress', 'qa_passed')).toBe(false);
    expect(canTransition('blocked', 'qa_passed')).toBe(false);
  });

  it('listAllowedTargets returns the expected set for each state', () => {
    expect(new Set(listAllowedTargets('created'))).toEqual(new Set<StoryStatus>(['claimed']));
    expect(new Set(listAllowedTargets('blocked'))).toEqual(
      new Set<StoryStatus>(['in_progress', 'in_review']),
    );
    expect(listAllowedTargets('qa_passed')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @sdlc/server vitest run test/story-transitions.test.ts`
Expected: FAIL — cannot import from `../src/stories/transitions.js`.

- [ ] **Step 3: Implement the FSM**

Write to `apps/server/src/stories/transitions.ts`:

```ts
import type { StoryStatus } from '@sdlc/core';

const TRANSITIONS: Record<StoryStatus, StoryStatus[]> = {
  created: ['claimed'],
  claimed: ['in_progress', 'in_review'],
  in_progress: ['in_review'],
  in_review: ['qa_passed', 'blocked'],
  qa_passed: [],
  blocked: ['in_progress', 'in_review'],
  merged: [],
};

export function canTransition(from: StoryStatus, to: StoryStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function listAllowedTargets(from: StoryStatus): StoryStatus[] {
  return [...TRANSITIONS[from]];
}
```

Write to `apps/server/src/stories/index.ts`:

```ts
export * from './transitions.js';
export * from './qa-plan.js';
```

(The barrel references `qa-plan.js` which doesn't exist yet — Task 3 adds it. TypeScript will fail to build until then; that's fine because we run tests with vitest's per-file resolver. If the barrel breaks the test, drop the `qa-plan.js` line for now and re-add it in Task 3.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @sdlc/server vitest run test/story-transitions.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/stories/transitions.ts apps/server/src/stories/index.ts apps/server/test/story-transitions.test.ts
git commit -m "feat(server): story FSM transition table + canTransition helper"
```

---

## Task 3: QA plan generator (pure module + tests)

**Files:**
- Create: `apps/server/src/stories/qa-plan.ts`
- Test: `apps/server/test/qa-plan.test.ts`

- [ ] **Step 1: Write the failing test**

Write to `apps/server/test/qa-plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { generateQaPlan } from '../src/stories/qa-plan.js';

describe('generateQaPlan', () => {
  it('produces one AC case per criterion plus 2 edge cases', () => {
    const plan = generateQaPlan(['User can log in', 'Failed login shows error', 'p99 < 500ms']);
    expect(plan.cases).toHaveLength(5);
    expect(plan.cases.slice(0, 3).map((c) => c.case_id)).toEqual(['AC-1', 'AC-2', 'AC-3']);
    expect(plan.cases.slice(0, 3).every((c) => c.type === 'ac')).toBe(true);
    expect(plan.cases[0]?.description).toBe('User can log in');
    expect(plan.cases[0]?.ac_ref).toBe('AC-1');
    expect(plan.cases[3]?.case_id).toBe('EDGE-1');
    expect(plan.cases[4]?.case_id).toBe('EDGE-2');
    expect(plan.cases[3]?.type).toBe('edge');
  });

  it('still emits the 2 edge cases when there are no ACs', () => {
    const plan = generateQaPlan([]);
    expect(plan.cases.map((c) => c.case_id)).toEqual(['EDGE-1', 'EDGE-2']);
  });

  it('sets generated_at to an ISO string', () => {
    const plan = generateQaPlan(['x']);
    expect(() => new Date(plan.generated_at).toISOString()).not.toThrow();
    expect(plan.generated_at).toBe(new Date(plan.generated_at).toISOString());
  });

  it('is deterministic for the same input (modulo timestamp)', () => {
    const a = generateQaPlan(['a', 'b']);
    const b = generateQaPlan(['a', 'b']);
    expect(a.cases).toEqual(b.cases);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @sdlc/server vitest run test/qa-plan.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the generator**

Write to `apps/server/src/stories/qa-plan.ts`:

```ts
import type { StoryQaCase, StoryQaPlan } from '@sdlc/core';

export function generateQaPlan(acceptanceCriteria: string[]): StoryQaPlan {
  const cases: StoryQaCase[] = [];
  acceptanceCriteria.forEach((text, i) => {
    const ref = `AC-${i + 1}`;
    cases.push({ case_id: ref, description: text, ac_ref: ref, type: 'ac' });
  });
  cases.push({
    case_id: 'EDGE-1',
    description: 'Boundary / empty / max input value',
    type: 'edge',
  });
  cases.push({
    case_id: 'EDGE-2',
    description: 'Concurrent or duplicate request handling',
    type: 'edge',
  });
  return { cases, generated_at: new Date().toISOString() };
}
```

If the barrel `apps/server/src/stories/index.ts` was trimmed in Task 2, restore the `qa-plan.js` export now.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @sdlc/server vitest run test/qa-plan.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/stories/qa-plan.ts apps/server/src/stories/index.ts apps/server/test/qa-plan.test.ts
git commit -m "feat(server): deterministic QA plan generator from acceptance criteria"
```

---

## Task 4: Extend `FlowStore` interface + InMemory impl

**Files:**
- Modify: `apps/server/src/state/store.ts`
- Modify: `apps/server/src/state/in-memory.ts`
- Test: `apps/server/test/in-memory-stories.test.ts`

- [ ] **Step 1: Write the failing test**

Write to `apps/server/test/in-memory-stories.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { InMemoryFlowStore } from '../src/state/in-memory.js';

async function makeStoreWithFlow() {
  const store = new InMemoryFlowStore();
  const flow = await store.createFlow({
    tenant_id: 't1',
    project: 'p1',
    slug: 's1',
    title: 'Test flow',
  });
  return { store, flow };
}

describe('InMemoryFlowStore — stories', () => {
  it('creates and reads back a story', async () => {
    const { store, flow } = await makeStoreWithFlow();
    const created = await store.createStory({
      flow_id: flow.flow_id,
      external_id: 'ADO-7',
      external_url: 'https://example/7',
      title: 'Story A',
      acceptance_criteria: ['must do X'],
    });
    expect(created.status).toBe('created');
    expect(created.story_id).toBeTruthy();

    const fetched = await store.getStory(created.story_id);
    expect(fetched).toEqual(created);
  });

  it('lists stories by flow', async () => {
    const { store, flow } = await makeStoreWithFlow();
    await store.createStory({
      flow_id: flow.flow_id,
      external_id: 'ADO-1',
      external_url: 'u',
      title: 'A',
      acceptance_criteria: [],
    });
    await store.createStory({
      flow_id: flow.flow_id,
      external_id: 'ADO-2',
      external_url: 'u',
      title: 'B',
      acceptance_criteria: [],
    });
    const list = await store.listStoriesByFlow(flow.flow_id);
    expect(list.map((s) => s.external_id).sort()).toEqual(['ADO-1', 'ADO-2']);
  });

  it('updates a story and bumps updated_at', async () => {
    const { store, flow } = await makeStoreWithFlow();
    const s = await store.createStory({
      flow_id: flow.flow_id,
      external_id: 'ADO-1',
      external_url: 'u',
      title: 'A',
      acceptance_criteria: [],
    });
    const after = await store.updateStory(s.story_id, {
      status: 'claimed',
      assignee: 'alice',
    });
    expect(after.status).toBe('claimed');
    expect(after.assignee).toBe('alice');
    expect(after.updated_at >= s.updated_at).toBe(true);
  });

  it('throws when updating an unknown story', async () => {
    const { store } = await makeStoreWithFlow();
    await expect(store.updateStory('does-not-exist', { status: 'claimed' })).rejects.toThrow(
      /Unknown story/,
    );
  });

  it('rejects createStory for an unknown flow', async () => {
    const store = new InMemoryFlowStore();
    await expect(
      store.createStory({
        flow_id: 'missing',
        external_id: 'ADO-1',
        external_url: 'u',
        title: 'A',
        acceptance_criteria: [],
      }),
    ).rejects.toThrow(/unknown flow/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @sdlc/server vitest run test/in-memory-stories.test.ts`
Expected: FAIL — `store.createStory is not a function`.

- [ ] **Step 3: Extend the interface**

Edit `apps/server/src/state/store.ts`. Add these imports next to the existing ones:

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
  QaVerdict,
  Story,
  StoryQaPlan,
  StoryStatus,
} from '@sdlc/core';
```

Append, before the closing `}` of `FlowStore`:

```ts
  createStory(input: CreateStoryInput): Promise<Story>;
  getStory(storyId: string): Promise<Story | undefined>;
  listStoriesByFlow(flowId: string): Promise<Story[]>;
  updateStory(storyId: string, patch: UpdateStoryInput): Promise<Story>;
```

Add the input types at the bottom of the file:

```ts
export interface CreateStoryInput {
  flow_id: string;
  external_id: string;
  external_url: string;
  title: string;
  acceptance_criteria: string[];
}

export interface UpdateStoryInput {
  status?: StoryStatus;
  assignee?: string;
  pr_url?: string;
  qa_plan?: StoryQaPlan;
  qa_verdict?: QaVerdict;
  qa_block_reason?: string;
}
```

- [ ] **Step 4: Implement on InMemoryFlowStore**

Edit `apps/server/src/state/in-memory.ts`. Add to the imports:

```ts
import type { Flow, FlowEvent, Story } from '@sdlc/core';
import type {
  AppendEventInput,
  CreateFlowInput,
  CreateStoryInput,
  FlowStore,
  UpdateFlowInput,
  UpdateStoryInput,
} from './store.js';
```

Inside the class, add a stories map next to the existing fields:

```ts
  private readonly stories = new Map<string, Story>();
```

Add these methods inside the class:

```ts
  async createStory(input: CreateStoryInput): Promise<Story> {
    if (!this.flows.has(input.flow_id)) {
      throw new Error(`Cannot create story for unknown flow: ${input.flow_id}`);
    }
    const story_id = `${input.flow_id}::${input.external_id}`;
    if (this.stories.has(story_id)) {
      throw new Error(`Story already exists: ${story_id}`);
    }
    const now = new Date().toISOString();
    const story: Story = {
      story_id,
      flow_id: input.flow_id,
      external_id: input.external_id,
      external_url: input.external_url,
      title: input.title,
      acceptance_criteria: input.acceptance_criteria,
      status: 'created',
      created_at: now,
      updated_at: now,
    };
    this.stories.set(story_id, story);
    return story;
  }

  async getStory(storyId: string): Promise<Story | undefined> {
    return this.stories.get(storyId);
  }

  async listStoriesByFlow(flowId: string): Promise<Story[]> {
    return [...this.stories.values()].filter((s) => s.flow_id === flowId);
  }

  async updateStory(storyId: string, patch: UpdateStoryInput): Promise<Story> {
    const existing = this.stories.get(storyId);
    if (!existing) throw new Error(`Unknown story: ${storyId}`);
    const next: Story = {
      ...existing,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.assignee !== undefined ? { assignee: patch.assignee } : {}),
      ...(patch.pr_url !== undefined ? { pr_url: patch.pr_url } : {}),
      ...(patch.qa_plan !== undefined ? { qa_plan: patch.qa_plan } : {}),
      ...(patch.qa_verdict !== undefined ? { qa_verdict: patch.qa_verdict } : {}),
      ...(patch.qa_block_reason !== undefined ? { qa_block_reason: patch.qa_block_reason } : {}),
      updated_at: new Date().toISOString(),
    };
    this.stories.set(storyId, next);
    return next;
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @sdlc/server vitest run test/in-memory-stories.test.ts`
Expected: 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/state/store.ts apps/server/src/state/in-memory.ts apps/server/test/in-memory-stories.test.ts
git commit -m "feat(state): stories CRUD on FlowStore + InMemory impl"
```

---

## Task 5: Postgres schema + migration + impl

**Files:**
- Create: `apps/server/migrations/0002_stories.sql`
- Modify: `apps/server/src/state/schema.ts`
- Modify: `apps/server/src/state/postgres.ts`

The Postgres integration test is conditional on `TEST_DATABASE_URL` (see `apps/server/test/postgres-flow-store.integration.test.ts`). We don't add a story-specific Postgres test in this slice — the InMemory test exercises the contract and the existing Postgres test continues to pass.

- [ ] **Step 1: Write the SQL migration**

Write to `apps/server/migrations/0002_stories.sql`:

```sql
CREATE TABLE IF NOT EXISTS "stories" (
  "story_id" text PRIMARY KEY,
  "flow_id" text NOT NULL REFERENCES "flows"("flow_id") ON DELETE CASCADE,
  "external_id" text NOT NULL,
  "external_url" text NOT NULL,
  "title" text NOT NULL,
  "acceptance_criteria" jsonb NOT NULL,
  "status" text NOT NULL,
  "assignee" text,
  "pr_url" text,
  "qa_plan" jsonb,
  "qa_verdict" text,
  "qa_block_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "stories_flow_external_unique" UNIQUE ("flow_id", "external_id")
);

CREATE INDEX IF NOT EXISTS "stories_flow_status_idx" ON "stories" ("flow_id", "status");
```

- [ ] **Step 2: Add the drizzle table**

Edit `apps/server/src/state/schema.ts`. Add at the bottom:

```ts
export const stories = pgTable(
  'stories',
  {
    story_id: text('story_id').primaryKey(),
    flow_id: text('flow_id').notNull(),
    external_id: text('external_id').notNull(),
    external_url: text('external_url').notNull(),
    title: text('title').notNull(),
    acceptance_criteria: jsonb('acceptance_criteria').notNull(),
    status: text('status').notNull(),
    assignee: text('assignee'),
    pr_url: text('pr_url'),
    qa_plan: jsonb('qa_plan'),
    qa_verdict: text('qa_verdict'),
    qa_block_reason: text('qa_block_reason'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);
```

- [ ] **Step 3: Implement story methods on PostgresFlowStore**

Edit `apps/server/src/state/postgres.ts`. Add to the imports:

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
  QaVerdict,
  Story,
  StoryQaPlan,
  StoryStatus,
} from '@sdlc/core';
import type {
  AppendEventInput,
  CreateFlowInput,
  CreateStoryInput,
  FlowStore,
  UpdateFlowInput,
  UpdateStoryInput,
} from './store.js';
import { flow_events, flows, stories } from './schema.js';
```

Add these methods inside `PostgresFlowStore`:

```ts
  async createStory(input: CreateStoryInput): Promise<Story> {
    const story_id = `${input.flow_id}::${input.external_id}`;
    const rows = await this.db
      .insert(stories)
      .values({
        story_id,
        flow_id: input.flow_id,
        external_id: input.external_id,
        external_url: input.external_url,
        title: input.title,
        acceptance_criteria: input.acceptance_criteria,
        status: 'created',
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error(`Insert returned no rows for ${story_id}`);
    return rowToStory(row);
  }

  async getStory(storyId: string): Promise<Story | undefined> {
    const rows = await this.db
      .select()
      .from(stories)
      .where(eq(stories.story_id, storyId))
      .limit(1);
    const row = rows[0];
    return row ? rowToStory(row) : undefined;
  }

  async listStoriesByFlow(flowId: string): Promise<Story[]> {
    const rows = await this.db
      .select()
      .from(stories)
      .where(eq(stories.flow_id, flowId))
      .orderBy(asc(stories.created_at));
    return rows.map(rowToStory);
  }

  async updateStory(storyId: string, patch: UpdateStoryInput): Promise<Story> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.assignee !== undefined) update.assignee = patch.assignee;
    if (patch.pr_url !== undefined) update.pr_url = patch.pr_url;
    if (patch.qa_plan !== undefined) update.qa_plan = patch.qa_plan;
    if (patch.qa_verdict !== undefined) update.qa_verdict = patch.qa_verdict;
    if (patch.qa_block_reason !== undefined) update.qa_block_reason = patch.qa_block_reason;

    const rows = await this.db
      .update(stories)
      .set(update)
      .where(eq(stories.story_id, storyId))
      .returning();
    const row = rows[0];
    if (!row) throw new Error(`Unknown story: ${storyId}`);
    return rowToStory(row);
  }
```

At the bottom of the file (next to `rowToFlow`):

```ts
function rowToStory(row: typeof stories.$inferSelect): Story {
  return {
    story_id: row.story_id,
    flow_id: row.flow_id,
    external_id: row.external_id,
    external_url: row.external_url,
    title: row.title,
    acceptance_criteria: row.acceptance_criteria as string[],
    status: row.status as StoryStatus,
    assignee: row.assignee ?? undefined,
    pr_url: row.pr_url ?? undefined,
    qa_plan: (row.qa_plan as StoryQaPlan | null) ?? undefined,
    qa_verdict: (row.qa_verdict as QaVerdict | null) ?? undefined,
    qa_block_reason: row.qa_block_reason ?? undefined,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
```

- [ ] **Step 4: Type-check the server**

Run: `pnpm --filter @sdlc/server typecheck` (or `pnpm --filter @sdlc/server build` if no typecheck script).
Expected: exits 0.

- [ ] **Step 5: Run all server tests**

Run: `pnpm --filter @sdlc/server vitest run`
Expected: all green. Postgres test is skipped unless `TEST_DATABASE_URL` is set.

- [ ] **Step 6: Commit**

```bash
git add apps/server/migrations/0002_stories.sql apps/server/src/state/schema.ts apps/server/src/state/postgres.ts
git commit -m "feat(state): stories table + PostgresFlowStore CRUD"
```

---

## Task 6: Persist story rows when `create_stories` runs

**Files:**
- Modify: `apps/server/src/mcp/tools/create-stories.ts`
- Test: extend `apps/server/test/shaping.test.ts`

- [ ] **Step 1: Add a failing assertion**

Find the existing happy-path test in `apps/server/test/shaping.test.ts` that calls `create_stories`. After the assertion on `data.story_refs`, add:

```ts
    const stored = await store.listStoriesByFlow(flow.flow_id);
    expect(stored.map((s) => s.external_id).sort()).toEqual(
      refs.map((r) => r.external_id).sort(),
    );
    expect(stored.every((s) => s.status === 'created')).toBe(true);
    expect(stored[0]?.acceptance_criteria.length).toBeGreaterThan(0);
```

(Use the existing local names — `refs` is what the test already destructures from `data.story_refs`; adjust if the existing names differ.)

- [ ] **Step 2: Run the shaping test to verify it fails**

Run: `pnpm --filter @sdlc/server vitest run test/shaping.test.ts`
Expected: FAIL on the new assertion (`stored` empty).

- [ ] **Step 3: Persist story rows in the tool handler**

Edit `apps/server/src/mcp/tools/create-stories.ts`. After the `for (const story of input.stories)` loop (after `refs.push(ref);`), but **inside** the same loop after the existing `await taskSystem.linkChildToParent(...)`, persist the story row:

```ts
        await store.createStory({
          flow_id: flow.flow_id,
          external_id: ref.external_id,
          external_url: ref.url,
          title: story.title,
          acceptance_criteria: story.acceptance_criteria,
        });
```

The final loop body should look like:

```ts
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
        await store.createStory({
          flow_id: flow.flow_id,
          external_id: ref.external_id,
          external_url: ref.url,
          title: story.title,
          acceptance_criteria: story.acceptance_criteria,
        });
        refs.push(ref);
      }
```

- [ ] **Step 4: Run the shaping test to verify it passes**

Run: `pnpm --filter @sdlc/server vitest run test/shaping.test.ts`
Expected: all green (including the new assertion).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/mcp/tools/create-stories.ts apps/server/test/shaping.test.ts
git commit -m "feat(shaping): persist story rows when create_stories runs"
```

---

## Task 7: `claim_story` tool

**Files:**
- Create: `apps/server/src/mcp/tools/claim-story.ts`
- Test: covered by integration test in Task 13 (write a focused unit happy path here)
- Test: `apps/server/test/implementation-qa.test.ts` (new, append happy path)

- [ ] **Step 1: Scaffold the test file with the first happy-path case**

Write to `apps/server/test/implementation-qa.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { Catalog } from '@sdlc/catalog';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';
import { buildToolRegistry } from '../src/mcp/tools/index.js';
import { resolve } from 'node:path';

const ctx = (overrides: Partial<TenantCtx> = {}): TenantCtx => ({
  tenantId: 't1',
  userId: 'alice',
  roles: ['developer'],
  resolveSecret: async () => { throw new Error('no secrets'); },
  ...overrides,
});

async function makeRegistry() {
  const catalog = await Catalog.load(resolve(__dirname, '../../../packages/catalog'));
  const store = new InMemoryFlowStore();
  const taskSystem = new InMemoryTaskSystemAdapter();
  const registry = buildToolRegistry({ catalog, store, taskSystem });
  return { store, taskSystem, registry };
}

async function seedReadyFlow(store: InMemoryFlowStore, taskSystem: InMemoryTaskSystemAdapter) {
  const flow = await store.createFlow({
    tenant_id: 't1',
    project: 'demo',
    slug: 'login',
    title: 'Login feature',
  });
  await store.updateFlow(flow.flow_id, {
    status: 'backlog_ready',
    current_phase: 'implementation',
    epic_external_id: 'ADO-1',
    architecture_mode: 'new',
    codebase_status: 'greenfield',
  });
  const epicRef = await taskSystem.createEpic(
    { project_key: 'demo', title: 'Login', description: 'x' },
    ctx(),
  );
  const storyRef = await taskSystem.createStory(
    {
      project_key: 'demo',
      epic_id: epicRef.external_id,
      title: 'User logs in',
      description: 'happy login',
      acceptance_criteria: ['email/password works', 'failure shows error'],
    },
    ctx(),
  );
  const story = await store.createStory({
    flow_id: flow.flow_id,
    external_id: storyRef.external_id,
    external_url: storyRef.url,
    title: 'User logs in',
    acceptance_criteria: ['email/password works', 'failure shows error'],
  });
  return { flow, story };
}

describe('claim_story', () => {
  it('claims a created story, transitions adapter, emits event', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedReadyFlow(store, taskSystem);

    const tool = registry.get('claim_story');
    expect(tool).toBeDefined();

    const out = (await tool!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    )) as { ok: boolean; data?: { story: { status: string; assignee?: string } } };

    expect(out.ok).toBe(true);
    expect(out.data?.story.status).toBe('claimed');
    expect(out.data?.story.assignee).toBe('alice');

    const adapterItem = await taskSystem.getItem(story.external_id, ctx());
    expect(adapterItem.status).toBe('Active');

    const events = await store.listEvents(flow.flow_id);
    expect(events.some((e) => e.type === 'story.claimed')).toBe(true);
  });

  it('is idempotent for the same developer', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    const tool = registry.get('claim_story')!;

    const first = await tool.handler({ story_id: story.story_id, developer_id: 'alice' }, ctx());
    const second = await tool.handler({ story_id: story.story_id, developer_id: 'alice' }, ctx());

    expect((first as { ok: boolean }).ok).toBe(true);
    expect((second as { ok: boolean }).ok).toBe(true);

    const events = await store.listEvents(story.flow_id);
    expect(events.filter((e) => e.type === 'story.claimed')).toHaveLength(1);
  });

  it('rejects claim if already taken by another developer', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    const tool = registry.get('claim_story')!;
    await tool.handler({ story_id: story.story_id, developer_id: 'alice' }, ctx());
    const out = (await tool.handler(
      { story_id: story.story_id, developer_id: 'bob' },
      ctx({ userId: 'bob' }),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/already claimed/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @sdlc/server vitest run test/implementation-qa.test.ts`
Expected: FAIL — tool not registered.

- [ ] **Step 3: Implement the tool**

Write to `apps/server/src/mcp/tools/claim-story.ts`:

```ts
import { z } from 'zod';
import type { TaskSystemAdapter, TenantCtx } from '@sdlc/adapters-contracts';
import type { Catalog, ScenarioContext } from '@sdlc/catalog';
import type { FlowStore } from '../../state/index.js';
import { canTransition } from '../../stories/index.js';

export const ClaimStoryInput = z.object({
  story_id: z.string().min(1),
  developer_id: z.string().min(1),
});
export type ClaimStoryInput = z.infer<typeof ClaimStoryInput>;

export function makeClaimStoryTool(
  store: FlowStore,
  taskSystem: TaskSystemAdapter,
  catalog: Catalog,
) {
  return {
    name: 'claim_story',
    description:
      'Marks a story as claimed by the given developer. Idempotent if the same developer re-claims. Transitions the external work item to Active and emits story.claimed.',
    inputSchema: ClaimStoryInput,
    handler: async (input: ClaimStoryInput, ctx: TenantCtx) => {
      const story = await store.getStory(input.story_id);
      if (!story) return { ok: false, error: `Unknown story: ${input.story_id}` };

      const flow = await store.getFlow(story.flow_id);
      if (!flow) return { ok: false, error: `Unknown flow: ${story.flow_id}` };
      if (flow.tenant_id !== ctx.tenantId) {
        return { ok: false, error: 'Flow belongs to a different tenant' };
      }

      if (story.status === 'claimed' && story.assignee === input.developer_id) {
        return {
          ok: true,
          data: { story, idempotent: true },
        };
      }
      if (story.status !== 'created') {
        return {
          ok: false,
          error: `Cannot claim story in status "${story.status}" (already claimed by ${story.assignee ?? 'unknown'})`,
        };
      }
      if (!canTransition(story.status, 'claimed')) {
        return { ok: false, error: `invalid transition ${story.status}→claimed` };
      }

      await taskSystem.transition(story.external_id, 'Active', ctx);
      const updated = await store.updateStory(story.story_id, {
        status: 'claimed',
        assignee: input.developer_id,
      });
      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'story.claimed',
        actor: ctx.userId,
        payload: {
          story_id: story.story_id,
          external_id: story.external_id,
          developer_id: input.developer_id,
        },
      });

      const scenario: ScenarioContext = {};
      if (flow.architecture_mode) scenario.architecture_mode = flow.architecture_mode;
      if (flow.codebase_status) scenario.codebase_status = flow.codebase_status;
      const bundle = await catalog.getRolePrompt('developer', 'implement', scenario);

      return {
        ok: true,
        data: {
          story: updated,
          rfc_ref: flow.rfc_ref ?? null,
          epic_external_id: flow.epic_external_id ?? null,
          architecture_mode: flow.architecture_mode ?? null,
          codebase_status: flow.codebase_status ?? null,
          skills: bundle.skills,
        },
        next_actions: ['report_progress({status:"in_progress"})'],
      };
    },
  };
}
```

- [ ] **Step 4: Register the tool**

Edit `apps/server/src/mcp/tools/index.ts`. Add the import:

```ts
import { makeClaimStoryTool } from './claim-story.js';
```

Inside `buildToolRegistry`, append to the `tools` array (before `byName`):

```ts
    makeClaimStoryTool(store, taskSystem, catalog) as unknown as ToolDef,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @sdlc/server vitest run test/implementation-qa.test.ts`
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/mcp/tools/claim-story.ts apps/server/src/mcp/tools/index.ts apps/server/test/implementation-qa.test.ts
git commit -m "feat(tools): claim_story with idempotency + Azure DevOps transition"
```

---

## Task 8: `report_progress` tool

**Files:**
- Create: `apps/server/src/mcp/tools/report-progress.ts`
- Modify: `apps/server/src/mcp/tools/index.ts`
- Modify: `apps/server/test/implementation-qa.test.ts`

- [ ] **Step 1: Append failing tests**

In `apps/server/test/implementation-qa.test.ts`, add a new `describe` block:

```ts
describe('report_progress', () => {
  it('moves claimed → in_progress, then in_progress → in_review with pr_url', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );

    const report = registry.get('report_progress')!;
    const a = (await report.handler(
      { story_id: story.story_id, status: 'in_progress' },
      ctx(),
    )) as { ok: boolean; data?: { story: { status: string } } };
    expect(a.ok).toBe(true);
    expect(a.data?.story.status).toBe('in_progress');

    const b = (await report.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://example/pr/1' },
      ctx(),
    )) as { ok: boolean; data?: { story: { status: string; pr_url?: string } } };
    expect(b.ok).toBe(true);
    expect(b.data?.story.status).toBe('in_review');
    expect(b.data?.story.pr_url).toBe('https://example/pr/1');

    const item = await taskSystem.getItem(story.external_id, ctx());
    expect(item.status).toBe('Resolved');
  });

  it('rejects in_review without pr_url', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    const out = (await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review' },
      ctx(),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/pr_url/i);
  });

  it('rejects when caller is not the assignee', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    const out = (await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_progress' },
      ctx({ userId: 'mallory' }),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/assignee/i);
  });

  it('rejects FSM-invalid transitions (e.g. created → in_review)', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    // story is still in 'created' — claim first would be required.
    const out = (await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://x' },
      ctx(),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/invalid transition|not assigned/i);
  });
});
```

- [ ] **Step 2: Verify the new tests fail**

Run: `pnpm --filter @sdlc/server vitest run test/implementation-qa.test.ts -t report_progress`
Expected: FAIL — `report_progress` not registered.

- [ ] **Step 3: Implement the tool**

Write to `apps/server/src/mcp/tools/report-progress.ts`:

```ts
import { z } from 'zod';
import type { TaskSystemAdapter, TenantCtx } from '@sdlc/adapters-contracts';
import type { StoryStatus } from '@sdlc/core';
import type { FlowStore } from '../../state/index.js';
import { canTransition } from '../../stories/index.js';

export const ReportProgressInput = z.object({
  story_id: z.string().min(1),
  status: z.enum(['in_progress', 'in_review']),
  pr_url: z.string().url().optional(),
  notes: z.string().optional(),
});
export type ReportProgressInput = z.infer<typeof ReportProgressInput>;

export function makeReportProgressTool(store: FlowStore, taskSystem: TaskSystemAdapter) {
  return {
    name: 'report_progress',
    description:
      'Reports developer progress on a claimed story. status="in_progress" while coding; status="in_review" when the PR is open (pr_url required). Transitions the work item accordingly.',
    inputSchema: ReportProgressInput,
    handler: async (input: ReportProgressInput, ctx: TenantCtx) => {
      const story = await store.getStory(input.story_id);
      if (!story) return { ok: false, error: `Unknown story: ${input.story_id}` };

      const flow = await store.getFlow(story.flow_id);
      if (!flow) return { ok: false, error: `Unknown flow: ${story.flow_id}` };
      if (flow.tenant_id !== ctx.tenantId) {
        return { ok: false, error: 'Flow belongs to a different tenant' };
      }
      if (story.assignee !== ctx.userId) {
        return {
          ok: false,
          error: `Only the assignee can report progress (assignee=${story.assignee ?? 'unset'})`,
        };
      }
      if (input.status === 'in_review' && !input.pr_url) {
        return { ok: false, error: 'pr_url is required when status=in_review' };
      }
      const target: StoryStatus = input.status;
      if (!canTransition(story.status, target)) {
        return { ok: false, error: `invalid transition ${story.status}→${target}` };
      }

      const adoStatus = target === 'in_review' ? 'Resolved' : 'Active';
      await taskSystem.transition(story.external_id, adoStatus, ctx);

      const updated = await store.updateStory(story.story_id, {
        status: target,
        ...(input.pr_url ? { pr_url: input.pr_url } : {}),
      });
      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'progress.reported',
        actor: ctx.userId,
        payload: {
          story_id: story.story_id,
          status: target,
          pr_url: input.pr_url ?? null,
          notes: input.notes ?? null,
        },
      });

      return {
        ok: true,
        data: { story: updated },
        next_actions:
          target === 'in_review'
            ? ['get_implementation_context (QA side)', 'generate_qa_plan']
            : ['report_progress({status:"in_review", pr_url})'],
      };
    },
  };
}
```

- [ ] **Step 4: Register the tool**

Edit `apps/server/src/mcp/tools/index.ts`. Add import:

```ts
import { makeReportProgressTool } from './report-progress.js';
```

Append to the `tools` array:

```ts
    makeReportProgressTool(store, taskSystem) as unknown as ToolDef,
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @sdlc/server vitest run test/implementation-qa.test.ts`
Expected: all green (claim_story + report_progress blocks pass).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/mcp/tools/report-progress.ts apps/server/src/mcp/tools/index.ts apps/server/test/implementation-qa.test.ts
git commit -m "feat(tools): report_progress with FSM guard + assignee enforcement"
```

---

## Task 9: `get_implementation_context` tool

**Files:**
- Create: `apps/server/src/mcp/tools/get-implementation-context.ts`
- Modify: `apps/server/src/mcp/tools/index.ts`
- Modify: `apps/server/test/implementation-qa.test.ts`

- [ ] **Step 1: Append failing tests**

In `apps/server/test/implementation-qa.test.ts`, add:

```ts
describe('get_implementation_context', () => {
  it('returns story + flow refs + null excerpt when no rfc_markdown is passed', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    const out = (await registry.get('get_implementation_context')!.handler(
      { story_id: story.story_id },
      ctx({ roles: ['qa'] }),
    )) as { ok: boolean; data?: { rfc_excerpt: string | null; story: { status: string } } };
    expect(out.ok).toBe(true);
    expect(out.data?.rfc_excerpt).toBeNull();
    expect(out.data?.story.status).toBe('claimed');
  });

  it('extracts Design + Risks sections from rfc_markdown when supplied', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    const rfc = [
      '# RFC',
      '## Goals',
      'Goal A',
      '## Design',
      'Use Postgres + Drizzle.',
      '## Risks',
      'Migration takes the table offline briefly.',
      '## Other',
      'irrelevant',
    ].join('\n');
    const out = (await registry.get('get_implementation_context')!.handler(
      { story_id: story.story_id, rfc_markdown: rfc },
      ctx({ roles: ['qa'] }),
    )) as { ok: boolean; data?: { rfc_excerpt: string } };
    expect(out.ok).toBe(true);
    expect(out.data?.rfc_excerpt).toMatch(/Postgres \+ Drizzle/);
    expect(out.data?.rfc_excerpt).toMatch(/Migration takes the table offline/);
    expect(out.data?.rfc_excerpt).not.toMatch(/irrelevant/);
  });

  it('rejects when story is still in created status', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    const out = (await registry.get('get_implementation_context')!.handler(
      { story_id: story.story_id },
      ctx({ roles: ['qa'] }),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not.*claimed|created/i);
  });
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `pnpm --filter @sdlc/server vitest run test/implementation-qa.test.ts -t get_implementation_context`
Expected: FAIL — tool not registered.

- [ ] **Step 3: Implement the tool**

Write to `apps/server/src/mcp/tools/get-implementation-context.ts`:

```ts
import { z } from 'zod';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { Catalog, ScenarioContext } from '@sdlc/catalog';
import type { FlowStore } from '../../state/index.js';
import { extractSections } from '../../validation/markdown-sections.js';

export const GetImplementationContextInput = z.object({
  story_id: z.string().min(1),
  rfc_markdown: z.string().optional(),
});
export type GetImplementationContextInput = z.infer<typeof GetImplementationContextInput>;

const EXCERPT_HEADINGS = ['design', 'risks'];

function buildExcerpt(rfcMarkdown: string): string {
  const sections = extractSections(rfcMarkdown);
  const picked = sections.filter((s) =>
    EXCERPT_HEADINGS.some((h) => s.heading.trim().toLowerCase() === h),
  );
  return picked
    .map((s) => `## ${s.heading}\n${s.body.trim()}`)
    .join('\n\n')
    .trim();
}

export function makeGetImplementationContextTool(store: FlowStore, catalog: Catalog) {
  return {
    name: 'get_implementation_context',
    description:
      'Returns the bundle that QA (or anyone else) needs to validate a story: the story itself, the flow rfc_ref/architecture_mode, pr_url, scenario-resolved QA skills, and (if rfc_markdown is supplied) a Design+Risks excerpt extracted from it.',
    inputSchema: GetImplementationContextInput,
    handler: async (input: GetImplementationContextInput, ctx: TenantCtx) => {
      const story = await store.getStory(input.story_id);
      if (!story) return { ok: false, error: `Unknown story: ${input.story_id}` };

      const flow = await store.getFlow(story.flow_id);
      if (!flow) return { ok: false, error: `Unknown flow: ${story.flow_id}` };
      if (flow.tenant_id !== ctx.tenantId) {
        return { ok: false, error: 'Flow belongs to a different tenant' };
      }
      if (story.status === 'created') {
        return {
          ok: false,
          error: 'Story has not been claimed yet (status=created); nothing to validate.',
        };
      }

      const rfc_excerpt = input.rfc_markdown ? buildExcerpt(input.rfc_markdown) : null;

      const scenario: ScenarioContext = {};
      if (flow.architecture_mode) scenario.architecture_mode = flow.architecture_mode;
      if (flow.codebase_status) scenario.codebase_status = flow.codebase_status;
      const bundle = await catalog.getRolePrompt('qa', 'qa', scenario);

      return {
        ok: true,
        data: {
          story,
          rfc_ref: flow.rfc_ref ?? null,
          architecture_mode: flow.architecture_mode ?? null,
          codebase_status: flow.codebase_status ?? null,
          pr_url: story.pr_url ?? null,
          rfc_excerpt,
          skills: bundle.skills,
        },
        next_actions: ['generate_qa_plan'],
      };
    },
  };
}
```

- [ ] **Step 4: Register the tool**

Edit `apps/server/src/mcp/tools/index.ts`. Add import:

```ts
import { makeGetImplementationContextTool } from './get-implementation-context.js';
```

Append to the `tools` array:

```ts
    makeGetImplementationContextTool(store, catalog) as unknown as ToolDef,
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @sdlc/server vitest run test/implementation-qa.test.ts`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/mcp/tools/get-implementation-context.ts apps/server/src/mcp/tools/index.ts apps/server/test/implementation-qa.test.ts
git commit -m "feat(tools): get_implementation_context with optional RFC excerpt"
```

---

## Task 10: `generate_qa_plan` tool

**Files:**
- Create: `apps/server/src/mcp/tools/generate-qa-plan.ts`
- Modify: `apps/server/src/mcp/tools/index.ts`
- Modify: `apps/server/test/implementation-qa.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
describe('generate_qa_plan', () => {
  it('rejects when story is not at least in_review', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    const out = (await registry.get('generate_qa_plan')!.handler(
      { story_id: story.story_id },
      ctx({ roles: ['qa'] }),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/in_review|qa_passed|blocked/i);
  });

  it('persists the plan on the story row and emits qa.plan.generated', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://x/pr/1' },
      ctx(),
    );
    const out = (await registry.get('generate_qa_plan')!.handler(
      { story_id: story.story_id },
      ctx({ roles: ['qa'] }),
    )) as { ok: boolean; data?: { qa_plan: { cases: Array<{ case_id: string }> } } };
    expect(out.ok).toBe(true);
    expect(out.data?.qa_plan.cases.map((c) => c.case_id)).toEqual([
      'AC-1', 'AC-2', 'EDGE-1', 'EDGE-2',
    ]);

    const stored = await store.getStory(story.story_id);
    expect(stored?.qa_plan?.cases.length).toBe(4);

    const events = await store.listEvents(story.flow_id);
    expect(events.filter((e) => e.type === 'qa.plan.generated')).toHaveLength(1);
  });

  it('regenerates and replaces qa_plan on a second call', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://x/pr/1' },
      ctx(),
    );
    const tool = registry.get('generate_qa_plan')!;
    await tool.handler({ story_id: story.story_id }, ctx({ roles: ['qa'] }));
    await tool.handler({ story_id: story.story_id }, ctx({ roles: ['qa'] }));
    const events = await store.listEvents(story.flow_id);
    expect(events.filter((e) => e.type === 'qa.plan.generated')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Verify they fail**

Run: `pnpm --filter @sdlc/server vitest run test/implementation-qa.test.ts -t generate_qa_plan`
Expected: FAIL.

- [ ] **Step 3: Implement the tool**

Write to `apps/server/src/mcp/tools/generate-qa-plan.ts`:

```ts
import { z } from 'zod';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';
import { generateQaPlan } from '../../stories/index.js';

export const GenerateQaPlanInput = z.object({
  story_id: z.string().min(1),
});
export type GenerateQaPlanInput = z.infer<typeof GenerateQaPlanInput>;

const PLAN_ELIGIBLE = new Set(['in_review', 'qa_passed', 'blocked']);

export function makeGenerateQaPlanTool(store: FlowStore) {
  return {
    name: 'generate_qa_plan',
    description:
      'Generates (or regenerates) a deterministic QA plan from the story acceptance criteria. Required before submit_qa_results.',
    inputSchema: GenerateQaPlanInput,
    handler: async (input: GenerateQaPlanInput, ctx: TenantCtx) => {
      const story = await store.getStory(input.story_id);
      if (!story) return { ok: false, error: `Unknown story: ${input.story_id}` };

      const flow = await store.getFlow(story.flow_id);
      if (!flow) return { ok: false, error: `Unknown flow: ${story.flow_id}` };
      if (flow.tenant_id !== ctx.tenantId) {
        return { ok: false, error: 'Flow belongs to a different tenant' };
      }
      if (!PLAN_ELIGIBLE.has(story.status)) {
        return {
          ok: false,
          error: `Story must be in {in_review, qa_passed, blocked} to generate a plan (current=${story.status})`,
        };
      }

      const qa_plan = generateQaPlan(story.acceptance_criteria);
      const updated = await store.updateStory(story.story_id, { qa_plan });
      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'qa.plan.generated',
        actor: ctx.userId,
        payload: { story_id: story.story_id, case_count: qa_plan.cases.length },
      });

      return {
        ok: true,
        data: { story: updated, qa_plan },
        next_actions: ['submit_qa_results'],
      };
    },
  };
}
```

- [ ] **Step 4: Register the tool**

Edit `apps/server/src/mcp/tools/index.ts`. Add import:

```ts
import { makeGenerateQaPlanTool } from './generate-qa-plan.js';
```

Append to the `tools` array:

```ts
    makeGenerateQaPlanTool(store) as unknown as ToolDef,
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @sdlc/server vitest run test/implementation-qa.test.ts`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/mcp/tools/generate-qa-plan.ts apps/server/src/mcp/tools/index.ts apps/server/test/implementation-qa.test.ts
git commit -m "feat(tools): generate_qa_plan persists per-story plan"
```

---

## Task 11: `submit_qa_results` tool

**Files:**
- Create: `apps/server/src/mcp/tools/submit-qa-results.ts`
- Modify: `apps/server/src/mcp/tools/index.ts`
- Modify: `apps/server/test/implementation-qa.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
describe('submit_qa_results', () => {
  async function setupReadyForQa() {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://x/pr/1' },
      ctx(),
    );
    await registry.get('generate_qa_plan')!.handler(
      { story_id: story.story_id },
      ctx({ roles: ['qa'] }),
    );
    return { store, taskSystem, registry, story };
  }

  it('marks the story qa_passed and closes the work item', async () => {
    const { store, taskSystem, registry, story } = await setupReadyForQa();
    const out = (await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: [
          { case_id: 'AC-1', status: 'passed' },
          { case_id: 'AC-2', status: 'passed' },
          { case_id: 'EDGE-1', status: 'passed' },
          { case_id: 'EDGE-2', status: 'passed' },
        ],
        verdict: 'passed',
      },
      ctx({ roles: ['qa'] }),
    )) as { ok: boolean; data?: { story: { status: string; qa_verdict?: string } } };
    expect(out.ok).toBe(true);
    expect(out.data?.story.status).toBe('qa_passed');
    expect(out.data?.story.qa_verdict).toBe('passed');
    const item = await taskSystem.getItem(story.external_id, ctx());
    expect(item.status).toBe('Closed');
  });

  it('marks the story blocked with a reason and reopens the work item', async () => {
    const { store, taskSystem, registry, story } = await setupReadyForQa();
    const out = (await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: [
          { case_id: 'AC-1', status: 'passed' },
          {
            case_id: 'AC-2',
            status: 'failed',
            evidence_url: 'https://x/log/42',
            notes: 'wrong error message',
          },
          { case_id: 'EDGE-1', status: 'passed' },
          { case_id: 'EDGE-2', status: 'passed' },
        ],
        verdict: 'blocked',
        block_reason: 'AC-2 fails with wrong copy',
      },
      ctx({ roles: ['qa'] }),
    )) as { ok: boolean; data?: { story: { status: string; qa_block_reason?: string } } };
    expect(out.ok).toBe(true);
    expect(out.data?.story.status).toBe('blocked');
    expect(out.data?.story.qa_block_reason).toBe('AC-2 fails with wrong copy');
    const item = await taskSystem.getItem(story.external_id, ctx());
    expect(item.status).toBe('Active');
  });

  it('rejects when plan is missing', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://x/pr/1' },
      ctx(),
    );
    const out = (await registry.get('submit_qa_results')!.handler(
      { story_id: story.story_id, results: [], verdict: 'passed' },
      ctx({ roles: ['qa'] }),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/plan/i);
  });

  it('rejects passed verdict with any failed case', async () => {
    const { registry, story } = await setupReadyForQa();
    const out = (await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: [
          { case_id: 'AC-1', status: 'failed', evidence_url: 'https://x' },
          { case_id: 'AC-2', status: 'passed' },
          { case_id: 'EDGE-1', status: 'passed' },
          { case_id: 'EDGE-2', status: 'passed' },
        ],
        verdict: 'passed',
      },
      ctx({ roles: ['qa'] }),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/passed.*failed|inconsistent/i);
  });

  it('rejects blocked verdict without block_reason or without evidence', async () => {
    const { registry, story } = await setupReadyForQa();
    const noReason = (await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: [
          { case_id: 'AC-1', status: 'passed' },
          { case_id: 'AC-2', status: 'failed', evidence_url: 'https://x' },
          { case_id: 'EDGE-1', status: 'passed' },
          { case_id: 'EDGE-2', status: 'passed' },
        ],
        verdict: 'blocked',
      },
      ctx({ roles: ['qa'] }),
    )) as { ok: boolean; error?: string };
    expect(noReason.ok).toBe(false);

    const noEvidence = (await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: [
          { case_id: 'AC-1', status: 'passed' },
          { case_id: 'AC-2', status: 'failed' },
          { case_id: 'EDGE-1', status: 'passed' },
          { case_id: 'EDGE-2', status: 'passed' },
        ],
        verdict: 'blocked',
        block_reason: 'why',
      },
      ctx({ roles: ['qa'] }),
    )) as { ok: boolean; error?: string };
    expect(noEvidence.ok).toBe(false);
    expect(noEvidence.error).toMatch(/evidence/i);
  });

  it('rejects unknown case_id and incomplete coverage', async () => {
    const { registry, story } = await setupReadyForQa();
    const unknown = (await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: [
          { case_id: 'AC-1', status: 'passed' },
          { case_id: 'AC-2', status: 'passed' },
          { case_id: 'EDGE-1', status: 'passed' },
          { case_id: 'EDGE-2', status: 'passed' },
          { case_id: 'AC-99', status: 'passed' },
        ],
        verdict: 'passed',
      },
      ctx({ roles: ['qa'] }),
    )) as { ok: boolean; error?: string };
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/AC-99|unknown case/i);

    const incomplete = (await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: [
          { case_id: 'AC-1', status: 'passed' },
          { case_id: 'AC-2', status: 'passed' },
          { case_id: 'EDGE-1', status: 'passed' },
        ],
        verdict: 'passed',
      },
      ctx({ roles: ['qa'] }),
    )) as { ok: boolean; error?: string };
    expect(incomplete.ok).toBe(false);
    expect(incomplete.error).toMatch(/missing|coverage|EDGE-2/i);
  });

  it('rejects duplicate case_id in results', async () => {
    const { registry, story } = await setupReadyForQa();
    const out = (await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: [
          { case_id: 'AC-1', status: 'passed' },
          { case_id: 'AC-1', status: 'passed' },
          { case_id: 'AC-2', status: 'passed' },
          { case_id: 'EDGE-1', status: 'passed' },
          { case_id: 'EDGE-2', status: 'passed' },
        ],
        verdict: 'passed',
      },
      ctx({ roles: ['qa'] }),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/duplicate/i);
  });
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `pnpm --filter @sdlc/server vitest run test/implementation-qa.test.ts -t submit_qa_results`
Expected: FAIL — tool not registered.

- [ ] **Step 3: Implement the tool**

Write to `apps/server/src/mcp/tools/submit-qa-results.ts`:

```ts
import { z } from 'zod';
import type { TaskSystemAdapter, TenantCtx } from '@sdlc/adapters-contracts';
import { StoryQaResult, QaVerdict } from '@sdlc/core';
import type { FlowStore } from '../../state/index.js';

export const SubmitQaResultsInput = z.object({
  story_id: z.string().min(1),
  results: z.array(StoryQaResult),
  verdict: QaVerdict,
  block_reason: z.string().optional(),
});
export type SubmitQaResultsInput = z.infer<typeof SubmitQaResultsInput>;

export function makeSubmitQaResultsTool(store: FlowStore, taskSystem: TaskSystemAdapter) {
  return {
    name: 'submit_qa_results',
    description:
      'Submits a QA verdict (passed | blocked) for a story in in_review. Validates coverage against the persisted qa_plan and transitions the work item to Closed or Active.',
    inputSchema: SubmitQaResultsInput,
    handler: async (input: SubmitQaResultsInput, ctx: TenantCtx) => {
      const story = await store.getStory(input.story_id);
      if (!story) return { ok: false, error: `Unknown story: ${input.story_id}` };

      const flow = await store.getFlow(story.flow_id);
      if (!flow) return { ok: false, error: `Unknown flow: ${story.flow_id}` };
      if (flow.tenant_id !== ctx.tenantId) {
        return { ok: false, error: 'Flow belongs to a different tenant' };
      }
      if (story.status !== 'in_review') {
        return {
          ok: false,
          error: `Cannot submit results unless story is in_review (current=${story.status})`,
        };
      }
      if (!story.qa_plan) {
        return { ok: false, error: 'No qa_plan on this story; call generate_qa_plan first.' };
      }

      const planCaseIds = new Set(story.qa_plan.cases.map((c) => c.case_id));
      const seen = new Set<string>();
      for (const r of input.results) {
        if (!planCaseIds.has(r.case_id)) {
          return { ok: false, error: `Unknown case_id "${r.case_id}" — not in qa_plan.` };
        }
        if (seen.has(r.case_id)) {
          return { ok: false, error: `Duplicate result for case_id "${r.case_id}".` };
        }
        seen.add(r.case_id);
      }
      const missing = [...planCaseIds].filter((id) => !seen.has(id));
      if (missing.length > 0) {
        return {
          ok: false,
          error: `Incomplete coverage: missing results for ${missing.join(', ')}.`,
        };
      }

      const anyFailed = input.results.some((r) => r.status === 'failed');
      if (input.verdict === 'passed' && anyFailed) {
        return {
          ok: false,
          error: 'Inconsistent verdict: cannot pass with any failed case.',
        };
      }
      if (input.verdict === 'blocked') {
        if (!input.block_reason || input.block_reason.trim().length === 0) {
          return { ok: false, error: 'block_reason is required when verdict=blocked.' };
        }
        const failedWithoutEvidence = input.results.find(
          (r) => r.status === 'failed' && !r.evidence_url,
        );
        if (!anyFailed) {
          return {
            ok: false,
            error: 'verdict=blocked requires at least one failed case.',
          };
        }
        if (failedWithoutEvidence) {
          return {
            ok: false,
            error: `evidence_url is required for failed case "${failedWithoutEvidence.case_id}".`,
          };
        }
      }

      const adoStatus = input.verdict === 'passed' ? 'Closed' : 'Active';
      await taskSystem.transition(story.external_id, adoStatus, ctx);

      const updated = await store.updateStory(story.story_id, {
        status: input.verdict === 'passed' ? 'qa_passed' : 'blocked',
        qa_verdict: input.verdict,
        ...(input.verdict === 'blocked' && input.block_reason
          ? { qa_block_reason: input.block_reason }
          : {}),
      });
      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'qa.results.submitted',
        actor: ctx.userId,
        payload: {
          story_id: story.story_id,
          verdict: input.verdict,
          case_count: input.results.length,
          failed_count: input.results.filter((r) => r.status === 'failed').length,
          ...(input.verdict === 'blocked' ? { block_reason: input.block_reason ?? null } : {}),
        },
      });

      return {
        ok: true,
        data: { story: updated, verdict: input.verdict },
        next_actions:
          input.verdict === 'passed'
            ? ['request_code_review (future slice)']
            : ['report_progress({status:"in_progress"})'],
      };
    },
  };
}
```

- [ ] **Step 4: Register the tool**

Edit `apps/server/src/mcp/tools/index.ts`. Add import:

```ts
import { makeSubmitQaResultsTool } from './submit-qa-results.js';
```

Append to the `tools` array:

```ts
    makeSubmitQaResultsTool(store, taskSystem) as unknown as ToolDef,
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @sdlc/server vitest run test/implementation-qa.test.ts`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/mcp/tools/submit-qa-results.ts apps/server/src/mcp/tools/index.ts apps/server/test/implementation-qa.test.ts
git commit -m "feat(tools): submit_qa_results with full coverage + verdict consistency"
```

---

## Task 12: `block_story` tool

**Files:**
- Create: `apps/server/src/mcp/tools/block-story.ts`
- Modify: `apps/server/src/mcp/tools/index.ts`
- Modify: `apps/server/test/implementation-qa.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
describe('block_story', () => {
  async function setupInReview() {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://x/pr/1' },
      ctx(),
    );
    return { store, taskSystem, registry, story };
  }

  it('blocks an in_review story without a plan', async () => {
    const { store, taskSystem, registry, story } = await setupInReview();
    const out = (await registry.get('block_story')!.handler(
      { story_id: story.story_id, reason: 'smoke test fails locally' },
      ctx({ roles: ['qa'] }),
    )) as { ok: boolean; data?: { story: { status: string; qa_block_reason?: string } } };
    expect(out.ok).toBe(true);
    expect(out.data?.story.status).toBe('blocked');
    expect(out.data?.story.qa_block_reason).toBe('smoke test fails locally');
    const item = await taskSystem.getItem(story.external_id, ctx());
    expect(item.status).toBe('Active');
    const events = await store.listEvents(story.flow_id);
    expect(events.some((e) => e.type === 'story.blocked')).toBe(true);
  });

  it('rejects empty reason', async () => {
    const { registry, story } = await setupInReview();
    const out = (await registry.get('block_story')!.handler(
      { story_id: story.story_id, reason: '   ' },
      ctx({ roles: ['qa'] }),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/reason/i);
  });

  it('rejects block on a story not in_review', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    // still created
    const out = (await registry.get('block_story')!.handler(
      { story_id: story.story_id, reason: 'x' },
      ctx({ roles: ['qa'] }),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/in_review/i);
  });
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `pnpm --filter @sdlc/server vitest run test/implementation-qa.test.ts -t block_story`
Expected: FAIL — tool not registered.

- [ ] **Step 3: Implement the tool**

Write to `apps/server/src/mcp/tools/block-story.ts`:

```ts
import { z } from 'zod';
import type { TaskSystemAdapter, TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';

export const BlockStoryInput = z.object({
  story_id: z.string().min(1),
  reason: z.string().min(1),
});
export type BlockStoryInput = z.infer<typeof BlockStoryInput>;

export function makeBlockStoryTool(store: FlowStore, taskSystem: TaskSystemAdapter) {
  return {
    name: 'block_story',
    description:
      'Shortcut for QA to block an in_review story without completing a full plan (e.g. smoke fails). Transitions the work item back to Active and emits story.blocked.',
    inputSchema: BlockStoryInput,
    handler: async (input: BlockStoryInput, ctx: TenantCtx) => {
      const reason = input.reason.trim();
      if (reason.length === 0) {
        return { ok: false, error: 'reason cannot be empty' };
      }
      const story = await store.getStory(input.story_id);
      if (!story) return { ok: false, error: `Unknown story: ${input.story_id}` };

      const flow = await store.getFlow(story.flow_id);
      if (!flow) return { ok: false, error: `Unknown flow: ${story.flow_id}` };
      if (flow.tenant_id !== ctx.tenantId) {
        return { ok: false, error: 'Flow belongs to a different tenant' };
      }
      if (story.status !== 'in_review') {
        return {
          ok: false,
          error: `Cannot block a story unless it is in_review (current=${story.status})`,
        };
      }

      await taskSystem.transition(story.external_id, 'Active', ctx);
      const updated = await store.updateStory(story.story_id, {
        status: 'blocked',
        qa_verdict: 'blocked',
        qa_block_reason: reason,
      });
      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'story.blocked',
        actor: ctx.userId,
        payload: { story_id: story.story_id, reason },
      });

      return {
        ok: true,
        data: { story: updated },
        next_actions: ['report_progress({status:"in_progress"})'],
      };
    },
  };
}
```

- [ ] **Step 4: Register the tool**

Edit `apps/server/src/mcp/tools/index.ts`. Add import:

```ts
import { makeBlockStoryTool } from './block-story.js';
```

Append to the `tools` array:

```ts
    makeBlockStoryTool(store, taskSystem) as unknown as ToolDef,
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @sdlc/server vitest run test/implementation-qa.test.ts`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/mcp/tools/block-story.ts apps/server/src/mcp/tools/index.ts apps/server/test/implementation-qa.test.ts
git commit -m "feat(tools): block_story shortcut for QA early-stop"
```

---

## Task 13: End-to-end loop test (block → retry → pass)

**Files:**
- Modify: `apps/server/test/implementation-qa.test.ts`

- [ ] **Step 1: Append the integration test**

Add at the bottom of `apps/server/test/implementation-qa.test.ts`:

```ts
describe('integration: dev↔QA loop', () => {
  it('blocked story can be reworked and finally pass', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);

    // dev claims and opens PR
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://x/pr/1' },
      ctx(),
    );
    await registry.get('generate_qa_plan')!.handler(
      { story_id: story.story_id },
      ctx({ roles: ['qa'] }),
    );

    // QA blocks
    const blocked = (await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: [
          { case_id: 'AC-1', status: 'passed' },
          { case_id: 'AC-2', status: 'failed', evidence_url: 'https://x/log' },
          { case_id: 'EDGE-1', status: 'passed' },
          { case_id: 'EDGE-2', status: 'passed' },
        ],
        verdict: 'blocked',
        block_reason: 'AC-2 fails',
      },
      ctx({ roles: ['qa'] }),
    )) as { ok: boolean; data?: { story: { status: string } } };
    expect(blocked.data?.story.status).toBe('blocked');

    // dev fixes and reopens
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_progress' },
      ctx(),
    );
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://x/pr/2' },
      ctx(),
    );
    // QA regenerates plan and passes
    await registry.get('generate_qa_plan')!.handler(
      { story_id: story.story_id },
      ctx({ roles: ['qa'] }),
    );
    const passed = (await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: [
          { case_id: 'AC-1', status: 'passed' },
          { case_id: 'AC-2', status: 'passed' },
          { case_id: 'EDGE-1', status: 'passed' },
          { case_id: 'EDGE-2', status: 'passed' },
        ],
        verdict: 'passed',
      },
      ctx({ roles: ['qa'] }),
    )) as { ok: boolean; data?: { story: { status: string } } };
    expect(passed.data?.story.status).toBe('qa_passed');

    const item = await taskSystem.getItem(story.external_id, ctx());
    expect(item.status).toBe('Closed');

    const events = await store.listEvents(story.flow_id);
    const types = events.map((e) => e.type);
    expect(types).toContain('story.claimed');
    expect(types.filter((t) => t === 'progress.reported').length).toBeGreaterThanOrEqual(3);
    expect(types.filter((t) => t === 'qa.plan.generated').length).toBe(2);
    expect(types.filter((t) => t === 'qa.results.submitted').length).toBe(2);
  });
});
```

- [ ] **Step 2: Run the full server test suite**

Run: `pnpm --filter @sdlc/server vitest run`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add apps/server/test/implementation-qa.test.ts
git commit -m "test(server): full dev↔QA loop with blocked → retry → passed"
```

---

## Task 14: Wire tools to stdio + http entry points (sanity check)

**Files:**
- Inspect (no change expected): `apps/server/src/index.ts`, `apps/server/src/mcp-stdio.ts`

Both entry points already build the registry from `buildToolRegistry({catalog, store, taskSystem})`. Since the new tools are added through that same registry, no entry-point changes are needed. We still verify.

- [ ] **Step 1: Inspect both files**

Read `apps/server/src/index.ts` and `apps/server/src/mcp-stdio.ts`. Confirm both call `buildToolRegistry({catalog, store, taskSystem})` with no per-tool wiring.

- [ ] **Step 2: Smoke build**

Run: `pnpm --filter @sdlc/server build` (or repo-root `pnpm build`).
Expected: exits 0.

- [ ] **Step 3: Run all tests one more time**

Run: `pnpm -r test` (or `pnpm --filter @sdlc/server vitest run` if no top-level test script).
Expected: all green.

If anything fails, fix in place and re-run before continuing. No commit if nothing changed.

---

## Task 15: Catalog bumps (developer + QA prompts)

**Files:**
- Modify: `packages/catalog/roles/developer/phases/implement.md`
- Modify: `packages/catalog/roles/qa/phases/qa.md`
- Modify: `packages/catalog/catalog.yaml`

- [ ] **Step 1: Bump developer/implement.md to 0.2.0**

Edit the frontmatter `version: 0.1.0` → `version: 0.2.0`. Then update the procedure body to reflect final signatures. Replace the whole `# Fase: Implementación de una historia` body with:

```markdown
# Fase: Implementación de una historia

Tu tarea es tomar una historia del backlog, implementarla y abrir un PR contra la rama target.

Procedimiento:

0. *(opcional)* Llamá `get_flow_state({flow_id})` para ver el resto del backlog y elegir una historia coherente con el resto del trabajo.
1. Llamá `claim_story({story_id, developer_id})`. El server devuelve:
   - `story` completa (con AC) y `rfc_ref`, `epic_external_id`.
   - `architecture_mode` y `codebase_status` del flow.
   - `skills`: esta skill + `skill-implementation-checklist` + skills extra resueltas por scenario (ej: `skill-reuse-implementation`, `skill-existing-codebase-conventions`). Leelas todas antes de empezar.
2. Leé y planeá. Antes de codear, listá:
   - Qué archivos vas a tocar.
   - Qué tests vas a agregar.
   - Qué métricas/logs vas a inyectar.
3. Implementá. Commits pequeños. Cada commit compila y pasa lint.
4. Mientras codeás, llamá `report_progress({story_id, status:"in_progress"})` cuando tengas un punto estable (no obligatorio en cada commit, pero sí al iniciar y antes de cambios grandes). El server pasa el work item a `Active`.
5. Tests obligatorios:
   - Happy path por cada AC.
   - Al menos un error path por endpoint/función pública nueva.
   - Si tocás un módulo con tests existentes, no los rompas. Si necesitás cambiarlos, justificalo en el PR.
6. Abrí el PR contra la rama target. En la descripción incluí:
   - Link a la historia (`story_id`).
   - Sección "Cambios" — bullets de qué hiciste.
   - Sección "Cómo probarlo" — pasos para que QA lo valide local.
   - Sección "Métricas/Logs" — qué se mide.
7. Llamá `report_progress({story_id, status:"in_review", pr_url})`. El server pasa el work item a `Resolved` y notifica al QA.

Cuando QA pase y Reviewer apruebe, el PR puede mergearse. No mergees vos directamente.

Si QA bloquea (`story.status=blocked`):
- Leé el `qa_block_reason` y los `results` con `status:"failed"` + evidence_urls.
- Arreglá el problema. Llamá `report_progress({story_id, status:"in_progress"})` para indicar que estás re-trabajando.
- Cuando esté listo de nuevo, `report_progress({story_id, status:"in_review", pr_url})` con el PR actualizado (mismo o nuevo).
```

- [ ] **Step 2: Bump qa/qa.md to 0.2.0**

Edit the frontmatter `version: 0.1.0` → `version: 0.2.0`. Replace the body of `# Fase: Quality Assurance` with:

```markdown
# Fase: Quality Assurance

Tu tarea es validar una historia que el developer marcó como `in_review`.

Procedimiento:

1. Llamá `get_implementation_context({story_id, rfc_markdown?})`. Si tenés el RFC en el repo, pasá el markdown — el server te devuelve un excerpt con las secciones `Design` y `Risks`. Sin `rfc_markdown` el excerpt es `null`. El bundle siempre incluye: `story` (con AC), `pr_url`, `rfc_ref`, `architecture_mode`, `codebase_status`, y `skills` (esta skill + extras según scenario, ej: `skill-reuse-regression-checks`).
2. Llamá `generate_qa_plan({story_id})`. El server genera (o regenera) un plan determinista basado en los AC, con dos casos extra de edge (`EDGE-1`, `EDGE-2`). El plan se persiste en la historia.
3. Revisá el plan. Si un caso EDGE no aplica, registralo como `passed` con `notes:"N/A"`; si necesitás casos adicionales, no podés agregarlos al plan persistido en este slice — documentalos en `notes` de uno de los EDGE existentes o como issue separado.
4. Ejecutá el plan en el entorno target (staging o preview env del PR).
5. Para cada caso del plan, registrá un result: `{case_id, status:"passed"|"failed", evidence_url?, notes?}`. **Cobertura completa obligatoria**: todos los `case_id` del plan deben tener exactamente un result, sin duplicados.
6. Veredicto:
   - Si todo pasó: `submit_qa_results({story_id, results, verdict:"passed"})`. El server cierra el work item.
   - Si algún case falla: `submit_qa_results({story_id, results, verdict:"blocked", block_reason})`. `block_reason` es obligatorio. Cada result `status:"failed"` requiere `evidence_url`. El server vuelve el work item a `Active` y la historia a `blocked`; el developer la retoma.
7. Atajo: si el smoke test inicial falla y no tiene sentido seguir el plan, llamá `block_story({story_id, reason})` sin plan completo.

Reglas:

- **Mínimo cobertura:** todos los AC del plan + `EDGE-1` + `EDGE-2`. Ningún case puede quedar sin result.
- **Performance:** si el RFC fija SLA, lo medís. Sin medición, no decís `passed`.
- **Evidencia obligatoria** en cada result `failed`. Sin evidencia no es bloqueo válido.
- **No editás código.** Si encontrás un fix obvio, sugerilo en `notes` pero no lo apliques.
```

- [ ] **Step 3: Bump catalog.yaml**

Edit `packages/catalog/catalog.yaml`:
- Top-level `catalog_version: 0.3.0` → `catalog_version: 0.4.0`.
- `developer.phases.implement.version: 0.1.0` → `version: 0.2.0`.
- `qa.phases.qa.version: 0.1.0` → `version: 0.2.0`.

- [ ] **Step 4: Run catalog smoke test**

Run: `pnpm --filter @sdlc/server vitest run test/catalog.smoke.test.ts`
Expected: green.

If it asserts on specific versions and fails, update those assertions to match the bumped versions (`0.4.0` / `0.2.0`) and re-run.

- [ ] **Step 5: Full suite**

Run: `pnpm --filter @sdlc/server vitest run`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/catalog/roles/developer/phases/implement.md packages/catalog/roles/qa/phases/qa.md packages/catalog/catalog.yaml apps/server/test/catalog.smoke.test.ts
git commit -m "feat(catalog): bump developer/implement + qa/qa prompts to 0.2.0"
```

---

## Final sanity check

- [ ] **Step 1: One full pass of every test in the repo**

Run: `pnpm -r test` (or `pnpm --filter @sdlc/server vitest run` and `pnpm --filter @sdlc/core build` separately if no aggregate script).
Expected: green.

- [ ] **Step 2: Build the whole repo**

Run: `pnpm -r build`
Expected: exits 0.

- [ ] **Step 3: Show the git log**

Run: `git log --oneline main..HEAD`
Expected: 13–14 commits (one per task above; Task 14 may have produced none).

If anything fails, fix it before handing off.
