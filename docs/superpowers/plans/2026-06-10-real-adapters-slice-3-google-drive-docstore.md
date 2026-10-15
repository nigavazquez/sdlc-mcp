# Real Adapters — Slice 3: Google Drive DocStore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire a `GoogleDriveDocStoreAdapter` so that `submit_prd`, `submit_rfc`, and the new `submit_adr` tool publish EACH artifact into the Tribu/Squad/flow folder hierarchy of the configured Google Drive shared drive as BOTH a faithful `.md` file (`text/markdown`) AND a native Google Doc (converted from the markdown) — per OD-1 (resolved "both"). The combined ref (Google Doc URL + Doc id + `.md` file id) is stored in `prd_ref` / `rfc_ref` / `adr_refs`, while keeping the no-op fallback for unconfigured tenants.

**Architecture:** A `ConfigBackedDocStoreProvider` reads `doc_store` from `IntegrationConfigStore`; `kind='google-drive'` resolves the service-account JSON via `ctx.resolveSecret`, builds a `GoogleDriveDocStoreAdapter` using `googleapis`, and per artifact upserts TWO co-located objects into an idempotently-ensured folder path: the `.md` file (`text/markdown`) and the native Google Doc (`requestBody.mimeType='application/vnd.google-apps.document'`, media `text/markdown` — Drive converts on import). Each object is upserted independently, matched by name+parent+mimeType. `kind` absent or `'repo'` → `NoOpDocStoreAdapter` (today's behavior). The `flows` table gains `tribu`, `squad`, `adr_refs`, `adr_count` columns (migration `0004`).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, Drizzle ORM + postgres-js, `googleapis` (new prod dep).

**Spec:** `docs/superpowers/specs/2026-06-10-real-adapters-slice-3-google-drive-docstore-design.md`

---

## Shared-File Merge Sequencing

> Read before starting. These files are also modified by Slice 2 and Slice 4.

- **`apps/server/src/mcp/tools/index.ts`** — Slice 3 adds `docStoreProvider` to `BuildRegistryDeps` and wires `submit_adr`. Merge Slice 3 to `main` before Slice 2 touches this file, or rebase Slice 2 on top of Slice 3.
- **`apps/server/src/index.ts`** and **`mcp-stdio.ts`** — Each slice adds a provider construction line. Changes are non-overlapping; resolve textual conflicts by keeping all provider lines.
- **`packages/core/src/flow.ts`** — additive only; run `pnpm turbo run typecheck` after each merge.
- **`apps/server/src/state/schema.ts`** — Slice 3 claims columns `tribu`, `squad`, `adr_refs`, `adr_count`. No other slice should add these same columns.
- **Migration `0004`** — Slice 3 owns it. **Slice 4 must use `0005`**; document this in the Slice 4 plan.

---

## File Structure

**Create:**
- `packages/adapters-contracts/src/docs.ts` — extended contract (modify existing)
- `apps/server/src/adapters/google-drive-docstore.ts` — `GoogleDriveDocStoreAdapter`
- `apps/server/src/adapters/doc-store-provider.ts` — `DocStoreProvider`, `ConfigBackedDocStoreProvider`, `NoOpDocStoreAdapter`
- `apps/server/migrations/0004_flows_tribu_squad_adr.sql` — DDL migration
- `apps/server/src/mcp/tools/submit-adr.ts` — new `submit_adr` tool
- `apps/server/test/google-drive-docstore.test.ts` — unit tests with mocked googleapis
- `apps/server/test/doc-store-provider.test.ts` — provider unit tests
- `apps/server/test/submit-adr.test.ts` — tool unit tests
- `apps/server/test/gdrive-docstore.integration.test.ts` — OPTIONAL live integration test (skipped by default)

**Modify:**
- `packages/adapters-contracts/src/docs.ts` — add `google-drive` kind + extend `DocPublishInput`
- `packages/core/src/flow.ts` — add `tribu`, `squad`, `adr_refs`, `adr_count` to `Flow` schema + `FlowEventType` additions
- `apps/server/src/state/schema.ts` — add columns to `flows` table (**SHARED**)
- `apps/server/src/state/store.ts` — extend `CreateFlowInput`, `UpdateFlowInput`
- `apps/server/src/state/in-memory.ts` — handle new fields
- `apps/server/src/state/postgres.ts` — handle new fields in `createFlow`, `updateFlow`, `rowToFlow`
- `apps/server/src/mcp/tools/start-flow.ts` — add `tribu`/`squad` to input + pass-through
- `apps/server/src/mcp/tools/submit-prd.ts` — resolve doc store, publish, store Drive ref
- `apps/server/src/mcp/tools/submit-rfc.ts` — resolve doc store, publish, store Drive ref
- `apps/server/src/mcp/tools/index.ts` — add `docStoreProvider` to `BuildRegistryDeps`, wire `submit_adr` (**SHARED**)
- `apps/server/src/adapters/index.ts` — export doc-store-provider
- `apps/server/src/index.ts` — construct `DocStoreProvider`, pass to registry (**SHARED**)
- `apps/server/src/mcp-stdio.ts` — mirror bootstrap (**SHARED**)

---

## Task 1: Extend `DocPublishInput` contract + `DocStoreKind`

**Files:**
- Modify: `packages/adapters-contracts/src/docs.ts`

This task has no test because it is a pure type/interface change verified by `typecheck` in later tasks.

- [ ] **Step 1: Read the current contract**

Read `packages/adapters-contracts/src/docs.ts` to confirm current shape (should match the spec excerpt).

- [ ] **Step 2: Apply the contract extension**

In `packages/adapters-contracts/src/docs.ts`, replace the file content with:

```ts
import type { TenantCtx } from './tenant-context.js';

export type DocStoreKind = 'confluence' | 'notion' | 'repo' | 'google-drive';

export interface DocRef {
  /** .md (faithful markdown) file Drive id — audit/source-of-truth anchor. */
  id: string;
  /** Primary human-facing URL = the native Google Doc webViewLink. */
  url: string;
  version?: string;
  /** Native Google Doc Drive id. */
  gdoc_id?: string;
  /** Native Google Doc webViewLink (same value as `url`, kept explicit). */
  gdoc_url?: string;
  /** .md file webViewLink (optional, for completeness). */
  md_url?: string;
}

export interface DocPublishInput {
  /** For Confluence/Notion adapters. Required by those; ignored by google-drive. */
  space_or_repo?: string;
  title: string;
  markdown: string;
  parent_id?: string;
  /** Routing discriminator for Drive folder selection and filename. */
  doc_kind: 'prd' | 'rfc' | 'adr';
  /** Required when kind='google-drive'. Top-level org unit folder name. */
  tribu?: string;
  /** Required when kind='google-drive'. Team folder name inside Tribu. */
  squad?: string;
  /** Per-flow folder name; typically the flow slug. Required when kind='google-drive'. */
  flow_folder: string;
  /** ADR filename, e.g. "0001-use-postgres.md". Only used when doc_kind='adr'. */
  adr_filename?: string;
}

export interface DocStoreAdapter {
  readonly kind: DocStoreKind;
  publish(input: DocPublishInput, ctx: TenantCtx): Promise<DocRef>;
  fetch(id: string, ctx: TenantCtx): Promise<{ markdown: string; version: string }>;
}
```

- [ ] **Step 3: Typecheck the contracts package**

Run: `pnpm --filter @sdlc/adapters-contracts typecheck`
Expected: clean (no errors).

- [ ] **Step 4: Commit**

```bash
git add packages/adapters-contracts/src/docs.ts
git commit -m "feat(contracts): extend DocPublishInput + DocRef (gdoc fields) with drive folder routing + google-drive kind"
```

---

## Task 2: Extend Flow domain model (`core` package)

**Files:**
- Modify: `packages/core/src/flow.ts`

- [ ] **Step 1: Add fields to Flow zod schema**

In `packages/core/src/flow.ts`, add four fields to the `Flow = z.object({...})` block (after `existing_repo`):

```ts
tribu:     z.string().optional(),
squad:     z.string().optional(),
adr_refs:  z.array(ArtifactRef).optional(),
adr_count: z.number().int().nonnegative().optional(),
```

- [ ] **Step 1b: Add `gdoc_id` to `ArtifactRef`**

Per OD-1 ("both"), a Drive publish yields a Google Doc id in addition to the `.md` file id. Add `gdoc_id` to the `ArtifactRef` zod object so `prd_ref`/`rfc_ref`/`adr_refs` can retain the native Doc id:

```ts
export const ArtifactRef = z.object({
  url: z.string().url().optional(),     // = Google Doc URL when published to Drive
  repo_path: z.string().optional(),
  sha256: z.string().optional(),        // markdown hash (unchanged)
  external_id: z.string().optional(),   // = .md file Drive id when published to Drive
  gdoc_id: z.string().optional(),       // = native Google Doc Drive id (Drive doc_store only)
});
```

- [ ] **Step 2: Add new FlowEventType values**

In the `FlowEventType = z.enum([...])` array, append three values:

```ts
'prd.published',
'rfc.published',
'adr.submitted',
```

- [ ] **Step 3: Typecheck core package**

Run: `pnpm --filter @sdlc/core typecheck`
Expected: clean.

- [ ] **Step 4: Typecheck server (forward-compatibility check)**

Run: `pnpm --filter @sdlc/server typecheck`
Expected: clean or only errors about not-yet-existing files from later tasks. If `rowToFlow` in `postgres.ts` or `createFlow` in `in-memory.ts` emit "property does not exist" errors because the columns are not in the Drizzle schema yet, that is expected and will be resolved in Task 4.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/flow.ts
git commit -m "feat(core): add tribu/squad/adr_refs/adr_count to Flow + gdoc_id to ArtifactRef + new event types"
```

---

## Task 3: Drizzle schema + migration `0004`

**Files:**
- Modify: `apps/server/src/state/schema.ts` (**SHARED**)
- Create: `apps/server/migrations/0004_flows_tribu_squad_adr.sql`

- [ ] **Step 1: Add columns to the `flows` Drizzle table**

In `apps/server/src/state/schema.ts`, in the `flows` pgTable definition, add four columns after `existing_repo`:

```ts
tribu:      text('tribu'),
squad:      text('squad'),
adr_refs:   jsonb('adr_refs').default([]),
adr_count:  smallint('adr_count').notNull().default(0),
```

- [ ] **Step 2: Write migration `0004`**

Create `apps/server/migrations/0004_flows_tribu_squad_adr.sql`:

```sql
-- Slice 3: add Tribu/Squad/ADR columns to flows
-- NOTE: Slice 4 must use migration 0005 to avoid numbering collision.
ALTER TABLE "flows"
  ADD COLUMN IF NOT EXISTS "tribu"      text,
  ADD COLUMN IF NOT EXISTS "squad"      text,
  ADD COLUMN IF NOT EXISTS "adr_refs"   jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "adr_count"  smallint NOT NULL DEFAULT 0;
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @sdlc/server typecheck`
Expected: Drizzle schema errors about new columns are resolved. Remaining errors (if any) are from `store.ts` / `in-memory.ts` / `postgres.ts` not yet updated — those are fixed in Task 4.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/state/schema.ts apps/server/migrations/0004_flows_tribu_squad_adr.sql
git commit -m "feat(schema): add tribu/squad/adr_refs/adr_count to flows table (migration 0004)"
```

---

## Task 4: Extend `FlowStore` interface + both implementations

**Files:**
- Modify: `apps/server/src/state/store.ts`
- Modify: `apps/server/src/state/in-memory.ts`
- Modify: `apps/server/src/state/postgres.ts`
- Test: extend `apps/server/test/flow.test.ts` (add tribu/squad assertions)

- [ ] **Step 1: Write the failing tests**

In `apps/server/test/flow.test.ts`, add (or append to the existing `describe('start_flow', ...)` block):

```ts
it('stores tribu and squad on the flow when provided', async () => {
  const store = new InMemoryFlowStore();
  const flow = await store.createFlow({
    tenant_id: 't1',
    project: 'p1',
    slug: 'tribu-test',
    title: 'T',
    tribu: 'Tribu-A',
    squad: 'Squad-B',
  });
  expect(flow.tribu).toBe('Tribu-A');
  expect(flow.squad).toBe('Squad-B');
});

it('adr_count increments when adr_refs are updated', async () => {
  const store = new InMemoryFlowStore();
  const flow = await store.createFlow({
    tenant_id: 't1', project: 'p1', slug: 'adr-test', title: 'T',
  });
  const updated = await store.updateFlow(flow.flow_id, {
    adr_refs: [{ url: 'https://drive.example.com/file/1', external_id: 'file1' }],
    adr_count: 1,
  });
  expect(updated.adr_count).toBe(1);
  expect(updated.adr_refs).toHaveLength(1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @sdlc/server test flow`
Expected: FAIL — `tribu` property missing or `updateFlow` rejects `adr_refs`.

- [ ] **Step 3: Extend `store.ts`**

In `apps/server/src/state/store.ts`:

Add to `CreateFlowInput`:
```ts
tribu?: string;
squad?: string;
```

Add to `UpdateFlowInput`:
```ts
adr_refs?: ArtifactRef[];
adr_count?: number;
```

Add `ArtifactRef` to the import from `@sdlc/core` (it is already exported there).

- [ ] **Step 4: Extend `InMemoryFlowStore`**

In `apps/server/src/state/in-memory.ts`:

In `createFlow`, add to the `flow` object literal:
```ts
tribu: input.tribu,
squad: input.squad,
adr_count: 0,
```

In `updateFlow`, in the spread for `next`, add:
```ts
...(patch.adr_refs !== undefined ? { adr_refs: patch.adr_refs } : {}),
...(patch.adr_count !== undefined ? { adr_count: patch.adr_count } : {}),
```

- [ ] **Step 5: Extend `PostgresFlowStore`**

In `apps/server/src/state/postgres.ts`:

In `createFlow`, add to the `INSERT` values:
```ts
tribu: input.tribu ?? null,
squad: input.squad ?? null,
// adr_refs and adr_count use column defaults
```

In `updateFlow`, in the `update` record builder, add:
```ts
if (patch.adr_refs !== undefined) update.adr_refs = patch.adr_refs;
if (patch.adr_count !== undefined) update.adr_count = patch.adr_count;
```

In `rowToFlow`, add:
```ts
tribu: row.tribu ?? undefined,
squad: row.squad ?? undefined,
adr_refs: (row.adr_refs as ArtifactRef[] | null) ?? undefined,
adr_count: row.adr_count ?? undefined,
```

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @sdlc/server test flow`
Expected: PASS (new tests + all pre-existing flow tests).

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @sdlc/server typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/state/store.ts apps/server/src/state/in-memory.ts apps/server/src/state/postgres.ts apps/server/test/flow.test.ts
git commit -m "feat(state): extend FlowStore with tribu/squad/adr_refs/adr_count fields"
```

---

## Task 5: `start_flow` — add tribu/squad to input

**Files:**
- Modify: `apps/server/src/mcp/tools/start-flow.ts`
- Test: extend `apps/server/test/flow.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the `start_flow` describe block in `apps/server/test/flow.test.ts`:

```ts
it('start_flow passes tribu and squad through to the flow', async () => {
  // Build a minimal registry or call makeStartFlowTool directly
  const store = new InMemoryFlowStore();
  const tool = makeStartFlowTool(store);
  const ctx: TenantCtx = {
    tenantId: 't2', userId: 'u', roles: [],
    resolveSecret: async () => { throw new Error('not used'); },
  };
  const result = await tool.handler(
    { project: 'p1', title: 'Flow with tribu', tribu: 'Tribu-X', squad: 'Squad-Y' },
    ctx,
  );
  expect(result.ok).toBe(true);
  expect((result as any).data.tribu).toBe('Tribu-X');
  expect((result as any).data.squad).toBe('Squad-Y');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @sdlc/server test flow`
Expected: FAIL — `tribu` is not an accepted input field.

- [ ] **Step 3: Extend `StartFlowInput`**

In `apps/server/src/mcp/tools/start-flow.ts`:

Add to `StartFlowInput` schema:
```ts
tribu: z.string().optional(),
squad: z.string().optional(),
```

In the `handler`, add `tribu` and `squad` to the `store.createFlow(...)` call:
```ts
const flow = await store.createFlow({
  tenant_id: ctx.tenantId,
  project: input.project,
  slug,
  title: input.title,
  tribu: input.tribu,
  squad: input.squad,
});
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @sdlc/server test flow`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/mcp/tools/start-flow.ts apps/server/test/flow.test.ts
git commit -m "feat(tools): start_flow accepts optional tribu and squad"
```

---

## Task 6: Add `googleapis` dependency

**Files:**
- Modify: `apps/server/package.json`, `pnpm-lock.yaml`

- [ ] **Step 1: Install dependency**

Run:
```bash
pnpm --filter @sdlc/server add googleapis
```
Expected: `"googleapis"` appears in `apps/server/package.json` under `"dependencies"`.

- [ ] **Step 2: Verify the package resolves**

Run: `node -e "require('googleapis'); console.log('ok')"` inside `apps/server/` or:
```bash
pnpm --filter @sdlc/server exec node -e "import('googleapis').then(()=>console.log('ok'))"
```
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add apps/server/package.json pnpm-lock.yaml
git commit -m "feat(deps): add googleapis for Google Drive adapter"
```

---

## Task 7: `GoogleDriveDocStoreAdapter`

**Files:**
- Create: `apps/server/src/adapters/google-drive-docstore.ts`
- Test: `apps/server/test/google-drive-docstore.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/google-drive-docstore.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { GoogleDriveDocStoreAdapter } from '../src/adapters/google-drive-docstore.js';

// Mock googleapis entirely so no real HTTP is made.
vi.mock('googleapis', () => {
  const makeFilesClient = () => ({
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    get: vi.fn(),
  });
  return {
    google: {
      auth: {
        GoogleAuth: vi.fn().mockImplementation(() => ({})),
      },
      drive: vi.fn().mockImplementation(() => ({ files: makeFilesClient() })),
    },
  };
});

import { google } from 'googleapis';

const SA_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'test@example.iam.gserviceaccount.com',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----\n',
});

function makeAdapter() {
  return new GoogleDriveDocStoreAdapter({
    serviceAccountJson: SA_JSON,
    sharedDriveId: 'DRIVE_ID',
  });
}

function stubDrive(listResults: Array<{ id: string }>, createId = 'new-id') {
  const files = (google.drive as any)().files as ReturnType<typeof import('googleapis').google.drive> extends { files: infer F } ? F : never;
  (files.list as any).mockResolvedValue({ data: { files: listResults } });
  (files.create as any).mockResolvedValue({ data: { id: createId, webViewLink: `https://drive.google.com/file/${createId}` } });
  (files.update as any).mockResolvedValue({ data: { id: createId, webViewLink: `https://drive.google.com/file/${createId}` } });
  return files;
}

const ctx: TenantCtx = {
  tenantId: 't1', userId: 'u', roles: [],
  resolveSecret: async () => { throw new Error('not used'); },
};

describe('GoogleDriveDocStoreAdapter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('publish prd: creates folder chain then upserts BOTH .md file and native Doc', async () => {
    // All list calls return empty (folders + both objects do not exist yet)
    const driveApi = google.drive({ version: 'v3', auth: {} as any });
    (driveApi.files.list as any).mockResolvedValue({ data: { files: [] } });
    // Return a distinct id/link per create call so .md and Doc are distinguishable
    let createSeq = 0;
    (driveApi.files.create as any).mockImplementation(async (params: any) => {
      createSeq++;
      const id = `created-${createSeq}`;
      return { data: { id, webViewLink: `https://drive.google.com/file/${id}` } };
    });

    const adapter = makeAdapter();
    // Inject mocked drive directly (reflection trick)
    (adapter as any).drive = driveApi;

    const ref = await adapter.publish({
      title: 'My PRD',
      markdown: '# PRD',
      doc_kind: 'prd',
      flow_folder: 'checkout-cuotas',
      tribu: 'Tribu-A',
      squad: 'Squad-B',
    }, ctx);

    // DocRef carries both representations
    expect(ref.id).toBeDefined();        // .md file id
    expect(ref.url).toBeDefined();       // Google Doc url
    expect(ref.gdoc_id).toBeDefined();   // Google Doc id
    expect(ref.gdoc_url).toBe(ref.url);
    expect(ref.md_url).toBeDefined();

    const createCalls = (driveApi.files.create as any).mock.calls as any[];
    // EXACTLY ONE .md file: named 'prd.md', media mimeType text/markdown, NOT a Doc conversion
    const mdCreate = createCalls.find(
      (c: any[]) => c[0]?.requestBody?.name === 'prd.md'
        && c[0]?.media?.mimeType === 'text/markdown'
        && c[0]?.requestBody?.mimeType !== 'application/vnd.google-apps.document',
    );
    expect(mdCreate).toBeDefined();
    // EXACTLY ONE native Doc: named 'prd' (no extension), requestBody.mimeType = Doc, media text/markdown
    const docCreate = createCalls.find(
      (c: any[]) => c[0]?.requestBody?.name === 'prd'
        && c[0]?.requestBody?.mimeType === 'application/vnd.google-apps.document'
        && c[0]?.media?.mimeType === 'text/markdown',
    );
    expect(docCreate).toBeDefined();
  });

  it('publish without tribu throws', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.publish({ title: 'T', markdown: '# T', doc_kind: 'prd', flow_folder: 'f' }, ctx),
    ).rejects.toThrow('tribu and squad are required');
  });

  it('publish adr uses adr/ subfolder; .md is NNNN-slug.md and Doc is NNNN-slug', async () => {
    const driveApi = google.drive({ version: 'v3', auth: {} as any });
    (driveApi.files.list as any).mockResolvedValue({ data: { files: [] } });
    let createSeq = 0;
    (driveApi.files.create as any).mockImplementation(async () => {
      createSeq++;
      const id = `adr-${createSeq}`;
      return { data: { id, webViewLink: `https://drive.google.com/file/${id}` } };
    });
    const adapter = makeAdapter();
    (adapter as any).drive = driveApi;

    const ref = await adapter.publish({
      title: 'Use Postgres',
      markdown: '# ADR',
      doc_kind: 'adr',
      flow_folder: 'checkout-cuotas',
      tribu: 'Tribu-A',
      squad: 'Squad-B',
      adr_filename: '0001-use-postgres.md',
    }, ctx);

    expect(ref.id).toBeDefined();
    expect(ref.gdoc_id).toBeDefined();

    const createCalls = (driveApi.files.create as any).mock.calls as any[];
    // adr/ subfolder created
    const adrFolderCreate = createCalls.find(
      (c: any[]) => c[0]?.requestBody?.name === 'adr'
        && c[0]?.requestBody?.mimeType === 'application/vnd.google-apps.folder',
    );
    expect(adrFolderCreate).toBeDefined();
    // .md named 0001-use-postgres.md
    const mdCreate = createCalls.find((c: any[]) => c[0]?.requestBody?.name === '0001-use-postgres.md');
    expect(mdCreate).toBeDefined();
    // Doc named 0001-use-postgres (no extension), converted
    const docCreate = createCalls.find(
      (c: any[]) => c[0]?.requestBody?.name === '0001-use-postgres'
        && c[0]?.requestBody?.mimeType === 'application/vnd.google-apps.document',
    );
    expect(docCreate).toBeDefined();
  });

  it('ensureFolderPath reuses existing folder (no extra folder create)', async () => {
    const driveApi = google.drive({ version: 'v3', auth: {} as any });
    // Folder lists return a hit; object lists (for the two upserts) return empty.
    (driveApi.files.list as any).mockImplementation(async (params: any) => {
      const q: string = params.q ?? '';
      if (q.includes("mimeType='application/vnd.google-apps.folder'")) {
        return { data: { files: [{ id: 'existing-folder' }] } };
      }
      return { data: { files: [] } }; // both .md and Doc absent
    });
    (driveApi.files.create as any).mockResolvedValue({
      data: { id: 'obj-id', webViewLink: 'https://drive.google.com/file/obj-id' },
    });
    const adapter = makeAdapter();
    (adapter as any).drive = driveApi;

    await adapter.publish({
      title: 'PRD', markdown: '# PRD',
      doc_kind: 'prd', flow_folder: 'my-flow',
      tribu: 'T', squad: 'S',
    }, ctx);

    // create should only be called for the two objects, not for folders
    const createCalls = (driveApi.files.create as any).mock.calls as any[];
    const folderCreates = createCalls.filter(
      (c: any[]) => c[0]?.requestBody?.mimeType === 'application/vnd.google-apps.folder'
    );
    expect(folderCreates).toHaveLength(0);
  });

  it('idempotent re-publish: BOTH .md and Doc are UPDATED (no duplicate create)', async () => {
    const driveApi = google.drive({ version: 'v3', auth: {} as any });
    // Folders exist; the .md (text/markdown) and Doc (application/vnd.google-apps.document) already exist.
    (driveApi.files.list as any).mockImplementation(async (params: any) => {
      const q: string = params.q ?? '';
      if (q.includes("mimeType='application/vnd.google-apps.folder'")) {
        return { data: { files: [{ id: 'folder-x' }] } };
      }
      if (q.includes("mimeType='text/markdown'")) {
        return { data: { files: [{ id: 'existing-md-id' }] } };
      }
      if (q.includes("mimeType='application/vnd.google-apps.document'")) {
        return { data: { files: [{ id: 'existing-doc-id' }] } };
      }
      return { data: { files: [] } };
    });
    (driveApi.files.update as any).mockImplementation(async (params: any) => ({
      data: { id: params.fileId, webViewLink: `https://drive.google.com/file/${params.fileId}` },
    }));
    const adapter = makeAdapter();
    (adapter as any).drive = driveApi;

    const ref = await adapter.publish({
      title: 'PRD', markdown: '# PRD',
      doc_kind: 'prd', flow_folder: 'my-flow',
      tribu: 'T', squad: 'S',
    }, ctx);

    // No object create at all — both updated in place.
    const objectCreates = ((driveApi.files.create as any).mock.calls as any[]).filter(
      (c: any[]) => c[0]?.requestBody?.mimeType !== 'application/vnd.google-apps.folder',
    );
    expect(objectCreates).toHaveLength(0);
    expect(driveApi.files.update).toHaveBeenCalledTimes(2); // .md + Doc
    expect(ref.id).toBe('existing-md-id');
    expect(ref.gdoc_id).toBe('existing-doc-id');
  });

  it('mixed state: .md exists (update) but Doc absent (create)', async () => {
    const driveApi = google.drive({ version: 'v3', auth: {} as any });
    (driveApi.files.list as any).mockImplementation(async (params: any) => {
      const q: string = params.q ?? '';
      if (q.includes("mimeType='application/vnd.google-apps.folder'")) {
        return { data: { files: [{ id: 'folder-x' }] } };
      }
      if (q.includes("mimeType='text/markdown'")) {
        return { data: { files: [{ id: 'existing-md-id' }] } };
      }
      return { data: { files: [] } }; // Doc absent
    });
    (driveApi.files.update as any).mockResolvedValue({
      data: { id: 'existing-md-id', webViewLink: 'https://drive.google.com/file/existing-md-id' },
    });
    (driveApi.files.create as any).mockResolvedValue({
      data: { id: 'new-doc-id', webViewLink: 'https://drive.google.com/file/new-doc-id' },
    });
    const adapter = makeAdapter();
    (adapter as any).drive = driveApi;

    const ref = await adapter.publish({
      title: 'PRD', markdown: '# PRD',
      doc_kind: 'prd', flow_folder: 'my-flow',
      tribu: 'T', squad: 'S',
    }, ctx);

    expect(driveApi.files.update).toHaveBeenCalledOnce(); // the .md
    const docCreate = ((driveApi.files.create as any).mock.calls as any[]).find(
      (c: any[]) => c[0]?.requestBody?.mimeType === 'application/vnd.google-apps.document',
    );
    expect(docCreate).toBeDefined();
    expect(ref.id).toBe('existing-md-id');
    expect(ref.gdoc_id).toBe('new-doc-id');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @sdlc/server test google-drive-docstore`
Expected: FAIL — cannot find `../src/adapters/google-drive-docstore.js`.

- [ ] **Step 3: Write the adapter**

Create `apps/server/src/adapters/google-drive-docstore.ts`:

```ts
import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { DocPublishInput, DocRef, DocStoreAdapter, DocStoreKind } from '@sdlc/adapters-contracts';
import type { TenantCtx } from '@sdlc/adapters-contracts';

export interface GoogleDriveDocStoreAdapterOptions {
  serviceAccountJson: string;
  sharedDriveId: string;
}

export class GoogleDriveDocStoreAdapter implements DocStoreAdapter {
  readonly kind: DocStoreKind = 'google-drive';

  private readonly drive: drive_v3.Drive;
  private readonly sharedDriveId: string;

  constructor(opts: GoogleDriveDocStoreAdapterOptions) {
    this.sharedDriveId = opts.sharedDriveId;
    const credentials = JSON.parse(opts.serviceAccountJson) as object;
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    this.drive = google.drive({ version: 'v3', auth });
  }

  // Per OD-1 ("both"): each artifact is stored TWICE — a faithful .md file AND a native Google Doc.
  private static readonly DOC_MIME = 'application/vnd.google-apps.document';
  private static readonly MD_MIME = 'text/markdown';

  async publish(input: DocPublishInput, _ctx: TenantCtx): Promise<DocRef> {
    if (!input.tribu || !input.squad) {
      throw new Error(
        'tribu and squad are required when doc_store kind is google-drive',
      );
    }

    const folderSegments =
      input.doc_kind === 'adr'
        ? [input.tribu, input.squad, input.flow_folder, 'adr']
        : [input.tribu, input.squad, input.flow_folder];

    const leafFolderId = await this.ensureFolderPath(
      this.sharedDriveId,
      folderSegments,
    );

    // baseName has NO extension; the .md file appends ".md", the Doc uses it as-is.
    const baseName =
      input.doc_kind === 'adr'
        ? (input.adr_filename?.replace(/\.md$/, '') ?? `0001-${slugify(input.title)}`)
        : input.doc_kind; // 'prd' | 'rfc'

    // 1) faithful markdown file (matched by name + parent + text/markdown)
    const md = await this.upsertObject(
      leafFolderId,
      `${baseName}.md`,
      input.markdown,
      GoogleDriveDocStoreAdapter.MD_MIME,
    );

    // 2) native Google Doc (matched by name + parent + Doc mime; Drive converts md → Doc on import)
    const doc = await this.upsertObject(
      leafFolderId,
      baseName,
      input.markdown,
      GoogleDriveDocStoreAdapter.DOC_MIME,
      GoogleDriveDocStoreAdapter.DOC_MIME,
    );

    // Google Doc is the primary human-facing url; keep the .md id as the source-of-truth anchor.
    return {
      id: md.id,
      url: doc.webViewLink,
      gdoc_id: doc.id,
      gdoc_url: doc.webViewLink,
      md_url: md.webViewLink,
    };
  }

  async fetch(id: string, _ctx: TenantCtx): Promise<{ markdown: string; version: string }> {
    const res = await this.drive.files.get({
      fileId: id,
      alt: 'media',
      supportsAllDrives: true,
    } as drive_v3.Params$Resource$Files$Get);
    return { markdown: res.data as unknown as string, version: id };
  }

  /** Walk folder segments from the shared drive root, creating missing folders. */
  private async ensureFolderPath(
    rootId: string,
    segments: string[],
  ): Promise<string> {
    let parentId = rootId;
    for (const segment of segments) {
      parentId = await this.ensureFolder(parentId, segment);
    }
    return parentId;
  }

  private async ensureFolder(parentId: string, name: string): Promise<string> {
    const q = `name=${JSON.stringify(name)} and ${JSON.stringify(parentId)} in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const list = await this.drive.files.list({
      q,
      corpora: 'drive',
      driveId: this.sharedDriveId,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields: 'files(id)',
      pageSize: 1,
    });
    const existing = list.data.files?.[0];
    if (existing?.id) return existing.id;

    const created = await this.drive.files.create({
      supportsAllDrives: true,
      fields: 'id',
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      },
    });
    if (!created.data.id) {
      throw new Error(`Failed to create folder "${name}" under parent "${parentId}"`);
    }
    return created.data.id;
  }

  /**
   * Upsert ONE Drive object, matched by name + parent + mimeType so the .md file and
   * the Google Doc never collide. The media body is always uploaded as text/markdown;
   * pass `targetMimeType='application/vnd.google-apps.document'` to have Drive convert
   * the markdown into a native Doc on import.
   */
  private async upsertObject(
    parentFolderId: string,
    name: string,
    body: string,
    matchMimeType: string,
    targetMimeType?: string,
  ): Promise<{ id: string; webViewLink: string }> {
    const q = `name=${JSON.stringify(name)} and ${JSON.stringify(parentFolderId)} in parents and mimeType=${JSON.stringify(matchMimeType)} and trashed=false`;
    const list = await this.drive.files.list({
      q,
      corpora: 'drive',
      driveId: this.sharedDriveId,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields: 'files(id)',
      pageSize: 1,
    });
    const existing = list.data.files?.[0];

    // Always feed Drive the markdown bytes; conversion (if any) is driven by requestBody.mimeType.
    const media = { mimeType: GoogleDriveDocStoreAdapter.MD_MIME, body };

    if (existing?.id) {
      const updated = await this.drive.files.update({
        fileId: existing.id,
        supportsAllDrives: true,
        fields: 'id,webViewLink',
        media,
      });
      return {
        id: updated.data.id ?? existing.id,
        webViewLink: updated.data.webViewLink ?? '',
      };
    }

    const created = await this.drive.files.create({
      supportsAllDrives: true,
      fields: 'id,webViewLink',
      requestBody: {
        name,
        parents: [parentFolderId],
        // Setting the Doc mimeType here tells Drive to convert the imported markdown to a Doc.
        ...(targetMimeType ? { mimeType: targetMimeType } : {}),
      },
      media,
    });
    return {
      id: created.data.id ?? '',
      webViewLink: created.data.webViewLink ?? '',
    };
  }
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'adr';
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @sdlc/server test google-drive-docstore`
Expected: PASS (6 tests). Fix any mismatches between mock call shapes and the actual implementation until all 6 pass. The two key assertions are: (a) every publish upserts BOTH a `text/markdown` object AND an `application/vnd.google-apps.document` object, and (b) on re-publish both are updated (no duplicate create).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @sdlc/server typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/adapters/google-drive-docstore.ts apps/server/test/google-drive-docstore.test.ts
git commit -m "feat(adapters): GoogleDriveDocStoreAdapter publishes both .md file + native Google Doc (idempotent per-object upsert)"
```

---

## Task 8: `DocStoreProvider` + `NoOpDocStoreAdapter`

**Files:**
- Create: `apps/server/src/adapters/doc-store-provider.ts`
- Modify: `apps/server/src/adapters/index.ts`
- Test: `apps/server/test/doc-store-provider.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/doc-store-provider.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Flow } from '@sdlc/core';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import {
  ConfigBackedDocStoreProvider,
  NoOpDocStoreAdapter,
} from '../src/adapters/doc-store-provider.js';

const FLOW = {
  flow_id: 't1:p1:slug',
  tenant_id: 't1',
  project: 'p1',
  slug: 'slug',
} as Flow;

const ctx: TenantCtx = {
  tenantId: 't1', userId: 'u', roles: [],
  resolveSecret: async () => SA_JSON,
};

const SA_JSON = JSON.stringify({ type: 'service_account', client_email: 'x@y.iam', private_key: 'FAKE' });

// Prevent googleapis from making real network calls in provider test
vi.mock('../src/adapters/google-drive-docstore.js', () => ({
  GoogleDriveDocStoreAdapter: vi.fn().mockImplementation(() => ({
    kind: 'google-drive',
    publish: vi.fn(),
    fetch: vi.fn(),
  })),
}));
import { GoogleDriveDocStoreAdapter } from '../src/adapters/google-drive-docstore.js';

describe('ConfigBackedDocStoreProvider', () => {
  it('returns NoOpDocStoreAdapter when no doc_store config', async () => {
    const store = new InMemoryIntegrationConfigStore();
    const provider = new ConfigBackedDocStoreProvider({ configStore: store });
    const adapter = await provider.resolve(ctx, FLOW);
    expect(adapter).toBeInstanceOf(NoOpDocStoreAdapter);
  });

  it('returns NoOpDocStoreAdapter for kind="repo"', async () => {
    const store = new InMemoryIntegrationConfigStore();
    store.seed('t1', 'p1', { doc_store: { kind: 'repo', settings: {} } });
    const provider = new ConfigBackedDocStoreProvider({ configStore: store });
    const adapter = await provider.resolve(ctx, FLOW);
    expect(adapter).toBeInstanceOf(NoOpDocStoreAdapter);
  });

  it('builds GoogleDriveDocStoreAdapter for kind="google-drive"', async () => {
    const store = new InMemoryIntegrationConfigStore();
    store.seed('t1', 'p1', {
      doc_store: {
        kind: 'google-drive',
        secret_ref: 'aws-sm://gdrive-sa',
        settings: { sharedDriveId: '0APm8ey814gtwUk9PVA' },
      },
    });
    const provider = new ConfigBackedDocStoreProvider({ configStore: store });
    const adapter = await provider.resolve(ctx, FLOW);
    expect(GoogleDriveDocStoreAdapter).toHaveBeenCalledWith({
      serviceAccountJson: SA_JSON,
      sharedDriveId: '0APm8ey814gtwUk9PVA',
    });
    expect(adapter.kind).toBe('google-drive');
  });

  it('throws when google-drive has no secret_ref', async () => {
    const store = new InMemoryIntegrationConfigStore();
    store.seed('t1', 'p1', {
      doc_store: { kind: 'google-drive', settings: {} },
    });
    const provider = new ConfigBackedDocStoreProvider({ configStore: store });
    await expect(provider.resolve(ctx, FLOW)).rejects.toThrow('secret_ref');
  });

  it('throws for unknown kind', async () => {
    const store = new InMemoryIntegrationConfigStore();
    store.seed('t1', 'p1', { doc_store: { kind: 'notion', settings: {} } });
    const provider = new ConfigBackedDocStoreProvider({ configStore: store });
    await expect(provider.resolve(ctx, FLOW)).rejects.toThrow(/unknown doc_store kind: notion/);
  });
});

describe('NoOpDocStoreAdapter', () => {
  it('publish returns a stub DocRef without throwing', async () => {
    const noop = new NoOpDocStoreAdapter();
    const ref = await noop.publish(
      { title: 'T', markdown: '# T', doc_kind: 'prd', flow_folder: 'f' },
      ctx,
    );
    expect(ref.id).toBe('noop');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @sdlc/server test doc-store-provider`
Expected: FAIL — cannot find `../src/adapters/doc-store-provider.js`.

- [ ] **Step 3: Write `doc-store-provider.ts`**

Create `apps/server/src/adapters/doc-store-provider.ts`:

```ts
import type { DocPublishInput, DocRef, DocStoreAdapter, DocStoreKind } from '@sdlc/adapters-contracts';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { Flow } from '@sdlc/core';
import type { IntegrationConfigStore } from '../integrations/types.js';
import { GoogleDriveDocStoreAdapter } from './google-drive-docstore.js';

export interface DocStoreProvider {
  resolve(ctx: TenantCtx, flow: Flow): Promise<DocStoreAdapter>;
}

export interface ConfigBackedDocStoreProviderDeps {
  configStore: IntegrationConfigStore;
}

export class ConfigBackedDocStoreProvider implements DocStoreProvider {
  constructor(private readonly deps: ConfigBackedDocStoreProviderDeps) {}

  async resolve(ctx: TenantCtx, flow: Flow): Promise<DocStoreAdapter> {
    const cfg = await this.deps.configStore.getDocStoreConfig(ctx.tenantId, flow.project);
    if (!cfg || cfg.kind === 'repo') {
      return new NoOpDocStoreAdapter();
    }
    switch (cfg.kind) {
      case 'google-drive': {
        if (!cfg.secret_ref) {
          throw new Error(
            'google-drive doc_store requires a secret_ref for the service-account JSON',
          );
        }
        const serviceAccountJson = await ctx.resolveSecret(cfg.secret_ref);
        const sharedDriveId =
          typeof cfg.settings.sharedDriveId === 'string'
            ? cfg.settings.sharedDriveId
            : '0APm8ey814gtwUk9PVA';
        return new GoogleDriveDocStoreAdapter({ serviceAccountJson, sharedDriveId });
      }
      default:
        throw new Error(`unknown doc_store kind: ${cfg.kind}`);
    }
  }
}

/**
 * No-op fallback used when no doc_store is configured for the tenant/project.
 * Returns a stub DocRef so the tool flow continues without Drive publication.
 */
export class NoOpDocStoreAdapter implements DocStoreAdapter {
  readonly kind: DocStoreKind = 'repo';

  async publish(_input: DocPublishInput, _ctx: TenantCtx): Promise<DocRef> {
    return { id: 'noop', url: '' };
  }

  async fetch(_id: string, _ctx: TenantCtx): Promise<{ markdown: string; version: string }> {
    return { markdown: '', version: 'noop' };
  }
}
```

- [ ] **Step 4: Export from adapters barrel**

In `apps/server/src/adapters/index.ts`, add:
```ts
export * from './doc-store-provider.js';
export * from './google-drive-docstore.js';
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @sdlc/server test doc-store-provider`
Expected: PASS (6 tests).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @sdlc/server typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/adapters/doc-store-provider.ts apps/server/src/adapters/index.ts apps/server/test/doc-store-provider.test.ts
git commit -m "feat(adapters): DocStoreProvider + ConfigBackedDocStoreProvider + NoOpDocStoreAdapter"
```

---

## Task 9: Wire `submit_prd` to publish via doc store

**Files:**
- Modify: `apps/server/src/mcp/tools/submit-prd.ts`
- Test: `apps/server/test/submit-prd-with-drive.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/submit-prd-with-drive.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { Flow } from '@sdlc/core';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { makeSubmitPrdTool } from '../src/mcp/tools/submit-prd.js';
import type { DocStoreProvider } from '../src/adapters/doc-store-provider.js';
import { NoOpDocStoreAdapter } from '../src/adapters/doc-store-provider.js';

const ctx: TenantCtx = {
  tenantId: 't1', userId: 'u', roles: [],
  resolveSecret: async () => { throw new Error('not used'); },
};

// Minimal valid PRD markdown (satisfies validatePrd)
const PRD = `# PRD

## Problem
Users cannot pay in installments on checkout.

## Users
Online shoppers in LATAM.

## Success Metrics
- Conversion +5 %

## Scope
Installments via Cuota-API.

## Out of Scope
Debit card flows.

## Risks
- Cuota-API downtime risk.
`;

describe('submit_prd with DocStoreProvider', () => {
  it('stores Drive url in prd_ref when docStore.publish returns a real DocRef', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({
      tenant_id: 't1', project: 'p1', slug: 'drive-test', title: 'Drive test',
      tribu: 'Tribu-A', squad: 'Squad-B',
    });

    // DocRef carries both: url=Google Doc, id=.md file, gdoc_id=Google Doc id
    const fakeRef = {
      id: 'md-file-id',
      url: 'https://docs.google.com/document/d/gdoc-id/edit',
      gdoc_id: 'gdoc-id',
      gdoc_url: 'https://docs.google.com/document/d/gdoc-id/edit',
      md_url: 'https://drive.google.com/file/md-file-id',
    };
    const fakeAdapter = { kind: 'google-drive' as const, publish: vi.fn().mockResolvedValue(fakeRef), fetch: vi.fn() };
    const docStoreProvider: DocStoreProvider = {
      resolve: vi.fn().mockResolvedValue(fakeAdapter),
    };

    const tool = makeSubmitPrdTool(store, docStoreProvider);
    const result = await tool.handler(
      { flow_id: flow.flow_id, prd_markdown: PRD },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect((result as any).data.flow.prd_ref.url).toBe(fakeRef.url);          // Google Doc url
    expect((result as any).data.flow.prd_ref.external_id).toBe(fakeRef.id);   // .md file id
    expect((result as any).data.flow.prd_ref.gdoc_id).toBe(fakeRef.gdoc_id);  // Google Doc id
    expect(fakeAdapter.publish).toHaveBeenCalledWith(
      expect.objectContaining({ doc_kind: 'prd', tribu: 'Tribu-A', squad: 'Squad-B' }),
      ctx,
    );
  });

  it('still succeeds (sha256 stored) when docStoreProvider returns NoOp', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({
      tenant_id: 't1', project: 'p1', slug: 'noop-test', title: 'Noop',
    });
    const docStoreProvider: DocStoreProvider = {
      resolve: vi.fn().mockResolvedValue(new NoOpDocStoreAdapter()),
    };
    const tool = makeSubmitPrdTool(store, docStoreProvider);
    const result = await tool.handler({ flow_id: flow.flow_id, prd_markdown: PRD }, ctx);

    expect(result.ok).toBe(true);
    expect((result as any).data.flow.prd_ref.sha256).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @sdlc/server test submit-prd-with-drive`
Expected: FAIL — `makeSubmitPrdTool` does not accept a second argument.

- [ ] **Step 3: Modify `submit-prd.ts`**

In `apps/server/src/mcp/tools/submit-prd.ts`:

Add import:
```ts
import type { DocStoreProvider } from '../../adapters/doc-store-provider.js';
```

Change factory signature:
```ts
export function makeSubmitPrdTool(store: FlowStore, docStoreProvider: DocStoreProvider) {
```

Inside the handler, after the `prd_ref` object is assembled and before `store.updateFlow`, add:
```ts
      // Publish to doc store (no-op if unconfigured)
      try {
        const ds = await docStoreProvider.resolve(ctx, flow);
        const docRef = await ds.publish({
          title: `PRD: ${flow.title}`,
          markdown: input.prd_markdown,
          doc_kind: 'prd',
          flow_folder: flow.slug,
          tribu: flow.tribu,
          squad: flow.squad,
        }, ctx);
        // Capture BOTH locations (OD-1 "both"): url=Google Doc, external_id=.md file id, gdoc_id=Doc id.
        if (docRef.url) prd_ref.url = docRef.url;
        if (docRef.id && docRef.id !== 'noop') prd_ref.external_id = docRef.id;
        if (docRef.gdoc_id) prd_ref.gdoc_id = docRef.gdoc_id;
      } catch (err) {
        // Non-fatal: log and continue. The sha256 is always stored.
        // In production, operators should check the event log for publish failures.
        console.warn('[submit_prd] doc store publish failed:', (err as Error).message);
      }
```

After the `store.updateFlow` call (after the existing `appendEvent`), add a second event when `prd_ref.url` is set:
```ts
      if (prd_ref.url) {
        await store.appendEvent({
          flow_id: flow.flow_id,
          type: 'prd.published',
          actor: ctx.userId,
          payload: { drive_url: prd_ref.url, drive_id: prd_ref.external_id ?? null, gdoc_id: prd_ref.gdoc_id ?? null },
        });
      }
```

Note: `prd_ref` uses the `ArtifactRef` type, which now includes `external_id` and `gdoc_id` (both `z.string().optional()` — `gdoc_id` added in Task 2 Step 1b).

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @sdlc/server test submit-prd-with-drive`
Expected: PASS (2 tests).

Run also: `pnpm --filter @sdlc/server test shaping` (regression)
Expected: PASS — if shaping tests call `makeSubmitPrdTool` they now need a second arg. See Step 5.

- [ ] **Step 5: Update existing test call sites for `makeSubmitPrdTool`**

Run:
```bash
grep -rln "makeSubmitPrdTool" apps/server/test
```
For each file found, add the import:
```ts
import { NoOpDocStoreAdapter } from '../src/adapters/doc-store-provider.js';
```
And update the `makeSubmitPrdTool(store)` call to:
```ts
const noop: import('../src/adapters/doc-store-provider.js').DocStoreProvider = {
  resolve: async () => new NoOpDocStoreAdapter(),
};
makeSubmitPrdTool(store, noop)
```
Or define a shared helper at the top of the test file.

- [ ] **Step 6: Run full server tests**

Run: `pnpm --filter @sdlc/server test`
Expected: all tests PASS.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @sdlc/server typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/mcp/tools/submit-prd.ts apps/server/test/submit-prd-with-drive.test.ts apps/server/test
git commit -m "feat(tools): submit_prd publishes to Google Drive via DocStoreProvider"
```

---

## Task 10: Wire `submit_rfc` to publish via doc store

**Files:**
- Modify: `apps/server/src/mcp/tools/submit-rfc.ts`
- Test: `apps/server/test/submit-rfc-with-drive.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/submit-rfc-with-drive.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { makeSubmitPrdTool } from '../src/mcp/tools/submit-prd.js';
import { makeSubmitRfcTool } from '../src/mcp/tools/submit-rfc.js';
import { NoOpDocStoreAdapter } from '../src/adapters/doc-store-provider.js';
import type { DocStoreProvider } from '../src/adapters/doc-store-provider.js';

const ctx: TenantCtx = {
  tenantId: 't1', userId: 'u', roles: [],
  resolveSecret: async () => { throw new Error('not used'); },
};

// Minimal valid PRD (same as other tests)
const PRD = `# PRD\n\n## Problem\nP\n\n## Users\nU\n\n## Success Metrics\nM\n\n## Scope\nS\n\n## Out of Scope\nO\n\n## Risks\nR\n`;

// Minimal valid RFC with required frontmatter sections
const RFC = `---
architecture_mode: new
codebase_status: greenfield
---

# RFC

## Context
C

## Goals
G

## Non Goals
N

## Design
D

## Risks
R

## Rollout
Rollout

## Rollback
Rollback
`;

describe('submit_rfc with DocStoreProvider', () => {
  it('stores Drive url in rfc_ref when docStore.publish returns a real DocRef', async () => {
    const store = new InMemoryFlowStore();
    const noopProvider: DocStoreProvider = { resolve: async () => new NoOpDocStoreAdapter() };
    const flow = await store.createFlow({
      tenant_id: 't1', project: 'p1', slug: 'rfc-drive-test', title: 'RFC Drive',
      tribu: 'Tribu-X', squad: 'Squad-Y',
    });
    // First submit PRD
    await makeSubmitPrdTool(store, noopProvider).handler(
      { flow_id: flow.flow_id, prd_markdown: PRD }, ctx,
    );

    const fakeRef = {
      id: 'rfc-md-id',
      url: 'https://docs.google.com/document/d/rfc-gdoc-id/edit',
      gdoc_id: 'rfc-gdoc-id',
    };
    const fakeAdapter = { kind: 'google-drive' as const, publish: vi.fn().mockResolvedValue(fakeRef), fetch: vi.fn() };
    const rfcProvider: DocStoreProvider = { resolve: vi.fn().mockResolvedValue(fakeAdapter) };

    const result = await makeSubmitRfcTool(store, rfcProvider).handler(
      { flow_id: flow.flow_id, rfc_markdown: RFC, repo_path: '/docs/rfc/test.md' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect((result as any).data.flow.rfc_ref.url).toBe(fakeRef.url);             // Google Doc url
    expect((result as any).data.flow.rfc_ref.external_id).toBe(fakeRef.id);      // .md file id
    expect((result as any).data.flow.rfc_ref.gdoc_id).toBe(fakeRef.gdoc_id);     // Google Doc id
    expect(fakeAdapter.publish).toHaveBeenCalledWith(
      expect.objectContaining({ doc_kind: 'rfc', tribu: 'Tribu-X', squad: 'Squad-Y' }),
      ctx,
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @sdlc/server test submit-rfc-with-drive`
Expected: FAIL.

- [ ] **Step 3: Modify `submit-rfc.ts`**

Mirror the pattern from Task 9 / `submit-prd.ts`:

Add import:
```ts
import type { DocStoreProvider } from '../../adapters/doc-store-provider.js';
```

Change factory signature:
```ts
export function makeSubmitRfcTool(store: FlowStore, docStoreProvider: DocStoreProvider) {
```

After the `patch` object is built and before `store.updateFlow`, add the doc-store publish block (same error-swallowing try/catch pattern as submit-prd):
```ts
      try {
        const ds = await docStoreProvider.resolve(ctx, flow);
        const docRef = await ds.publish({
          title: `RFC: ${flow.title}`,
          markdown: input.rfc_markdown,
          doc_kind: 'rfc',
          flow_folder: flow.slug,
          tribu: flow.tribu,
          squad: flow.squad,
        }, ctx);
        // Capture BOTH locations (OD-1 "both").
        if (docRef.url) patch.rfc_ref = { ...patch.rfc_ref, url: docRef.url };
        if (docRef.id && docRef.id !== 'noop') {
          patch.rfc_ref = { ...patch.rfc_ref, external_id: docRef.id };
        }
        if (docRef.gdoc_id) {
          patch.rfc_ref = { ...patch.rfc_ref, gdoc_id: docRef.gdoc_id };
        }
      } catch (err) {
        console.warn('[submit_rfc] doc store publish failed:', (err as Error).message);
      }
```

After the existing `appendEvent`, add:
```ts
      if (patch.rfc_ref?.url) {
        await store.appendEvent({
          flow_id: flow.flow_id,
          type: 'rfc.published',
          actor: ctx.userId,
          payload: { drive_url: patch.rfc_ref.url, drive_id: patch.rfc_ref.external_id ?? null, gdoc_id: patch.rfc_ref.gdoc_id ?? null },
        });
      }
```

- [ ] **Step 4: Update existing `makeSubmitRfcTool` call sites**

Run:
```bash
grep -rln "makeSubmitRfcTool" apps/server/test
```
For each: add `NoOpDocStoreAdapter` import and update call to `makeSubmitRfcTool(store, noopProvider)`.

- [ ] **Step 5: Run full server tests + typecheck**

```bash
pnpm --filter @sdlc/server test
pnpm --filter @sdlc/server typecheck
```
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/mcp/tools/submit-rfc.ts apps/server/test/submit-rfc-with-drive.test.ts apps/server/test
git commit -m "feat(tools): submit_rfc publishes to Google Drive via DocStoreProvider"
```

---

## Task 11: `submit_adr` tool

**Files:**
- Create: `apps/server/src/mcp/tools/submit-adr.ts`
- Test: `apps/server/test/submit-adr.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/submit-adr.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { makeSubmitAdrTool } from '../src/mcp/tools/submit-adr.js';
import { NoOpDocStoreAdapter } from '../src/adapters/doc-store-provider.js';
import type { DocStoreProvider } from '../src/adapters/doc-store-provider.js';

const ctx: TenantCtx = {
  tenantId: 't1', userId: 'u', roles: [],
  resolveSecret: async () => { throw new Error('not used'); },
};

const ADR = `# ADR: Use PostgreSQL

## Status
Accepted

## Context
We need a relational database.

## Decision
We will use PostgreSQL.

## Consequences
Requires DBA expertise.
`;

describe('submit_adr', () => {
  it('publishes adr and increments adr_count on flow', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({
      tenant_id: 't1', project: 'p1', slug: 'adr-flow', title: 'ADR flow',
      tribu: 'T', squad: 'S',
    });

    const fakeRef = {
      id: 'adr-md-id',
      url: 'https://docs.google.com/document/d/adr-gdoc-id/edit',
      gdoc_id: 'adr-gdoc-id',
    };
    const fakeAdapter = { kind: 'google-drive' as const, publish: vi.fn().mockResolvedValue(fakeRef), fetch: vi.fn() };
    const provider: DocStoreProvider = { resolve: vi.fn().mockResolvedValue(fakeAdapter) };

    const tool = makeSubmitAdrTool(store, provider);
    const result = await tool.handler(
      { flow_id: flow.flow_id, title: 'Use Postgres', adr_markdown: ADR },
      ctx,
    );

    expect(result.ok).toBe(true);
    const updatedFlow = await store.getFlow(flow.flow_id);
    expect(updatedFlow?.adr_count).toBe(1);
    expect(updatedFlow?.adr_refs).toHaveLength(1);
    expect(updatedFlow?.adr_refs?.[0].url).toBe(fakeRef.url);              // Google Doc url
    expect(updatedFlow?.adr_refs?.[0].external_id).toBe(fakeRef.id);       // .md file id
    expect(updatedFlow?.adr_refs?.[0].gdoc_id).toBe(fakeRef.gdoc_id);      // Google Doc id

    expect(fakeAdapter.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        doc_kind: 'adr',
        adr_filename: '0001-use-postgres.md',
        tribu: 'T',
        squad: 'S',
      }),
      ctx,
    );
  });

  it('returns ok:false for unknown flow', async () => {
    const store = new InMemoryFlowStore();
    const provider: DocStoreProvider = { resolve: async () => new NoOpDocStoreAdapter() };
    const tool = makeSubmitAdrTool(store, provider);
    const result = await tool.handler({ flow_id: 'no-such-flow', title: 'T', adr_markdown: ADR }, ctx);
    expect(result.ok).toBe(false);
  });

  it('returns ok:false for wrong tenant', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({ tenant_id: 'other', project: 'p', slug: 's', title: 'T' });
    const provider: DocStoreProvider = { resolve: async () => new NoOpDocStoreAdapter() };
    const tool = makeSubmitAdrTool(store, provider);
    const result = await tool.handler({ flow_id: flow.flow_id, title: 'T', adr_markdown: ADR }, ctx);
    expect(result.ok).toBe(false);
  });

  it('second submit increments counter to 2', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({ tenant_id: 't1', project: 'p1', slug: 'adr2', title: 'T' });
    const provider: DocStoreProvider = { resolve: async () => new NoOpDocStoreAdapter() };
    const tool = makeSubmitAdrTool(store, provider);
    await tool.handler({ flow_id: flow.flow_id, title: 'First', adr_markdown: ADR }, ctx);
    await tool.handler({ flow_id: flow.flow_id, title: 'Second', adr_markdown: ADR }, ctx);
    const updated = await store.getFlow(flow.flow_id);
    expect(updated?.adr_count).toBe(2);
    expect(updated?.adr_refs).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @sdlc/server test submit-adr`
Expected: FAIL — cannot find `../src/mcp/tools/submit-adr.js`.

- [ ] **Step 3: Write `submit-adr.ts`**

Create `apps/server/src/mcp/tools/submit-adr.ts`:

```ts
import { z } from 'zod';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';
import type { DocStoreProvider } from '../../adapters/doc-store-provider.js';

export const SubmitAdrInput = z.object({
  flow_id:      z.string().min(1),
  title:        z.string().min(3),
  adr_markdown: z.string().min(50),
});
export type SubmitAdrInput = z.infer<typeof SubmitAdrInput>;

export function makeSubmitAdrTool(store: FlowStore, docStoreProvider: DocStoreProvider) {
  return {
    name: 'submit_adr',
    description:
      'Publishes an Architecture Decision Record (ADR) markdown for a flow to the configured doc store. ' +
      'ADRs are stored under the flow\'s adr/ subfolder with an incrementing filename (e.g. 0001-title.md). ' +
      'Can be called at any phase once the flow exists.',
    inputSchema: SubmitAdrInput,
    handler: async (input: SubmitAdrInput, ctx: TenantCtx) => {
      const flow = await store.getFlow(input.flow_id);
      if (!flow) return { ok: false, error: `Unknown flow: ${input.flow_id}` };
      if (flow.tenant_id !== ctx.tenantId) {
        return { ok: false, error: 'Flow belongs to a different tenant' };
      }

      const adrIndex = (flow.adr_count ?? 0) + 1;
      const adr_filename = `${String(adrIndex).padStart(4, '0')}-${slugify(input.title)}.md`;

      // Capture BOTH locations (OD-1 "both"): Google Doc url + id, plus the .md file id.
      let docUrl: string | undefined;
      let docId: string | undefined;     // .md file id (source-of-truth anchor)
      let gdocId: string | undefined;    // native Google Doc id
      try {
        const ds = await docStoreProvider.resolve(ctx, flow);
        const docRef = await ds.publish({
          title: input.title,
          markdown: input.adr_markdown,
          doc_kind: 'adr',
          flow_folder: flow.slug,
          tribu: flow.tribu,
          squad: flow.squad,
          adr_filename,
        }, ctx);
        if (docRef.url) docUrl = docRef.url;
        if (docRef.id && docRef.id !== 'noop') docId = docRef.id;
        if (docRef.gdoc_id) gdocId = docRef.gdoc_id;
      } catch (err) {
        console.warn('[submit_adr] doc store publish failed:', (err as Error).message);
      }

      const newRef = {
        ...(docUrl ? { url: docUrl } : {}),
        ...(docId ? { external_id: docId } : {}),
        ...(gdocId ? { gdoc_id: gdocId } : {}),
        sha256: undefined as string | undefined,  // ADRs don't hash content here
      };

      const existingRefs = flow.adr_refs ?? [];
      const updated = await store.updateFlow(flow.flow_id, {
        adr_refs: [...existingRefs, newRef],
        adr_count: adrIndex,
      });

      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'adr.submitted',
        actor: ctx.userId,
        payload: {
          adr_index: adrIndex,
          adr_filename,
          drive_url: docUrl ?? null,
          drive_id: docId ?? null,
          gdoc_id: gdocId ?? null,
        },
      });

      return {
        ok: true,
        data: { flow: updated, adr_filename, adr_index: adrIndex, drive_url: docUrl ?? null },
        next_actions: ['get_flow_state'],
      };
    },
  };
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'adr';
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @sdlc/server test submit-adr`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/mcp/tools/submit-adr.ts apps/server/test/submit-adr.test.ts
git commit -m "feat(tools): submit_adr tool publishes ADR to Drive adr/ subfolder"
```

---

## Task 12: Register `submit_adr` + wire providers in registry and bootstrap

**Files:**
- Modify: `apps/server/src/mcp/tools/index.ts` (**SHARED**)
- Modify: `apps/server/src/index.ts` (**SHARED**)
- Modify: `apps/server/src/mcp-stdio.ts` (**SHARED**)

- [ ] **Step 1: Update `BuildRegistryDeps` and `buildToolRegistry`**

In `apps/server/src/mcp/tools/index.ts`:

Add imports:
```ts
import type { DocStoreProvider } from '../../adapters/doc-store-provider.js';
import { makeSubmitAdrTool } from './submit-adr.js';
```

Add to `BuildRegistryDeps`:
```ts
docStoreProvider: DocStoreProvider;
```

In `buildToolRegistry`, destructure `docStoreProvider` from `deps`.

Update the two affected tool registrations:
```ts
makeSubmitPrdTool(store, docStoreProvider) as unknown as ToolDef,
makeSubmitRfcTool(store, docStoreProvider) as unknown as ToolDef,
```

Add the new tool:
```ts
makeSubmitAdrTool(store, docStoreProvider) as unknown as ToolDef,
```

Place `submit_adr` after `submit_rfc` in the tools array for logical ordering.

- [ ] **Step 2: Update `index.ts` bootstrap**

In `apps/server/src/index.ts`, after the `taskSystemProvider` construction, add:

```ts
import { ConfigBackedDocStoreProvider } from './adapters/index.js';

// (inside main())
const docStoreProvider = new ConfigBackedDocStoreProvider({
  configStore: integrationConfig.store,
});
const registry = buildToolRegistry({
  catalog,
  store: storeHandle.store,
  taskSystemProvider,
  docStoreProvider,
});
```

- [ ] **Step 3: Update `mcp-stdio.ts` bootstrap**

Mirror Step 2 in `apps/server/src/mcp-stdio.ts`:
```ts
const docStoreProvider = new ConfigBackedDocStoreProvider({
  configStore: integrationConfig.store,
});
const registry = buildToolRegistry({
  catalog, store: storeHandle.store, taskSystemProvider, docStoreProvider,
});
```

- [ ] **Step 4: Run full test suite + typecheck**

```bash
pnpm --filter @sdlc/server test
pnpm --filter @sdlc/server typecheck
pnpm turbo run build
```
Expected: all PASS / clean / build succeeds.

- [ ] **Step 5: Smoke test bootstrap**

Run (in-memory everything; no DATABASE_URL needed):
```bash
API_KEYS="demo-tenant:dev-key-12345" pnpm --filter @sdlc/server dev &
sleep 3
curl -s localhost:3000/health
curl -s localhost:3000/mcp/tools | python3 -c "import sys,json; tools=json.load(sys.stdin)['tools']; print([t['name'] for t in tools if t['name'] in ('submit_prd','submit_rfc','submit_adr')])"
kill %1
```
Expected: health returns OK; tool list includes `submit_prd`, `submit_rfc`, `submit_adr`.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/mcp/tools/index.ts apps/server/src/index.ts apps/server/src/mcp-stdio.ts
git commit -m "feat(server): wire DocStoreProvider into registry and bootstrap entrypoints"
```

---

## Task 13: Optional live integration test

**Files:**
- Create: `apps/server/test/gdrive-docstore.integration.test.ts`

This task is OPTIONAL and is skipped unless `GDRIVE_TEST_SA_JSON` and `GDRIVE_TEST_DRIVE_ID` are set. Do not block the PR on this test.

- [ ] **Step 1: Write the integration test**

Create `apps/server/test/gdrive-docstore.integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { GoogleDriveDocStoreAdapter } from '../src/adapters/google-drive-docstore.js';
import { google } from 'googleapis';

const saJson  = process.env.GDRIVE_TEST_SA_JSON;
const driveId = process.env.GDRIVE_TEST_DRIVE_ID;
const testTribu = process.env.GDRIVE_TEST_TRIBU ?? '_ci-tribu';
const testSquad = process.env.GDRIVE_TEST_SQUAD ?? '_ci-squad';
const testFlow  = `_ci-flow-${Date.now()}`;

const maybe = (saJson && driveId) ? describe : describe.skip;

maybe('GoogleDriveDocStoreAdapter (live Drive)', () => {
  let adapter: GoogleDriveDocStoreAdapter;
  let createdFileId: string | undefined;
  let createdFlowFolderId: string | undefined;

  const ctx: TenantCtx = {
    tenantId: 't1', userId: 'test', roles: [],
    resolveSecret: async () => { throw new Error('not used'); },
  };

  beforeAll(() => {
    adapter = new GoogleDriveDocStoreAdapter({
      serviceAccountJson: saJson!,
      sharedDriveId: driveId!,
    });
  });

  afterAll(async () => {
    // Clean up: delete the test flow folder (which contains all uploaded files)
    if (!createdFlowFolderId) return;
    const credentials = JSON.parse(saJson!);
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive'] });
    const drive = google.drive({ version: 'v3', auth });
    await drive.files.delete({ fileId: createdFlowFolderId, supportsAllDrives: true }).catch(() => {});
  });

  let createdGdocId: string | undefined;

  it('publishes PRD as BOTH a .md file and a native Google Doc', async () => {
    const ref = await adapter.publish({
      title: 'CI PRD',
      markdown: '# CI PRD\n\nThis is a live integration test.',
      doc_kind: 'prd',
      flow_folder: testFlow,
      tribu: testTribu,
      squad: testSquad,
    }, ctx);

    expect(ref.id).toBeTruthy();          // .md file id
    expect(ref.gdoc_id).toBeTruthy();     // native Google Doc id
    expect(ref.url).toMatch(/docs\.google\.com\/document|drive\.google\.com/);
    createdFileId = ref.id;
    createdGdocId = ref.gdoc_id;
  });

  it('re-publishing PRD is idempotent for BOTH objects (no duplicates)', async () => {
    const ref2 = await adapter.publish({
      title: 'CI PRD',
      markdown: '# CI PRD\n\nUpdated content.',
      doc_kind: 'prd',
      flow_folder: testFlow,
      tribu: testTribu,
      squad: testSquad,
    }, ctx);
    // Same ids → update both, not create new
    expect(ref2.id).toBe(createdFileId);
    expect(ref2.gdoc_id).toBe(createdGdocId);
  });

  it('uploads an ADR into the adr/ subfolder as both .md and Doc', async () => {
    const ref = await adapter.publish({
      title: 'Use Postgres',
      markdown: '# ADR 0001\n\nWe use Postgres.',
      doc_kind: 'adr',
      flow_folder: testFlow,
      tribu: testTribu,
      squad: testSquad,
      adr_filename: '0001-use-postgres.md',
    }, ctx);
    expect(ref.id).toBeTruthy();        // 0001-use-postgres.md
    expect(ref.gdoc_id).toBeTruthy();   // Doc 0001-use-postgres
  });

  it('fetch returns the uploaded markdown', async () => {
    if (!createdFileId) return;
    const { markdown } = await adapter.fetch(createdFileId, ctx);
    expect(markdown).toContain('Updated content');
  });
});
```

- [ ] **Step 2: Verify it is skipped without env vars**

Run: `pnpm --filter @sdlc/server test gdrive-docstore.integration`
Expected: `1 suite skipped` (no failures).

- [ ] **Step 3: Commit**

```bash
git add apps/server/test/gdrive-docstore.integration.test.ts
git commit -m "test(drive): optional live integration test for GoogleDriveDocStoreAdapter"
```

---

## Task 14: Run migration + Postgres integration test (optional)

This task requires a running Postgres with migration `0004` applied. Skip if no `TEST_DATABASE_URL`.

- [ ] **Step 1: Apply migrations**

```bash
docker compose -f infra/compose.yml up -d postgres
TEST_DATABASE_URL="postgres://sdlc:sdlc@localhost:5432/sdlc" \
  pnpm --filter @sdlc/server db:migrate
```
Expected: migration `0004_flows_tribu_squad_adr` appears in the migration log.

- [ ] **Step 2: Run Postgres flow store integration test**

```bash
TEST_DATABASE_URL="postgres://sdlc:sdlc@localhost:5432/sdlc" \
  pnpm --filter @sdlc/server test postgres-flow-store.integration
```
Expected: all tests PASS including any that exercise `tribu`/`squad` fields.

- [ ] **Step 3: Add Postgres round-trip assertions for new columns to integration test**

In `apps/server/test/postgres-flow-store.integration.test.ts`, add a test case:
```ts
it('stores and retrieves tribu, squad, adr_count', async () => {
  const flow = await store.createFlow({
    tenant_id: IT_TENANT,
    project: 'proj-adr',
    slug: `tribu-adr-${Date.now()}`,
    title: 'Tribu test',
    tribu: 'Tribu-A',
    squad: 'Squad-B',
  });
  expect(flow.tribu).toBe('Tribu-A');
  expect(flow.squad).toBe('Squad-B');
  expect(flow.adr_count).toBe(0);

  const updated = await store.updateFlow(flow.flow_id, {
    adr_refs: [{ url: 'https://example.com', external_id: 'x' }],
    adr_count: 1,
  });
  expect(updated.adr_count).toBe(1);
  expect(updated.adr_refs).toHaveLength(1);
});
```

- [ ] **Step 4: Commit**

```bash
git add apps/server/test/postgres-flow-store.integration.test.ts
git commit -m "test(postgres): add Postgres round-trip assertions for tribu/squad/adr columns"
```

---

## Self-Review Notes

- **OD-1 = "both" (resolved):** Every artifact is published as BOTH a faithful `.md` file (`text/markdown`) AND a native Google Doc (`application/vnd.google-apps.document`, converted from the markdown on import), co-located in the flow folder. Idempotency is per-object, matched on name+parent+mimeType. `DocRef` shape: `id` = `.md` file id, `url`/`gdoc_url` = Google Doc URL, `gdoc_id` = Google Doc id, `md_url` = `.md` URL. Persisted `ArtifactRef`: `url` ← Google Doc, `external_id` ← `.md` id, `gdoc_id` ← Doc id, `sha256` unchanged. Implemented in T1 (DocRef fields), T2 (`gdoc_id` on ArtifactRef), T7 (adapter dual upsert), T9/T10/T11 (tools persist combined ref).
- **Spec coverage:** Contract extension incl. DocRef gdoc fields (T1) · Flow model + ArtifactRef.gdoc_id (T2) · Drizzle schema + migration 0004 (T3) · FlowStore extension (T4) · start_flow tribu/squad (T5) · googleapis dep (T6) · GoogleDriveDocStoreAdapter with folder ensure + dual (.md + Doc) per-object upsert, mocked (T7) · DocStoreProvider + NoOp + barrel (T8) · submit_prd Drive integration (T9) · submit_rfc Drive integration (T10) · submit_adr new tool (T11) · registry + bootstrap wiring (T12) · optional live integration test (T13) · optional Postgres test (T14). Tests assert BOTH a `text/markdown` file AND an `application/vnd.google-apps.document` are upserted, and that re-publish updates (does not duplicate) each (T7, T13). Error handling (missing tribu/squad, SA missing, Drive errors, noop fallback) covered in T7/T8. Existing tests kept green via NoOp provider in T9/T10.
- **Backward compatibility:** All existing tests that call `makeSubmitPrdTool(store)` and `makeSubmitRfcTool(store)` must be updated to pass a `NoOpDocStoreAdapter` provider (T9 Step 5, T10 Step 4). The `start_flow` schema change is purely additive. Migration `0004` uses `ADD COLUMN IF NOT EXISTS`.
- **Shared files:** `index.ts`, `mcp-stdio.ts`, `mcp/tools/index.ts`, `state/schema.ts` are marked **SHARED** in task headers — coordinate with Slice 2/4 before merging.
- **Migration collision:** Slice 4 must use migration `0005`. Do not let Slice 4 claim `0004`.
- **Operational prerequisite (not code):** The service-account email must be added as a Contributor to the shared Drive `0APm8ey814gtwUk9PVA` before any production call succeeds.
