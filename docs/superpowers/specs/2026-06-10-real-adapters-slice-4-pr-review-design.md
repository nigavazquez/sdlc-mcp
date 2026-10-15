# Real Adapters — Slice 4: PR/Review (Azure DevOps Repos + GitHub)

**Date:** 2026-06-10
**Status:** design ready for approval, pending implementation plan

---

## Open decisions

The following decisions have consequential API-surface impact and must be resolved by the product owner before implementation begins. A recommendation is included for each.

### OD-1 — Does the MCP create PRs, or only operate on an existing `pr_url`?

The codebase already captures `pr_url` on a story when `report_progress` is called with `status=in_review`. The developer opens the PR externally and supplies the URL; the MCP tracks it.

**Recommendation:** The MCP operates on an **existing PR** identified by `pr_url`. The developer creates the PR in their Git client or IDE; `request_code_review` and `submit_review_outcome` act on the PR referenced by the story's `pr_url`. This avoids requiring commit SHA / branch name / base-branch inputs in the tools, and is consistent with the existing flow. Creating PRs from the MCP is out of scope.

### OD-2 — Does `submit_review_outcome` on approve also COMPLETE/MERGE the PR?

Merging requires additional permissions (delete-source-branch, auto-complete) and is irreversible. Silently merging on every approval is dangerous in shared repos.

**Recommendation:** `submit_review_outcome` with `outcome=approved` only **records the approval via the PR platform API** (ADO vote=10, GitHub `APPROVE` review) and **advances the flow status to `merged`**. Actual branch merge is NOT triggered by the MCP. Gate actual merge behind an explicit opt-in flag (`merge_on_approve: true`, default `false`) in the tool input — but implement the flag as a future slice; in Slice 4 the flag is accepted as input but its value is ignored (merge never happens). This preserves safety while leaving the hook in place.

### OD-3 — Flow state model for review: what statuses/phases represent the review lifecycle?

Existing `FlowStatus` values: `draft | prd_ready | rfc_ready | backlog_ready | impl_in_review | qa_passed | merged | aborted`.
Existing `CurrentPhase` values: `prd | rfc | shaping | implementation | qa | review | done`.
`FlowEventType` already includes `review.requested` and `review.outcome.submitted`.

The `review` phase and `review.requested` / `review.outcome.submitted` event types are already in `packages/core/src/flow.ts`. The `merged` FlowStatus also already exists. No new values need to be added to `FlowStatus` or `CurrentPhase`.

What is missing is the **story FSM transitions**: `qa_passed` stories need to allow transitioning to `merged` status via the review tools. Currently `TRANSITIONS['qa_passed'] = []` in `stories/transitions.ts`.

**Recommendation:** Add `merged` as an allowed target from `qa_passed` in the story transitions table. No additions to `FlowStatus` or `CurrentPhase` are needed. The `request_code_review` tool advances `flow.current_phase` to `review` (if not already there) and sets `flow.status = 'impl_in_review'`. The `submit_review_outcome` tool with `outcome=approved` sets `story.status = 'merged'` and `flow.status = 'merged'` + `flow.current_phase = 'done'`. With `outcome=changes_requested` it sets `story.status = 'in_progress'` and `flow.current_phase = 'implementation'` (back to the dev loop).

### OD-4 — Is review per-story or per-flow?

The `pr_url` lives on the `Story` record. A flow may have multiple stories, each with its own PR. The review tools need a specific PR to operate on.

**Recommendation:** Review tools operate **per-story** (accepting `story_id`). The story's `pr_url` identifies the PR. The flow phase advances when the first (or the designated) story transitions — for simplicity in Slice 4, the flow phase is updated based on the story being acted upon, which mirrors how `submit_qa_results` works today. A future slice can add multi-story quorum logic.

### OD-5 — GitHub auth: PAT vs GitHub App?

GitHub Apps require installation IDs, JWT generation, and installation token refresh. PATs are simpler and already fit the `aws-sm://...` secret-ref pattern used by the rest of the system.

**Recommendation:** **PAT / fine-grained token** stored in AWS Secrets Manager, resolved via `ctx.resolveSecret(cfg.secret_ref)`. The `Authorization: Bearer <token>` header is used for all GitHub API calls. GitHub App support is deferred.

### OD-6 — Parse owner/repo from PR URL, or require settings?

ADO PR URLs encode `org`, `project`, and `repo` in the path. GitHub PR URLs encode `owner` and `repo`. Rather than requiring extra `settings` fields that duplicate the URL, the adapter can parse the URL at request time.

**Recommendation:** **Parse from URL** for both platforms:
- ADO: `https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{pr_id}` → extract `org`, `project`, `repo`, `pr_id`.
- GitHub: `https://github.com/{owner}/{repo}/pull/{number}` → extract `owner`, `repo`, `number`.

The `settings` field for `pr_provider` still carries `{ org, project }` for ADO (used as defaults when the URL is unavailable) or `{ owner, repo }` for GitHub, but they are only used as fallbacks or for validation. This avoids any additional migration.

---

## Context

Slice 1 (merged) delivered `SecretResolver`, `IntegrationConfigStore` (with `getPrProviderConfig`), and the `ConfigBackedTaskSystemProvider` pattern.
Slice 2 delivers the real `AzureDevOpsTaskSystemAdapter`.
Slice 3 delivers the Google Drive `DocStoreAdapter`.
Slice 4 closes Phase 3 of the SDLC flow by implementing the two tools listed in `get-flow-state.ts`'s `review` phase: `request_code_review` and `submit_review_outcome`.

The `pr_provider` column already exists in `tenant_integrations` (migration `0003`). No new DB migration is needed for Slice 4.

## Objective

Deliver, tested end-to-end:

1. `PullRequestAdapter` contract in `packages/adapters-contracts/src/pullrequest.ts`.
2. `AzureDevOpsPullRequestAdapter` — operates on ADO Repos via the REST API (add reviewers, cast vote, set required reviewers, get PR details).
3. `GitHubPullRequestAdapter` — operates on GitHub via the REST API (add reviewers, create review, get PR details).
4. `ConfigBackedPullRequestProvider` — mirrors `ConfigBackedTaskSystemProvider`; resolves the correct adapter at call time via `IntegrationConfigStore.getPrProviderConfig`.
5. Two tools: `request_code_review` and `submit_review_outcome`.
6. Unit tests mocking `fetch` (no real network).
7. Optional live integration tests gated on env vars (SKIP by default).

## Architecture

```
tool handler (request_code_review / submit_review_outcome)
  const pr = await pullRequestProvider.resolve(ctx, flow)
  await pr.requestReview(...)  /  pr.submitOutcome(...)
          │ resolve(ctx, flow)
          ▼
  ConfigBackedPullRequestProvider ──reads──▶ IntegrationConfigStore.getPrProviderConfig
          │ if kind real → ctx.resolveSecret(cfg.secret_ref)
          ▼
  AzureDevOpsPullRequestAdapter   (kind: 'azure-devops-repos')
  GitHubPullRequestAdapter        (kind: 'github')
  NoOpPullRequestAdapter          (kind: undefined / unset)
```

A new `PullRequestProvider` is constructed fresh per `resolve()` call (stateless beyond config + token), mirroring `AzureDevOpsTaskSystemAdapter`.

## Contracts

### `PullRequestAdapter` — new contract

File: `packages/adapters-contracts/src/pullrequest.ts`

```ts
import type { TenantCtx } from './tenant-context.js';

export type PrProviderKind = 'azure-devops-repos' | 'github';

/** Opaque reference to a pull request parsed from its URL. */
export interface PullRequestRef {
  /** The canonical URL of the PR (the pr_url stored on the story). */
  url: string;
  /** Platform-specific numeric or string ID (ADO: number; GitHub: number). */
  pr_id: string;
  // Parsed from URL — convenience fields used by the adapter internally.
  // Not part of the stable public API but exported for tests.
  _parsed: Record<string, string>;
}

export type ReviewOutcome = 'approved' | 'changes_requested';

export interface RequestReviewInput {
  pr_ref: PullRequestRef;
  /** GitHub logins or ADO identity descriptors to add as reviewers. */
  reviewer_ids: string[];
  /** Optional freeform message posted as a PR comment when the platform supports it. */
  message?: string;
}

export interface SubmitOutcomeInput {
  pr_ref: PullRequestRef;
  outcome: ReviewOutcome;
  /** Required when outcome=changes_requested; posted as a review comment. */
  comment?: string;
}

export interface PrDetails {
  pr_id: string;
  url: string;
  title: string;
  status: string;   // raw platform status string (ADO: 'active'|'completed'|'abandoned'; GitHub: 'open'|'closed'|'merged')
  created_by: string;
}

export interface PullRequestAdapter {
  readonly kind: PrProviderKind;
  /** Add reviewers to the PR and/or mark it ready-for-review. */
  requestReview(input: RequestReviewInput, ctx: TenantCtx): Promise<void>;
  /** Cast a vote or create a review (approve / changes_requested). */
  submitOutcome(input: SubmitOutcomeInput, ctx: TenantCtx): Promise<void>;
  /** Fetch basic PR metadata (for validation / status checks). */
  getPullRequest(ref: PullRequestRef, ctx: TenantCtx): Promise<PrDetails>;
  /** Parse a pr_url into a PullRequestRef. Throws if the URL does not match the adapter's platform. */
  parsePrUrl(url: string): PullRequestRef;
}
```

Export in `packages/adapters-contracts/src/index.ts`:
```ts
export * from './pullrequest.js';
```

### `PullRequestProvider`

File: `apps/server/src/adapters/pull-request-provider.ts`

```ts
export interface PullRequestProvider {
  resolve(ctx: TenantCtx, flow: Flow): Promise<PullRequestAdapter>;
}

export class ConfigBackedPullRequestProvider implements PullRequestProvider {
  constructor(private readonly deps: {
    configStore: IntegrationConfigStore;
    noOp: NoOpPullRequestAdapter;
  }) {}

  async resolve(ctx: TenantCtx, flow: Flow): Promise<PullRequestAdapter> {
    const cfg = await this.deps.configStore.getPrProviderConfig(ctx.tenantId, flow.project);
    if (!cfg) return this.deps.noOp;
    switch (cfg.kind) {
      case 'azure-devops-repos': {
        const pat = await ctx.resolveSecret(cfg.secret_ref!);
        return new AzureDevOpsPullRequestAdapter({ pat });
      }
      case 'github': {
        const token = await ctx.resolveSecret(cfg.secret_ref!);
        return new GitHubPullRequestAdapter({ token });
      }
      default:
        throw new Error(`unknown pr_provider kind: ${cfg.kind}`);
    }
  }
}
```

The `NoOpPullRequestAdapter` is used when no `pr_provider` is configured. Its `requestReview` and `submitOutcome` are no-ops (return immediately); `getPullRequest` throws a clear error. This keeps tools working in dev/test environments with no PR config.

## ADO Repos REST API

### Authentication

```
Authorization: Basic <base64(':' + pat)>
Content-Type: application/json
```

### Base URL

```
https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo}/pullRequests/{prId}
```

API version: `?api-version=7.1`

### PR URL parsing

ADO PR URLs have the form:
```
https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{prId}
```

Parser extracts: `org`, `project`, `repo`, `prId`.

### Key operations

| Operation | Method + Path |
|---|---|
| Get PR | `GET .../pullRequests/{prId}` |
| Add reviewer | `PUT .../pullRequests/{prId}/reviewers/{identityId}` with `{ "vote": 0 }` |
| Cast vote (approve) | `PUT .../pullRequests/{prId}/reviewers/{identityId}` with `{ "vote": 10 }` |
| Cast vote (changes_requested) | `PUT .../pullRequests/{prId}/reviewers/{identityId}` with `{ "vote": -10 }` |
| Post thread (comment) | `POST .../pullRequests/{prId}/threads` with `{ "comments": [{ "content": "..." }], "status": "active" }` |

ADO vote values: `10` = Approved, `5` = Approved with suggestions, `0` = No vote, `-5` = Waiting for author, `-10` = Rejected.

For `requestReview`: iterate over `reviewer_ids`, PUT each reviewer with `vote: 0`; optionally post a thread with the message.

For `submitOutcome`:
- `approved` → PUT reviewer with `vote: 10` (the caller identity resolved from `ctx.userId` mapping — see OD below). Also POST a thread with the comment if supplied.
- `changes_requested` → PUT reviewer with `vote: -10`; POST thread with comment (required for this outcome).

**Caveat:** ADO reviewer PUTs require the reviewer's identity ID (a GUID), not their login name. The adapter accepts `reviewer_ids` as pre-resolved identity IDs from the tool caller. Resolution of display-name → GUID is outside scope for Slice 4.

### ADO-specific error mapping

| HTTP status | Behaviour |
|---|---|
| 404 | Throw `Error('PR not found: <url>')` |
| 401/403 | Throw `PrAuthError` (extends `Error`) |
| 429 | Throw `PrRateLimitError` |
| Other 4xx/5xx | Throw `PrApiError` with status + body |

## GitHub REST API

### Authentication

```
Authorization: Bearer <token>
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
```

### Base URL

```
https://api.github.com/repos/{owner}/{repo}/pulls/{pull_number}
```

### PR URL parsing

GitHub PR URLs:
```
https://github.com/{owner}/{repo}/pull/{number}
```

Parser extracts: `owner`, `repo`, `number`.

### Key operations

| Operation | Method + Path |
|---|---|
| Get PR | `GET /repos/{owner}/{repo}/pulls/{pull_number}` |
| Add reviewers | `POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers` with `{ "reviewers": [...] }` |
| Create review (approve) | `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews` with `{ "event": "APPROVE", "body": "..." }` |
| Create review (changes requested) | `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews` with `{ "event": "REQUEST_CHANGES", "body": "..." }` |
| Convert draft → ready-for-review | `POST /repos/{owner}/{repo}/pulls/{pull_number}/convert_to_draft` is inverse; use `PATCH .../pulls/{pull_number}` with `{ "draft": false }` |

For `requestReview`: call the `requested_reviewers` endpoint with the supplied `reviewer_ids` (GitHub logins); if `message` is supplied, also post a review comment via `POST .../reviews` with event `COMMENT`.

For `submitOutcome`:
- `approved` → `POST .../reviews` with `{ "event": "APPROVE", "body": comment ?? '' }`.
- `changes_requested` → `POST .../reviews` with `{ "event": "REQUEST_CHANGES", "body": comment }` (comment required).

### GitHub-specific error mapping

| HTTP status | Behaviour |
|---|---|
| 404 | Throw `Error('PR not found: <url>')` |
| 401/403 | Throw `PrAuthError` |
| 422 | Throw `PrApiError` (unprocessable — e.g. PR already merged) |
| Other 4xx/5xx | Throw `PrApiError` |

## The two tools

### `request_code_review`

```ts
export const RequestCodeReviewInput = z.object({
  story_id: z.string().min(1),
  reviewer_ids: z.array(z.string().min(1)).min(1),
  message: z.string().optional(),
});
```

Handler logic:
1. Load story; verify it exists and belongs to the tenant's flow.
2. Verify `story.status === 'qa_passed'` (only QA-passed stories enter review; reject otherwise).
3. Verify `story.pr_url` is set (set by `report_progress`; if missing, return `{ ok:false, error:'story has no pr_url; call report_progress({status:"in_review", pr_url}) first' }`).
4. Resolve `prAdapter = await pullRequestProvider.resolve(ctx, flow)`.
5. Parse `prRef = prAdapter.parsePrUrl(story.pr_url)`.
6. Call `await prAdapter.requestReview({ pr_ref: prRef, reviewer_ids, message }, ctx)`.
7. Advance flow: `store.updateFlow(flow_id, { current_phase: 'review', status: 'impl_in_review' })`.
8. Emit event `review.requested` with payload `{ story_id, pr_url, reviewer_ids }`.
9. Return `{ ok: true, data: { story, flow }, next_actions: ['submit_review_outcome'] }`.

### `submit_review_outcome`

```ts
export const SubmitReviewOutcomeInput = z.object({
  story_id: z.string().min(1),
  outcome: z.enum(['approved', 'changes_requested']),
  comment: z.string().optional(),
});
```

Handler logic:
1. Load story; verify tenant ownership.
2. Verify `story.status === 'qa_passed'` and `flow.current_phase === 'review'` (or accept `merged` for idempotency).
3. Verify `story.pr_url` is set.
4. If `outcome === 'changes_requested'` and `!comment`: return `{ ok:false, error:'comment is required when outcome=changes_requested' }`.
5. Resolve `prAdapter`; parse `prRef`.
6. Call `await prAdapter.submitOutcome({ pr_ref: prRef, outcome, comment }, ctx)`.
7. If `outcome === 'approved'`:
   - `store.updateStory(story_id, { status: 'merged' })`.
   - `store.updateFlow(flow_id, { status: 'merged', current_phase: 'done' })`.
   - `next_actions = []`.
8. If `outcome === 'changes_requested'`:
   - `store.updateStory(story_id, { status: 'in_progress' })`.
   - `store.updateFlow(flow_id, { status: 'impl_in_review', current_phase: 'implementation' })`.
   - `next_actions = ['report_progress({status:"in_progress"})']`.
9. Emit event `review.outcome.submitted` with payload `{ story_id, pr_url, outcome, comment }`.
10. Return `{ ok: true, data: { story, flow }, next_actions }`.

## Story FSM change

In `apps/server/src/stories/transitions.ts`, add `merged` as an allowed target from `qa_passed`:

```ts
const TRANSITIONS: Record<StoryStatus, StoryStatus[]> = {
  // ...
  qa_passed: ['merged'],   // was []
  merged: [],
};
```

`StoryStatus` in `packages/core/src/story.ts` already includes `merged`.

## Registry and bootstrap wiring

### `BuildRegistryDeps` extension (`apps/server/src/mcp/tools/index.ts`)

```ts
export interface BuildRegistryDeps {
  catalog: Catalog;
  store: FlowStore;
  taskSystemProvider: TaskSystemProvider;
  pullRequestProvider: PullRequestProvider;   // NEW
}
```

Two new tool registrations:
```ts
makeRequestCodeReviewTool(store, pullRequestProvider) as unknown as ToolDef,
makeSubmitReviewOutcomeTool(store, pullRequestProvider) as unknown as ToolDef,
```

### Bootstrap (`apps/server/src/index.ts` + `mcp-stdio.ts`)

Construct `ConfigBackedPullRequestProvider` alongside the existing `ConfigBackedTaskSystemProvider`:

```ts
const pullRequestProvider = new ConfigBackedPullRequestProvider({
  configStore: integrationConfig.store,
  noOp: new NoOpPullRequestAdapter(),
});
const registry = buildToolRegistry({ catalog, store: storeHandle.store, taskSystemProvider, pullRequestProvider });
```

### Adapters barrel (`apps/server/src/adapters/index.ts`)

Add exports for the new provider + adapter files.

## Testing

### Unit tests (no network — mock `fetch`)

Pattern (same as Slice 2's approach):

```ts
const mockFetch = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', mockFetch); mockFetch.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });
```

**`apps/server/test/azure-devops-pr-adapter.test.ts`**

| Test | Scenario |
|---|---|
| `parsePrUrl` | parses valid ADO URL → correct `org`, `project`, `repo`, `prId` |
| `parsePrUrl` | throws on non-ADO URL |
| `requestReview` | happy path — PUTs each reviewer_id with vote=0; posts thread when message supplied |
| `requestReview` | no message → no thread POST |
| `submitOutcome` approved | PUTs vote=10 + optional thread |
| `submitOutcome` changes_requested | PUTs vote=-10 + required thread |
| `getPullRequest` | maps ADO response to `PrDetails` |
| error path | HTTP 404 → throws with PR not found message |
| error path | HTTP 429 → throws `PrRateLimitError` |

**`apps/server/test/github-pr-adapter.test.ts`**

| Test | Scenario |
|---|---|
| `parsePrUrl` | parses valid GitHub URL |
| `parsePrUrl` | throws on non-GitHub URL |
| `requestReview` | POSTs to `requested_reviewers` with correct logins |
| `requestReview` | posts `COMMENT` review when message supplied |
| `submitOutcome` approved | POSTs review event `APPROVE` |
| `submitOutcome` changes_requested | POSTs review event `REQUEST_CHANGES` with body |
| `getPullRequest` | maps GitHub response to `PrDetails` |
| error path | HTTP 422 → throws `PrApiError` |
| error path | HTTP 401 → throws `PrAuthError` |

**`apps/server/test/pull-request-provider.test.ts`**

| Test | Scenario |
|---|---|
| no config | returns `NoOpPullRequestAdapter` |
| kind `azure-devops-repos` | resolves secret + returns `AzureDevOpsPullRequestAdapter` |
| kind `github` | resolves secret + returns `GitHubPullRequestAdapter` |
| unknown kind | throws `Error('unknown pr_provider kind: ...')` |
| missing secret_ref for real kind | `resolveSecret` not called if `secret_ref` absent → throws early |

**`apps/server/test/review-tools.test.ts`** (end-to-end through the registry with a mock provider)

Full flow seeded to `qa_passed` state:

| Test | Scenario |
|---|---|
| `request_code_review` happy path | calls `requestReview` on adapter; advances flow to `review`; emits event |
| `request_code_review` rejects story not qa_passed | returns `ok:false` |
| `request_code_review` rejects no pr_url | returns `ok:false` with clear message |
| `submit_review_outcome` approved | calls `submitOutcome`; story → `merged`; flow → `done`; emits event |
| `submit_review_outcome` changes_requested | story → `in_progress`; flow → `implementation`; emits event |
| `submit_review_outcome` missing comment for changes_requested | returns `ok:false` |
| integration: full review loop | `qa_passed` → `request_code_review` → `submit_review_outcome(approved)` → `merged` |
| integration: rejected loop | `approved` → `changes_requested` → dev fixes → `qa_passed` → `approved` |

### Optional live integration tests (gated)

**`apps/server/test/azure-devops-pr-adapter.integration.test.ts`**
Gate: `process.env.ADO_PR_TEST_ORG`. Required env vars:
```
ADO_PR_TEST_ORG=<org>
ADO_PR_TEST_PROJECT=<project>
ADO_PR_TEST_REPO=<repo>
ADO_PR_TEST_PR_ID=<existing-open-pr-id>
ADO_PR_TEST_PAT=<pat>
ADO_PR_TEST_REVIEWER_ID=<identity-guid-of-self>
```

**`apps/server/test/github-pr-adapter.integration.test.ts`**
Gate: `process.env.GH_PR_TEST_OWNER`. Required env vars:
```
GH_PR_TEST_OWNER=<owner>
GH_PR_TEST_REPO=<repo>
GH_PR_TEST_PR_NUMBER=<open-pr-number>
GH_PR_TEST_TOKEN=<fine-grained-pat>
GH_PR_TEST_REVIEWER=<github-login-of-self>
```

Both tests are `describe.skip` unless the gate env var is set, and never run in CI without explicit configuration.

## DB migration

No new migration is needed. The `tenant_integrations` table (migration `0003`, Slice 1) already carries the `pr_provider` JSONB column. Migration `0004` belongs to Slice 3. Slice 4 claims no migration number.

## Shared files — merge sequencing notes

| File | Why touched | Collision risk |
|---|---|---|
| `packages/adapters-contracts/src/index.ts` | Add `export * from './pullrequest.js'` | Slice 3 adds `export * from './docs.js'` (already present); low conflict risk if handled as additive lines |
| `apps/server/src/mcp/tools/index.ts` | Add `pullRequestProvider` to `BuildRegistryDeps` + 2 tool registrations | Slice 3 adds the doc store tool registrations to the same file; **must coordinate merge order** (Slice 3 first, then Slice 4 rebases on top, or resolve by combining both sets of additions in one pass) |
| `apps/server/src/index.ts` | Construct `ConfigBackedPullRequestProvider` + pass to `buildToolRegistry` | Slice 3 does the same for `DocStoreProvider`; same pattern, additive — small conflict risk if both slices add lines near the same `buildToolRegistry` call |
| `apps/server/src/mcp-stdio.ts` | Same as `index.ts` | Same as above |
| `packages/core/src/story.ts` | No change needed (`merged` already in `StoryStatus`) | None |
| `packages/core/src/flow.ts` | No change needed (`merged`, `review`, `review.requested`, `review.outcome.submitted` all already present) | None |
| `apps/server/src/stories/transitions.ts` | Add `merged` as allowed target from `qa_passed` | Slice 3 does not touch this file; no conflict |
| `apps/server/src/adapters/index.ts` | Export new provider + adapter files | Slice 3 adds doc store adapter barrel exports; same file, additive — small conflict risk |

**Recommended merge order:** Slice 1 (merged) → Slice 2 → Slice 3 → Slice 4. Slice 4 must rebase onto Slice 3 before merging because `index.ts` and `adapters/index.ts` are both touched. If Slices 2, 3, 4 proceed in parallel, the implementer of Slice 4 must pull the Slice 3 branch and resolve the additive conflicts before opening the Slice 4 PR.

## Error handling summary

| Situation | Behaviour |
|---|---|
| `pr_url` missing on story | Tool returns `{ ok:false, error:'story has no pr_url ...' }` |
| PR not found on platform | `PullRequestAdapter` throws; tool returns `{ ok:false, error:'PR not found: <url>' }` |
| Auth failure (401/403) | `PrAuthError`; tool returns `{ ok:false, error:'PR provider auth failed — check secret_ref' }` |
| Rate limit (429) | `PrRateLimitError`; tool returns `{ ok:false, error:'PR provider rate limit reached; retry later' }` |
| No `pr_provider` config | `NoOpPullRequestAdapter` — `requestReview`/`submitOutcome` succeed silently (no-op); flow/story still advance. Suitable for dev/test. |
| `changes_requested` without comment | Tool rejects before calling adapter |
| Story not in `qa_passed` when requesting review | Tool rejects |

## Out of scope (Slice 4)

- Creating PRs from the MCP (OD-1).
- Auto-merge / complete PR on approval (OD-2; flag accepted but no-op).
- ADO identity resolution (display-name → GUID).
- Multi-story quorum logic for flow phase transitions.
- GitHub App authentication.
- Retry-with-backoff on 429 (use `PrRateLimitError` to surface the issue; caller retries).
