# Real Adapters — Slice 3: Google Drive DocStore (PRD/RFC/ADR + Tribu/Squad/Flow folders)

**Date:** 2026-06-10
**Status:** design approved, awaiting implementation plan

---

## Open Decisions

Each item states the recommendation and rationale. The implementing agent must confirm these with the project owner before coding starts.

### OD-1: File format — `.md` upload vs. Google Docs conversion — **RESOLVED: BOTH**

**Decision (finalized): Store EACH artifact (PRD, RFC, each ADR) in the flow's Drive folder BOTH as a faithful `.md` file AND as a native Google Doc converted from the same markdown.** ("Ambos.") This supersedes the original ".md only" recommendation.

Per artifact, in the flow's folder (`Tribu/Squad/<flow>`, with ADRs under `adr/`), `publish` produces two co-located Drive objects:
1. **Faithful markdown file** `<name>.md` with `mimeType: 'text/markdown'` — the canonical, lossless source (matches the `sha256` already recorded on the flow). `<name>` is `prd` / `rfc` / `NNNN-<slug>`.
2. **Native Google Doc** `<name>` (no extension) created by uploading the same markdown bytes with media `mimeType: 'text/markdown'` and `requestBody.mimeType: 'application/vnd.google-apps.document'`; Drive converts the markdown to a Doc on import. `<name>` is `prd` / `rfc` / `NNNN-<slug>`.

Rationale (why both, not one):
- **Faithful source (`.md`):** markdown is the canonical artifact in `prd_ref.sha256`/`rfc_ref.sha256`; it is lossless (tables, code fences, frontmatter survive), diffable, and round-trips. The MCP remains the authoritative writer of this file.
- **Stakeholder-friendly Doc:** the native Google Doc is editable, commentable, and shareable in the Drive UI — the representation non-engineers actually open. Conversion is intentionally accepted as lossy for the Doc twin; the `.md` is the fidelity anchor.
- A single REST call each (`files.create`/`files.update`), no external conversion service: Drive performs the markdown→Doc conversion on import.

**Maintenance note (two representations kept in sync):** Both objects are (re)written on EVERY `publish`. Idempotency is per-object: on re-publish the adapter matches each existing object by **name + parent + mimeType** and updates it in place (the `.md` matched on `text/markdown`, the Doc matched on `application/vnd.google-apps.document`) rather than creating duplicates. The two never diverge because each publish overwrites both from the same source markdown. The Google Doc is the primary human-facing reference; the `.md` is the audit/source-of-truth.

**Resolved sub-decision — `DocRef` / `ArtifactRef` field mapping (so implementers don't guess):**

| Field | Holds | Source |
|---|---|---|
| `DocRef.url` | primary human-facing URL = the **Google Doc** `webViewLink` | Doc `files.create/update` |
| `DocRef.id` | the **`.md` file** Drive id (audit/source-of-truth anchor) | `.md` `files.create/update` |
| `DocRef.gdoc_id` | the **Google Doc** Drive id | Doc `files.create/update` |
| `DocRef.gdoc_url` | the **Google Doc** `webViewLink` (same value as `url`, kept explicit) | Doc `files.create/update` |
| `DocRef.md_url` | the **`.md` file** `webViewLink` (optional, completeness) | `.md` `files.create/update` |

When persisted onto the flow as an `ArtifactRef` (`prd_ref` / `rfc_ref` / `adr_refs[]`): `url` ← `DocRef.url` (Google Doc), `external_id` ← `DocRef.id` (the `.md` file id), and `gdoc_id` ← `DocRef.gdoc_id`. The existing `sha256` (markdown hash) is preserved.

### OD-2: ADR submission shape

**Recommendation: New `submit_adr` tool (separate from RFC).**

Rationale:
- ADRs can be submitted at any phase (not only RFC); they reference a specific decision, not the whole RFC document.
- A dedicated tool keeps the RFC tool's intent focused and makes it easier to surface ADRs in `get_flow_state`.
- Naming: the faithful markdown file is `NNNN-<slug>.md` where `NNNN` is a zero-padded four-digit sequence number per flow (stored as `adr_count` on the flow). Example: `0001-use-postgres.md`. The native Google Doc twin (per OD-1 "both") is named `NNNN-<slug>` (no extension) in the same `adr/` subfolder. Example Doc: `0001-use-postgres`.
- The `adr_refs` field (see Flow model changes) is a `DocRef[]` stored on the flow.

Tradeoff: one more tool in the registry. Acceptable; complexity is isolated.

### OD-3: Are Tribu/Squad required on `start_flow`?

**Recommendation: Optional, with a no-op fallback.**

Rationale:
- Making them required is a **breaking change** for: `examples/01-prd-rfc/run.sh`, all existing integration and unit tests that call `start_flow`, any external callers already in production.
- The blast radius is large (dozens of test call sites).
- When `tribu` and `squad` are absent, the `DocStoreProvider` falls back to the no-op/repo-ref behavior (stores sha256 only), which is today's behavior. No regression.
- Operators who have the shared drive configured in `doc_store` SHOULD pass `tribu` + `squad`; the tool description will indicate this with a note. If they are omitted and a real Drive adapter is configured, the adapter should return an informative error: `"tribu and squad are required when doc_store kind is google-drive"`.

Migration default: both columns `tribu` and `squad` are `text` NULLABLE with no default.

### OD-4: Does `DocStoreAdapter.publish` need new parameters?

**Recommendation: Extend `DocPublishInput` to carry folder context (`tribu`, `squad`, `flow_folder`) and doc kind (`'prd' | 'rfc' | 'adr'`), rather than passing flow metadata to the adapter constructor.**

Rationale:
- The existing `space_or_repo` field is Confluence/Notion-centric and does not map cleanly to Drive's folder hierarchy.
- A `DocPublishInput` extension is a pure addition (no breaking change to existing callers; `space_or_repo` is kept optional for Confluence/Notion adapters).
- The adapter does not need to call back to the flow store; all folder context is in the publish input.
- The alternative (passing `Flow` to `publish`) would couple the `DocStoreAdapter` interface to the core domain model — undesirable.

See "Contract Changes" section for the exact additions.

### OD-5: Service-account shared-drive access

**OPERATIONAL PREREQUISITE (not code):** The shared drive (`0APm8ey814gtwUk9PVA`) must be shared with the Google service account's email address (visible in the SA JSON as `client_email`) with at minimum "Contributor" access. Without this, all Drive API calls will return `403 notFound` (Drive deliberately returns 404/403 for permission-denied resources to avoid information leakage). **This must be done by a Drive admin before any Slice 3 tool call can succeed.**

### OD-6: Drive client library choice

**Recommendation: `googleapis` npm package (the official Google APIs Node.js client).**

Rationale:
- `googleapis` handles OAuth token refresh, retry, and typed request/response objects for Drive v3 out of the box via `google.drive('v3')`.
- `google-auth-library` + raw `fetch` would require hand-rolling token acquisition from a service-account JSON, request signing, and Drive endpoint construction — significant boilerplate with higher error surface.
- `googleapis` is the standard choice for service-account auth in Node.js (used by Firebase Admin, GCP SDKs, etc.) and is actively maintained by Google.
- The package is large (~4MB), but that is acceptable for a server-side adapter.
- New dependency: `googleapis` (production), `@types/google-apis` is included in the package itself.

---

## Context

`sdlc-mcp` is growing real adapters slice by slice. Slice 1 (merged) delivered `SecretResolver`, `IntegrationConfigStore`, and `ConfigBackedTaskSystemProvider`. Slice 3 delivers the **Google Drive DocStore**: a `DocStoreProvider` and `GoogleDriveDocStoreAdapter` that publish PRD, RFC, and ADR artifacts to a shared Google Drive folder hierarchy. Per OD-1 (resolved "both"), each artifact is stored TWICE in its flow folder — as a faithful `<name>.md` file (`text/markdown`) AND as a native Google Doc (`<name>`, converted from the markdown on import). The returned `DocRef` (Google Doc url + Doc id + `.md` file id) is stored as `prd_ref`, `rfc_ref`, or in the new `adr_refs` array on the flow.

Cross-cutting decisions already locked (from project brief):
- Shared drive id: `0APm8ey814gtwUk9PVA`.
- Folder hierarchy: root shared drive → Tribu folder → Squad folder → per-flow folder. Each artifact is stored as a pair: `prd.md` + Doc `prd`, `rfc.md` + Doc `rfc`, and `adr/NNNN-title.md` + Doc `adr/NNNN-title`.
- Auth: Google service-account JSON, fetched from AWS Secrets Manager via `ctx.resolveSecret(secret_ref)`.

Slice ordering: Slice 1 → **Slice 3** → Slice 2 / Slice 4 (Slices 2 and 4 can proceed in parallel after Slice 1).

---

## Objective

Deliver, tested end-to-end:

1. **`DocStoreAdapter` contract extension** — adds `tribu`, `squad`, `flow_folder`, `doc_kind` to `DocPublishInput`; adds `google-drive` to `DocStoreKind`.
2. **`GoogleDriveDocStoreAdapter`** — for each artifact uploads BOTH a faithful `.md` file (`text/markdown`) AND a native Google Doc (converted from the markdown) to the correct Drive folder hierarchy (idempotent folder ensure + idempotent per-object upsert keyed on name+parent+mimeType).
3. **`DocStoreProvider`** — call-time provider analogous to `TaskSystemProvider`; `google-drive` kind builds the real adapter; absent/`repo` kind → no-op fallback preserving today's behavior.
4. **Flow model extension** — `tribu`, `squad` columns on `flows` table (migration `0004`); `adr_refs`, `adr_count` fields on `Flow`.
5. **`start_flow` wiring** — accepts optional `tribu` + `squad`.
6. **`submit_prd` / `submit_rfc` wiring** — resolves doc store via provider; publishes (both `.md` + Doc); stores Google Doc `url`, `.md` file id (`external_id`), and `gdoc_id` in `prd_ref` / `rfc_ref`.
7. **`submit_adr` tool** — new tool; publishes ADR as both `.md` + Doc to `adr/` subfolder; stores the combined ref in flow `adr_refs`.
8. **Tests** — mocked Drive HTTP, asserting BOTH a `text/markdown` file AND an `application/vnd.google-apps.document` are upserted, and that re-publish updates (does not duplicate) each; optional live integration test gated on `GDRIVE_TEST_*` env vars.

---

## Architecture

```
tool handler (submit_prd / submit_rfc / submit_adr)
  const ds = await docStoreProvider.resolve(ctx, flow)
  const ref = await ds.publish(input, ctx)
  await store.updateFlow(flow.flow_id, { prd_ref: ref })
          │ resolve(ctx, flow)
          ▼
  DocStoreProvider ──reads config──▶ IntegrationConfigStore (doc_store column)
          │ kind="google-drive" → ctx.resolveSecret(cfg.secret_ref)
          ▼                           → parse SA JSON
  GoogleDriveDocStoreAdapter
          │ google.auth.GoogleAuth({ credentials, scopes })
          ▼
  Drive v3 REST API (googleapis)
    ensureFolder(sharedDriveId, [tribu, squad, flow_folder])
      └─ files.list(query, corpora=drive, driveId, supportsAllDrives=true)
         files.create(mimeType=folder, supportsAllDrives=true)
    // per artifact: TWO upserts into the same folder
    upsertObject(parentId, "<name>.md", body, mime='text/markdown')          // faithful md
      └─ files.list(name="<name>.md", parents in [parentId], mimeType='text/markdown')
         files.update or files.create (media text/markdown, supportsAllDrives=true)
    upsertObject(parentId, "<name>", body, targetMime='application/vnd.google-apps.document')  // native Doc
      └─ files.list(name="<name>", parents in [parentId], mimeType='application/vnd.google-apps.document')
         files.update or files.create (media text/markdown, requestBody.mimeType=
                                       application/vnd.google-apps.document, supportsAllDrives=true)
```

New units introduced:

| Unit | Purpose | Location |
|---|---|---|
| Extended `DocPublishInput` / `DocStoreKind` | contract addition | `packages/adapters-contracts/src/docs.ts` |
| `GoogleDriveDocStoreAdapter` | Drive upload + folder ensure | `apps/server/src/adapters/google-drive-docstore.ts` |
| `DocStoreProvider` / `ConfigBackedDocStoreProvider` | call-time provider | `apps/server/src/adapters/doc-store-provider.ts` |
| `NoOpDocStoreAdapter` | fallback when no doc_store configured | `apps/server/src/adapters/doc-store-provider.ts` (inline) |
| Migration `0004` | `tribu`, `squad`, `adr_refs`, `adr_count` columns on `flows` | `apps/server/migrations/0004_flows_tribu_squad_adr.sql` |
| `submit_adr` tool | new MCP tool | `apps/server/src/mcp/tools/submit-adr.ts` |

---

## Contract Changes

### `packages/adapters-contracts/src/docs.ts`

```ts
// Add 'google-drive' to the kind union
export type DocStoreKind = 'confluence' | 'notion' | 'repo' | 'google-drive';

// Extend DocRef to capture BOTH the .md file and the native Google Doc (OD-1 = both).
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

// Extend DocPublishInput with folder context + doc kind
export interface DocPublishInput {
  // existing (kept for Confluence/Notion compatibility)
  space_or_repo?: string;       // was required; now optional
  title: string;
  markdown: string;
  parent_id?: string;
  // NEW fields for Drive folder routing
  doc_kind: 'prd' | 'rfc' | 'adr';
  tribu?: string;               // required when kind='google-drive'
  squad?: string;               // required when kind='google-drive'
  flow_folder: string;          // e.g. "checkout-cuotas" — derived from flow.slug
  adr_filename?: string;        // e.g. "0001-use-postgres.md" — only for doc_kind='adr'
}
```

The `fetch` signature is unchanged (it reads back the `.md` file by id). `DocRef` is extended above to carry both representations.

### `packages/core/src/flow.ts`

Additions to the `Flow` zod schema and type:

```ts
// In the Flow zod object:
tribu:      z.string().optional(),
squad:      z.string().optional(),
adr_refs:   z.array(ArtifactRef).optional(),
adr_count:  z.number().int().nonnegative().optional(),
```

`ArtifactRef` already has `url`, `repo_path`, `sha256`, `external_id` — reused for `prd_ref`/`rfc_ref`/ADR refs. Per OD-1 (both), when a Drive publish succeeds these map as: `url` = Google Doc URL, `external_id` = `.md` file id, `sha256` = markdown hash (unchanged). To also retain the Google Doc id, add an optional `gdoc_id: z.string().optional()` field to `ArtifactRef` so the Doc can be located/updated later without re-listing.

New `ArtifactRef` field:
```ts
gdoc_id: z.string().optional(),   // native Google Doc Drive id (Drive doc_store only)
```

New `FlowEventType` values to add to the union:
```ts
'prd.published'    // fired after Drive upload of prd.md
'rfc.published'    // fired after Drive upload of rfc.md
'adr.submitted'    // fired after Drive upload of an ADR
```

---

## Data Model

### `flows` table — migration `0004`

New columns added via `ALTER TABLE flows ADD COLUMN IF NOT EXISTS`:

| column | type | note |
|---|---|---|
| `tribu` | `text` | nullable; set on `start_flow` |
| `squad` | `text` | nullable; set on `start_flow` |
| `adr_refs` | `jsonb` | `ArtifactRef[]`; default `'[]'::jsonb` |
| `adr_count` | `smallint` | per-flow ADR counter; default `0` |

No changes to `tenant_integrations` (already has `doc_store` jsonb column from migration `0003`).

### `IntegrationRef` for `doc_store` kind `google-drive`

Example:
```json
{
  "kind": "google-drive",
  "secret_ref": "aws-sm://gdrive-sa#credentials",
  "settings": {
    "sharedDriveId": "0APm8ey814gtwUk9PVA"
  }
}
```

`secret_ref` resolves to a **JSON string** containing a Google service-account key object (the full JSON exported from Google Cloud Console). The adapter parses it with `JSON.parse` and passes it to `new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive'] })`.

`settings.sharedDriveId` defaults to `"0APm8ey814gtwUk9PVA"` if absent.

---

## `GoogleDriveDocStoreAdapter` Design

### Authentication

```ts
import { google } from 'googleapis';

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(serviceAccountJson),
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });
```

All requests pass `supportsAllDrives: true`. Folder queries use `corpora: 'drive'` and `driveId: sharedDriveId`.

### Idempotent folder ensure

`ensureFolderPath(sharedDriveId: string, segments: string[]): Promise<string>`

Given `segments = ['Tribu-A', 'Squad-B', 'checkout-cuotas']`, it walks the chain:
1. Start from `sharedDriveId` as the root parent.
2. For each segment, call `files.list` with `q = "name='<segment>' and '<parentId>' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false"` + `corpora=drive`, `driveId`, `supportsAllDrives=true`.
3. If found, use the returned `id`; if not found, call `files.create` with `mimeType=application/vnd.google-apps.folder`, `parents=[parentId]`, `supportsAllDrives=true`.
4. Return the leaf folder id.

This is safe to call concurrently for different flows because name collisions are resolved by the `files.list` check-before-create; in the unlikely race, the second `files.create` will conflict and the adapter should retry the `list` to get the id.

### Idempotent object upsert (per OD-1 = both)

`upsertObject(parentFolderId, name, body, matchMimeType, targetMimeType?): Promise<{ id: string; webViewLink: string }>`

A single helper that upserts ONE Drive object, matched by **name + parent + mimeType** so the `.md` file and the Google Doc never collide even when their base names are similar:

1. `files.list` with `q = "name='<name>' and '<parentFolderId>' in parents and mimeType='<matchMimeType>' and trashed=false"` + shared-drive params (`corpora=drive`, `driveId`, `supportsAllDrives=true`, `includeItemsFromAllDrives=true`).
2. If found: `files.update(fileId, media: { mimeType: 'text/markdown', body }, supportsAllDrives=true, fields='id,webViewLink')`.
3. If not found: `files.create` with `parents=[parentFolderId]`, `requestBody.name=<name>`, media `{ mimeType: 'text/markdown', body }`, `supportsAllDrives=true`, `fields='id,webViewLink'`. For the Google Doc, ALSO set `requestBody.mimeType = 'application/vnd.google-apps.document'` so Drive converts the markdown on import.
4. Returns `{ id, webViewLink }`.

The adapter calls `upsertObject` TWICE per artifact:
- **Faithful `.md`:** `name='<name>.md'`, `matchMimeType='text/markdown'`, no target mime (stays a markdown file).
- **Native Doc:** `name='<name>'`, `matchMimeType='application/vnd.google-apps.document'`, `targetMimeType='application/vnd.google-apps.document'`.

`<name>` is `prd` / `rfc` / `NNNN-<slug>`.

### `publish` implementation

```ts
async publish(input: DocPublishInput, ctx: TenantCtx): Promise<DocRef> {
  // Validate required Drive params
  if (!input.tribu || !input.squad) {
    throw new Error('tribu and squad are required when doc_store kind is google-drive');
  }

  const flowFolderName = input.flow_folder;
  const leafFolderId = await this.ensureFolderPath(
    this.sharedDriveId,
    input.doc_kind === 'adr'
      ? [input.tribu, input.squad, flowFolderName, 'adr']
      : [input.tribu, input.squad, flowFolderName],
  );

  // baseName has NO extension; the .md file appends ".md".
  const baseName =
    input.doc_kind === 'adr'
      ? (input.adr_filename?.replace(/\.md$/, '') ?? `0001-${slugify(input.title)}`)
      : input.doc_kind; // 'prd' | 'rfc'

  // 1) faithful markdown file
  const md = await this.upsertObject(
    leafFolderId, `${baseName}.md`, input.markdown, 'text/markdown',
  );
  // 2) native Google Doc (Drive converts text/markdown → Doc on import)
  const doc = await this.upsertObject(
    leafFolderId, baseName, input.markdown,
    'application/vnd.google-apps.document', 'application/vnd.google-apps.document',
  );

  // Google Doc is the primary human-facing url; keep the .md id as the source anchor.
  return {
    id: md.id,
    url: doc.webViewLink,
    gdoc_id: doc.id,
    gdoc_url: doc.webViewLink,
    md_url: md.webViewLink,
  };
}
```

### `fetch` implementation

```ts
async fetch(id: string, _ctx: TenantCtx): Promise<{ markdown: string; version: string }> {
  const res = await this.drive.files.get({
    fileId: id,
    alt: 'media',
    supportsAllDrives: true,
  });
  return { markdown: res.data as string, version: id };
}
```

---

## `DocStoreProvider`

```ts
export interface DocStoreProvider {
  resolve(ctx: TenantCtx, flow: Flow): Promise<DocStoreAdapter>;
}

export class ConfigBackedDocStoreProvider implements DocStoreProvider {
  constructor(private readonly deps: { configStore: IntegrationConfigStore }) {}

  async resolve(ctx: TenantCtx, flow: Flow): Promise<DocStoreAdapter> {
    const cfg = await this.deps.configStore.getDocStoreConfig(ctx.tenantId, flow.project);
    if (!cfg || cfg.kind === 'repo') {
      return new NoOpDocStoreAdapter();
    }
    switch (cfg.kind) {
      case 'google-drive': {
        const saJson = cfg.secret_ref
          ? await ctx.resolveSecret(cfg.secret_ref)
          : undefined;
        if (!saJson) {
          throw new Error('google-drive doc_store requires a secret_ref for the service-account JSON');
        }
        const sharedDriveId =
          typeof cfg.settings.sharedDriveId === 'string'
            ? cfg.settings.sharedDriveId
            : '0APm8ey814gtwUk9PVA';
        return new GoogleDriveDocStoreAdapter({ serviceAccountJson: saJson, sharedDriveId });
      }
      default:
        throw new Error(`unknown doc_store kind: ${cfg.kind}`);
    }
  }
}
```

`NoOpDocStoreAdapter` — returns a stub `DocRef` (`{ id: 'noop', url: '' }`) without touching any external system. This preserves today's behavior when no doc store is configured: `submit_prd` and `submit_rfc` still complete successfully, storing only the `sha256` in `prd_ref` / `rfc_ref`.

---

## Tool Changes

### `start_flow`

Add optional `tribu` and `squad` fields to `StartFlowInput`:
```ts
tribu: z.string().optional(),
squad: z.string().optional(),
```
Pass them through to `store.createFlow({ ..., tribu: input.tribu, squad: input.squad })`.

### `submit_prd`

After the existing validation + sha256 calculation, resolve the doc store and publish:
```ts
const ds = await docStoreProvider.resolve(ctx, flow);
const docRef = await ds.publish({
  title: `PRD: ${flow.title}`,
  markdown: input.prd_markdown,
  doc_kind: 'prd',
  flow_folder: flow.slug,
  tribu: flow.tribu,
  squad: flow.squad,
}, ctx);
// Merge BOTH Drive locations into prd_ref alongside existing sha256:
//   url        = Google Doc URL (primary human-facing)
//   external_id = .md file id (source-of-truth anchor)
//   gdoc_id     = Google Doc id
prd_ref.url = docRef.url;
prd_ref.external_id = docRef.id;
prd_ref.gdoc_id = docRef.gdoc_id;
```
Fire new event `prd.published` with `{ drive_url: docRef.url, drive_id: docRef.id, gdoc_id: docRef.gdoc_id }`.

The factory `makeSubmitPrdTool` gains a second parameter: `docStoreProvider: DocStoreProvider`.

### `submit_rfc`

Identical pattern to `submit_prd`; publishes BOTH `rfc.md` and the native Doc `rfc`, and sets `rfc_ref.url` (Google Doc), `rfc_ref.external_id` (`.md` file id), and `rfc_ref.gdoc_id` (Google Doc id).

The factory `makeSubmitRfcTool` gains a second parameter: `docStoreProvider: DocStoreProvider`.

### `submit_adr` (new tool)

```ts
export const SubmitAdrInput = z.object({
  flow_id: z.string().min(1),
  title:   z.string().min(3),          // human title; used in filename
  adr_markdown: z.string().min(50),
});
```

Handler:
1. Fetch + tenant-check flow.
2. Compute `adrIndex = (flow.adr_count ?? 0) + 1`.
3. `adr_filename = `${String(adrIndex).padStart(4,'0')}-${slugify(title)}.md``. (The adapter derives the Google Doc twin name `NNNN-<slug>` by stripping `.md`.)
4. Resolve doc store; publish with `doc_kind='adr'`, `adr_filename`, `flow_folder=flow.slug`. The adapter writes BOTH `adr/NNNN-<slug>.md` and the Doc `adr/NNNN-<slug>`.
5. Build the combined `ArtifactRef` from the returned `DocRef` (`url` = Google Doc, `external_id` = `.md` id, `gdoc_id` = Doc id), then `updateFlow(flow_id, { adr_refs: [...(flow.adr_refs ?? []), ref], adr_count: adrIndex })`.
6. `appendEvent` with type `'adr.submitted'`.

No phase guard: ADRs can be submitted at any phase from `prd` onwards (once a flow exists).

---

## State Store Changes

### `CreateFlowInput` / `UpdateFlowInput` (store.ts)

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

### `InMemoryFlowStore`

`createFlow`: spread `tribu` / `squad` onto the `Flow`.
`updateFlow`: handle `adr_refs` and `adr_count` in the spread.

### `PostgresFlowStore`

`createFlow`: include `tribu` / `squad` in the `INSERT`.
`updateFlow`: handle `adr_refs` and `adr_count` in the `SET` builder.
`rowToFlow`: map new columns.

### Drizzle schema (`schema.ts`)

Add to the `flows` pgTable:
```ts
tribu:      text('tribu'),
squad:      text('squad'),
adr_refs:   jsonb('adr_refs').default([]),
adr_count:  smallint('adr_count').notNull().default(0),
```

---

## Bootstrap Wiring

### `BuildRegistryDeps` (`mcp/tools/index.ts`) — **SHARED FILE**

Add `docStoreProvider: DocStoreProvider` to the interface and pass it into `makeSubmitPrdTool`, `makeSubmitRfcTool`, and `makeSubmitAdrTool`.

### `apps/server/src/index.ts` — **SHARED FILE**

After constructing `taskSystemProvider`, also construct:
```ts
const docStoreProvider = new ConfigBackedDocStoreProvider({
  configStore: integrationConfig.store,
});
```
Pass to `buildToolRegistry`.

### `apps/server/src/mcp-stdio.ts` — **SHARED FILE**

Mirror the same construction as `index.ts`.

### `apps/server/src/adapters/index.ts`

Export `doc-store-provider` module.

---

## Testing Strategy

### Unit tests (no network, all in-process)

**`google-drive-docstore.test.ts`** — mock the googleapis `drive` object (vi.mock or manual stub):
- `publish` with `doc_kind='prd'`: verifies `ensureFolderPath` called with `[tribu, squad, flow_folder]`, and that BOTH objects are upserted — one `files.create`/`update` with media `mimeType='text/markdown'` named `prd.md`, AND one with `requestBody.mimeType='application/vnd.google-apps.document'` named `prd`. Returned `DocRef` carries `id` (.md), `url`/`gdoc_url`/`gdoc_id` (Doc), `md_url`.
- `publish` with `doc_kind='adr'`: verifies folder path includes `'adr'` segment, the `.md` is named `NNNN-<slug>.md`, and the Doc is named `NNNN-<slug>` (no extension).
- `publish` without `tribu`/`squad` throws an error.
- `ensureFolderPath` — folder exists path: `files.list` returns a hit → no folder `files.create` call.
- `ensureFolderPath` — folder absent path: `files.list` empty → `files.create` called → returns new id.
- Idempotent re-publish — both objects already exist: matched by name+parent+mimeType, BOTH go through `files.update` (no new `files.create` for either the `.md` or the Doc); assert no duplicates are created.
- Mixed state — `.md` exists but Doc absent: the `.md` is updated AND the Doc is created (per-object idempotency is independent).
- Drive API error (403): propagates as thrown error.

**`doc-store-provider.test.ts`**:
- No config → returns `NoOpDocStoreAdapter`.
- `kind='repo'` → returns `NoOpDocStoreAdapter`.
- `kind='google-drive'`, secret resolved → constructs `GoogleDriveDocStoreAdapter` (spy on constructor).
- `kind='google-drive'`, no `secret_ref` → throws.
- Unknown kind → throws.

**`submit-adr.test.ts`**:
- Happy path: flow exists → resolve doc store → publish → `adr_refs` updated on flow, `adr_count` incremented.
- Flow not found → `{ ok: false }`.
- Wrong tenant → `{ ok: false }`.
- Doc store throws → propagates error.

**`start-flow-tribu-squad.test.ts`** (extend existing `flow.test.ts` or add separate):
- `start_flow` with `tribu`/`squad` → flow has those fields.
- `start_flow` without `tribu`/`squad` → flow fields are `undefined` (no regression).

**`submit-prd-with-drive.test.ts`** / **`submit-rfc-with-drive.test.ts`**:
- When `docStoreProvider` returns a stub that resolves to a fake `DocStoreAdapter`, `submit_prd` stores the returned `DocRef.url` in `prd_ref.url`.
- When `docStoreProvider` returns `NoOpDocStoreAdapter`, `submit_prd` still completes and stores `sha256` (regression check).

### Optional live integration test (`gdrive-docstore.integration.test.ts`)

Gated on env vars (mirroring `integration-config-store.integration.test.ts`):
```ts
const saJson   = process.env.GDRIVE_TEST_SA_JSON;       // full SA JSON string
const driveId  = process.env.GDRIVE_TEST_DRIVE_ID;      // shared drive id
const testTribu = process.env.GDRIVE_TEST_TRIBU ?? '_test-tribu';
const testSquad = process.env.GDRIVE_TEST_SQUAD ?? '_test-squad';

const maybe = (saJson && driveId) ? describe : describe.skip;
```

Test cases (run against the real Drive, clean up after):
- Publish PRD → returns `DocRef` with a valid Google Doc `url` and a `.md` `id`; both `prd.md` (text/markdown) and the Doc `prd` (application/vnd.google-apps.document) exist in the flow folder. Re-publish (idempotent) updates BOTH and does not create duplicates (same `id` and `gdoc_id`).
- Publish ADR → folder `adr/` created inside the flow folder containing both `0001-test.md` and the Doc `0001-test`.
- `fetch(id)` (the `.md` id) returns the same markdown that was uploaded.

Clean-up: `afterAll` deletes the test flow folder (by Drive file id) to leave the shared drive tidy.

---

## Error Handling

| Situation | Behavior |
|---|---|
| `tribu`/`squad` absent, `kind=google-drive` | `publish` throws; tool returns `{ ok:false, error:'tribu and squad are required when doc_store kind is google-drive' }` |
| Drive 403 / 404 | adapter throws `DriveError`; tool catches and returns `{ ok:false, error:'doc_store unavailable: <reason>' }` — secret-ref NOT exposed |
| `secret_ref` resolution fails | `SecretResolutionError`; same opaque error response |
| No doc_store configured | `NoOpDocStoreAdapter` returns stub ref; tool continues normally; no error |
| Artifact already in Drive (same name+parent+mimeType) | `upsertObject` does an in-place update for EACH of the `.md` and the Doc (idempotent; no duplicates) |
| Drive API quota / rate limit | let the `googleapis` client retry with its default backoff; do not suppress errors if retries exhaust |

---

## Out of Scope (Slice 3)

- Azure DevOps Boards real adapter → Slice 2.
- PR/Review tools and adapters → Slice 4.
- Confluence/Notion `DocStoreAdapter` impls (contract supports them; impls not in this slice).
- Drive ACL management (sharing with stakeholders) — operational concern.
- Paging of `files.list` results (assumption: at most one match per name+parent+mimeType; safe for flow folders).
- Two-way sync / editing back from the Google Doc into the `.md`: the `.md` remains the source of truth and the Doc is regenerated from it on each publish; manual edits made in the Doc are overwritten on the next publish (accepted tradeoff of OD-1).

---

## Shared File / Migration Collision Notes

The following files are touched by **multiple slices** or by ongoing work. Merge sequencing matters:

| File | Risk | Recommendation |
|---|---|---|
| `apps/server/src/mcp/tools/index.ts` | Slice 2 also adds `docStoreProvider` / `submit_adr` → same file | Slice 3 should be merged **before** Slice 2 on this file, or the two PRs must rebase on each other before merging |
| `apps/server/src/index.ts` | Both Slice 2 (real ADO provider) and Slice 3 (DocStoreProvider) modify bootstrap | Coordinate merges; each slice adds non-overlapping lines, but conflicts are easy to resolve |
| `apps/server/src/mcp-stdio.ts` | Same as above | Same coordination |
| `apps/server/src/state/schema.ts` | Slice 4 may also add flow columns; see below | |
| `packages/core/src/flow.ts` | Any slice adding flow fields | Use additive changes only; run `pnpm turbo run typecheck` after each merge |
| `apps/server/migrations/0004_flows_tribu_squad_adr.sql` | **Migration number collision**: if Slice 4 also claims migration `0004`, the DB will reject it | **Recommendation: Slice 4 must use `0005`**. Migration numbers are sequential and already have `0003`. Slice 3 claims `0004`; any subsequent slice claims the next unused number. Document this in the Slice 4 plan. |
