# Real Adapters — Slice 2: Azure DevOps Boards (AzureDevOpsTaskSystemAdapter)

**Date:** 2026-06-10
**Status:** design ready for approval, pending implementation plan

---

## Open decisions

The following decisions have consequential API-surface impact and must be resolved by the product owner before implementation begins. A recommendation is included for each.

### OD-1 — ADO process template

Azure DevOps supports multiple process templates. They differ in work-item-type names and state names:

| Template | Epic type | Story type | Task type | Story states |
|---|---|---|---|---|
| Agile | `Epic` | `User Story` | `Task` | New → Active → Resolved → Closed |
| Scrum | `Epic` | `Product Backlog Item` | `Task` | New → Approved → Committed → Done |
| Basic | `Epic` | `Issue` | `Task` | To Do → Doing → Done |
| CMMI | `Epic` | `Requirement` | `Task` | Proposed → Active → Resolved → Closed |

The in-memory fake already mirrors the **Agile** template (`User Story`, `New/Active/Resolved/Closed`) and the 7 tools pass exactly those ADO state strings (`Active`, `Resolved`, `Closed`). Diverging from Agile would require either mapping at the adapter layer or breaking the contract.

**Recommendation:** Support **Agile** as the default (zero config). Make work-item-type names and the state mapping table configurable via `settings` (see OD-2) so a Scrum or Basic project can override them without code changes.

### OD-2 — Configurable type/state names via `settings`

Following the recommendation in OD-1, `IntegrationRef.settings` for `azure-devops` should carry:

```jsonc
{
  "org": "my-org",           // required — ADO org name
  "project": "my-project",   // required — ADO project name (may differ from flow.project)
  // optional overrides (Agile defaults shown):
  "epicType":    "Epic",
  "storyType":   "User Story",
  "subtaskType": "Task",
  // State-name overrides per contract status string:
  "stateMap": {
    "New":      "New",
    "Active":   "Active",
    "Resolved": "Resolved",
    "Closed":   "Closed"
  }
}
```

**Recommendation:** Ship the Agile defaults hard-coded in the adapter; apply `settings.stateMap` / `settings.*Type` as shallow overrides if present. This is a one-time additive change — no contract surface change needed.

### OD-3 — Area Path and Iteration Path

ADO work items belong to an Area Path and an Iteration Path. Not setting them causes items to land in the project root, which is functional but may violate team conventions.

**Recommendation:** Default to the project root (omit both fields from the creation payload — ADO auto-assigns the root). Accept optional `settings.areaPath` and `settings.iterationPath` string overrides; when present, include them as `System.AreaPath` / `System.IterationPath` in the JSON-Patch body. No further nesting logic in Slice 2.

### OD-4 — WIQL search scoping and `limit` semantics

`TaskSystemAdapter.search(query)` accepts `project_key`, `parent_id`, `status`, `text`, and `limit`. ADO WIQL queries must scope to a project; running team-wide WIQL is possible but slower and requires broader permissions.

**Recommendation:** Scope all WIQL queries to the `project` from `settings` (i.e. `FROM workitems WHERE [System.TeamProject] = '<project>'`). For `limit`, if `query.limit` is set use it as the WIQL `top` value; default to 200 when unset. This matches the in-memory fake's `slice(0, query.limit)` behaviour and avoids unbounded queries.

### OD-5 — Rate limiting and retry on HTTP 429

ADO's REST API enforces rate limits. Hitting 429 without retry will cause tool calls to fail silently from the user's perspective.

**Recommendation:** Defer a full retry-with-backoff library to a later slice. In Slice 2, detect HTTP 429 and throw an `AdoRateLimitError` (extends `Error`) with a clear message that surfaces through the tool's `{ ok: false, error }` path. The controller can schedule a retry. Build hooks (a thin `request()` wrapper) so Slice 3 / 4 can add retry without touching every method.

---

## Context

Slice 1 (merged) delivered:

- `SecretResolver` (`AwsSecretsManagerResolver` / `EnvSecretResolver`) wired into `ctx.resolveSecret`.
- `IntegrationConfigStore` (in-memory + Postgres) per `(tenant, project)`.
- `ConfigBackedTaskSystemProvider` that, for `kind === 'azure-devops'`, resolves the PAT via `ctx.resolveSecret` and then throws `NotImplementedError('azure-devops task system arrives in Slice 2')`.

Slice 2 replaces that `NotImplementedError` branch with a real `AzureDevOpsTaskSystemAdapter` that implements the full `TaskSystemAdapter` contract.

## Objective

Deliver, tested end-to-end:

1. `AzureDevOpsTaskSystemAdapter` — full implementation of the `TaskSystemAdapter` contract against the Azure DevOps Work Item Tracking REST API.
2. Wire the adapter into `ConfigBackedTaskSystemProvider`'s `azure-devops` branch.
3. Unit tests mocking `fetch` (no real network).
4. Optional live integration test gated on `ADO_TEST_*` env vars (SKIP by default).

## Chosen approach

**Native `fetch` over ADO REST API directly.** Node 20+ ships `fetch` globally; no ADO SDK is needed. This keeps the dependency graph minimal and avoids vendoring a large SDK with its own abstraction layer. A thin private `request()` helper inside the adapter handles auth headers, JSON serialisation, and error classification. The adapter is a plain class with no framework dependencies.

## Architecture

```
ConfigBackedTaskSystemProvider.resolve(ctx, flow)
  case 'azure-devops':
    pat = await ctx.resolveSecret(cfg.secret_ref)
    return new AzureDevOpsTaskSystemAdapter({
      org:     cfg.settings.org,
      project: cfg.settings.project,
      pat,
      ...optional overrides
    })
         │
         ▼
  AzureDevOpsTaskSystemAdapter
    ├── createEpic      → POST /_apis/wit/workitems/$Epic
    ├── createStory     → POST /_apis/wit/workitems/$User%20Story
    ├── createSubtask   → POST /_apis/wit/workitems/$Task
    ├── linkChildToParent → PATCH /_apis/wit/workitems/{id} (add relation)
    ├── getItem         → GET  /_apis/wit/workitems/{id}
    ├── transition      → PATCH /_apis/wit/workitems/{id} (set System.State)
    └── search          → POST /_apis/wit/wiql  (WIQL query)
```

A new `AzureDevOpsTaskSystemAdapter` is constructed fresh per `resolve()` call (the PAT is passed at construction time from the resolved secret). This is safe: the adapter holds no mutable state between calls — it is stateless beyond the config.

## ADO REST API contract

### Authentication

All requests include:

```
Authorization: Basic <base64(":"+pat)>
Content-Type: application/json-patch+json   (for PATCH/POST mutations)
Accept: application/json
```

### Base URL

```
https://dev.azure.com/{org}/{project}/_apis/wit/
```

API version query param: `?api-version=7.1` (stable, widely available).

### Creating work items

`POST https://dev.azure.com/{org}/{project}/_apis/wit/workitems/${encodeURIComponent(type)}?api-version=7.1`

Body is a JSON-Patch array:

```json
[
  { "op": "add", "path": "/fields/System.Title",       "value": "..." },
  { "op": "add", "path": "/fields/System.Description", "value": "..." },
  { "op": "add", "path": "/fields/System.Tags",        "value": "tag1; tag2" },
  { "op": "add", "path": "/fields/Microsoft.VSTS.Common.AcceptanceCriteria", "value": "..." }
]
```

Response body: `{ id: number, url: string, fields: { ... } }`.

`ExternalRef` is constructed as:

```ts
{
  external_id: String(response.id),
  url: `https://dev.azure.com/${org}/${project}/_workitems/edit/${response.id}`,
}
```

### Linking parent/child (work-item relations)

`PATCH https://dev.azure.com/{org}/{project}/_apis/wit/workitems/{childId}?api-version=7.1`

```json
[
  {
    "op": "add",
    "path": "/relations/-",
    "value": {
      "rel": "System.LinkTypes.Hierarchy-Reverse",
      "url": "https://dev.azure.com/{org}/_apis/wit/workItems/{parentId}"
    }
  }
]
```

`Hierarchy-Reverse` = "child points to parent" (the standard ADO parent-link). `Hierarchy-Forward` = "parent points to children" (used in `createStory` / `createSubtask` where the parent is known at creation time via `parent_id`, but the safer general-purpose approach is to PATCH the child with `Hierarchy-Reverse`, which is what `linkChildToParent` does).

### Transitioning state

`PATCH https://dev.azure.com/{org}/{project}/_apis/wit/workitems/{id}?api-version=7.1`

```json
[
  { "op": "add", "path": "/fields/System.State", "value": "Active" }
]
```

### Getting a work item

`GET https://dev.azure.com/{org}/{project}/_apis/wit/workitems/{id}?api-version=7.1&$expand=relations`

The `$expand=relations` is needed to populate parent_id from the `relations` array.

### WIQL search

`POST https://dev.azure.com/{org}/{project}/_apis/wit/wiql?api-version=7.1`

```json
{
  "query": "SELECT [System.Id] FROM workitems WHERE [System.TeamProject] = '{project}' AND [System.State] = 'Active' ORDER BY [System.ChangedDate] DESC"
}
```

The response contains `{ workItems: [{ id, url }] }`. A second batch-fetch call retrieves the full field set: `POST /_apis/wit/workitemsbatch?api-version=7.1` with `{ ids: [...], fields: [...] }`.

## Field mapping

| Contract field | ADO field |
|---|---|
| `title` | `System.Title` |
| `description` (Epic/Story) | `System.Description` |
| `description` (Subtask) | `System.Description` (optional, omit if empty) |
| `labels[]` | `System.Tags` (semicolon-separated) |
| `acceptance_criteria[]` (Story) | `Microsoft.VSTS.Common.AcceptanceCriteria` (HTML `<ul><li>…</li></ul>`) |
| `estimate` (Story, optional) | `Microsoft.VSTS.Scheduling.StoryPoints` |
| `status` | `System.State` |
| `type` | derived from work-item type name (Epic→`epic`, User Story→`story`, Task→`subtask`/`task`) |
| `parent_id` | from relations where `rel === 'System.LinkTypes.Hierarchy-Reverse'` |

## TaskItem mapping from ADO response

```ts
function mapWorkItem(wi: AdoWorkItem): TaskItem {
  const fields = wi.fields;
  const typeName: string = fields['System.WorkItemType'];
  const type = typeName === 'Epic' ? 'epic'
    : typeName === 'User Story' ? 'story'
    : 'subtask';  // Task, Bug, etc.

  const tagsRaw: string = fields['System.Tags'] ?? '';
  const labels = tagsRaw
    .split(';')
    .map((t) => t.trim())
    .filter(Boolean);

  const parentRel = wi.relations?.find(
    (r) => r.rel === 'System.LinkTypes.Hierarchy-Reverse',
  );
  const parent_id = parentRel
    ? String(parentRel.url.split('/').pop())
    : undefined;

  return {
    external_id: String(wi.id),
    url: `https://dev.azure.com/${org}/${project}/_workitems/edit/${wi.id}`,
    title: fields['System.Title'] ?? '',
    description: fields['System.Description'] ?? '',
    status: fields['System.State'] ?? '',
    type,
    parent_id,
    labels,
  };
}
```

## `AzureDevOpsTaskSystemAdapter` constructor

```ts
export interface AzureDevOpsAdapterOptions {
  org: string;
  project: string;
  pat: string;
  // Configurable overrides (OD-1 / OD-2)
  epicType?:    string;   // default 'Epic'
  storyType?:   string;   // default 'User Story'
  subtaskType?: string;   // default 'Task'
  stateMap?:    Record<string, string>; // default identity
  areaPath?:    string;   // default omit (ADO root)
  iterationPath?: string; // default omit (ADO root)
}
```

The `ConfigBackedTaskSystemProvider` constructs it as:

```ts
case 'azure-devops': {
  const pat = await ctx.resolveSecret(cfg.secret_ref!);
  const s = cfg.settings as Record<string, unknown>;
  return new AzureDevOpsTaskSystemAdapter({
    org:           s.org as string,
    project:       s.project as string,
    pat,
    epicType:      s.epicType as string | undefined,
    storyType:     s.storyType as string | undefined,
    subtaskType:   s.subtaskType as string | undefined,
    stateMap:      s.stateMap as Record<string,string> | undefined,
    areaPath:      s.areaPath as string | undefined,
    iterationPath: s.iterationPath as string | undefined,
  });
}
```

## Error handling

| Situation | Behaviour |
|---|---|
| HTTP 4xx (not 429) from ADO | Throw `AdoApiError` with status + body; tool returns `{ ok:false, error:'ADO API error: <status>' }` |
| HTTP 429 from ADO | Throw `AdoRateLimitError`; tool returns `{ ok:false, error:'ADO rate limit reached; retry later' }` |
| Work item not found (HTTP 404 on getItem) | Throw `Error('Work item <id> not found')` — consistent with in-memory fake |
| Transition to an invalid state | ADO returns 400; wrapped as `AdoApiError` |
| Missing `org` / `project` in settings | Throw `Error('azure-devops adapter: missing required settings.org / settings.project')` at construction time |
| Missing `secret_ref` | `ctx.resolveSecret` is not called; throw `Error('azure-devops adapter: secret_ref is required')` in provider before construction |

## Testing

### Unit tests (no network)

Mock `fetch` globally via `vi.stubGlobal('fetch', mockFetch)` in a `beforeEach`. Each method gets at least one happy-path test and one error-path test. The mock returns pre-canned `Response` objects (`new Response(JSON.stringify(body), { status: 200 })`).

Test file: `apps/server/test/azure-devops-task-system.test.ts`

Scenarios:

| Method | Test |
|---|---|
| `createEpic` | happy path → returns `{ external_id, url }` |
| `createStory` | maps acceptance_criteria to `AcceptanceCriteria` field; maps labels to `Tags` |
| `createSubtask` | omits `AcceptanceCriteria`; optional description |
| `linkChildToParent` | PATCH with `Hierarchy-Reverse` relation |
| `getItem` | maps fields + derives `parent_id` from relations |
| `transition` | PATCH with `System.State`; applies `stateMap` override |
| `search` | WIQL + batch-fetch; applies `status`, `parent_id`, `text`, `limit` filters |
| error path | HTTP 404 → `getItem` throws; HTTP 429 → `AdoRateLimitError`; HTTP 400 → `AdoApiError` |
| stateMap override | custom `stateMap` in options is applied correctly |

### Optional live integration test (gated)

File: `apps/server/test/azure-devops-task-system.integration.test.ts`

Gate: `process.env.ADO_TEST_ORG` — if unset, the entire `describe` is `describe.skip`. Required env vars:

```
ADO_TEST_ORG=<org>
ADO_TEST_PROJECT=<project>
ADO_TEST_PAT=<personal-access-token>
```

The test creates an Epic, a User Story linked to it, a Task linked to the story, transitions the story to Active, then retrieves each item and asserts the fields. Cleans up by closing the items (transition to Closed) after the suite. This test is never run in CI unless those env vars are explicitly configured.

## DB migration

No new migration is needed. The `tenant_integrations` table (migration `0003`) from Slice 1 already carries the `task_system` JSONB column that holds `{ kind: 'azure-devops', secret_ref, settings: { org, project, ... } }`. Slice 2 is purely an adapter implementation — no schema changes.

## Shared file touched by Slice 2

`apps/server/src/adapters/task-system-provider.ts` is modified to replace the `NotImplementedError` branch with the real construction. This file was last modified in Slice 1. **Merge sequencing note:** Slice 2 MUST be merged after Slice 1 (already the case — Slice 1 is merged). Slices 3 and 4 do not modify `task-system-provider.ts` (they add new provider cases for `doc_store` and `pr_provider` respectively, in separate files). No merge conflict is anticipated with Slices 3/4.

## Out of scope (Slice 2)

- Google Drive DocStore → **Slice 3**.
- PR/Review tools and adapters → **Slice 4**.
- Full retry-with-backoff on 429 → deferred (OD-5 recommendation).
- Webhook push notifications from ADO → not in scope for any slice currently planned.
