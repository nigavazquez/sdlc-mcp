# Real Adapters — Slice 4: PR/Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `request_code_review` and `submit_review_outcome` tools backed by real PR platform adapters for Azure DevOps Repos and GitHub. A `ConfigBackedPullRequestProvider` selects the correct adapter at call time; a `NoOpPullRequestAdapter` keeps dev/test environments working without PR config.

**Architecture:** A new `PullRequestAdapter` contract (`packages/adapters-contracts/src/pullrequest.ts`) is implemented by `AzureDevOpsPullRequestAdapter` and `GitHubPullRequestAdapter` (both using native `fetch`). A `ConfigBackedPullRequestProvider` mirrors the existing `ConfigBackedTaskSystemProvider` pattern, reading the `pr_provider` config from `IntegrationConfigStore`. The story FSM gains one transition (`qa_passed → merged`). Two new tools are registered in `buildToolRegistry`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, native `fetch`, existing Drizzle + postgres-js + Fastify stack.

**Spec:** `docs/superpowers/specs/2026-06-10-real-adapters-slice-4-pr-review-design.md`

**SHARED FILE WARNING:** `apps/server/src/mcp/tools/index.ts`, `apps/server/src/index.ts`, `apps/server/src/mcp-stdio.ts`, `packages/adapters-contracts/src/index.ts`, and `apps/server/src/adapters/index.ts` are also modified by Slice 3. This slice MUST be implemented after Slice 3 is merged (or rebased on top of Slice 3's branch). Resolve additive conflicts before opening the Slice 4 PR.

---

## File Structure

**Create:**
- `packages/adapters-contracts/src/pullrequest.ts` — `PullRequestAdapter` contract, types.
- `apps/server/src/adapters/pull-request-provider.ts` — `PullRequestProvider`, `ConfigBackedPullRequestProvider`, `NoOpPullRequestAdapter`.
- `apps/server/src/adapters/azure-devops-pr-adapter.ts` — `AzureDevOpsPullRequestAdapter`.
- `apps/server/src/adapters/github-pr-adapter.ts` — `GitHubPullRequestAdapter`.
- `apps/server/src/mcp/tools/request-code-review.ts` — `makeRequestCodeReviewTool`.
- `apps/server/src/mcp/tools/submit-review-outcome.ts` — `makeSubmitReviewOutcomeTool`.
- `apps/server/test/azure-devops-pr-adapter.test.ts`
- `apps/server/test/github-pr-adapter.test.ts`
- `apps/server/test/pull-request-provider.test.ts`
- `apps/server/test/review-tools.test.ts`
- `apps/server/test/azure-devops-pr-adapter.integration.test.ts` (optional, always-skip without env vars)
- `apps/server/test/github-pr-adapter.integration.test.ts` (optional, always-skip without env vars)

**Modify:**
- `packages/adapters-contracts/src/index.ts` — add `export * from './pullrequest.js'`. **[SHARED with Slice 3]**
- `apps/server/src/adapters/index.ts` — export new adapter + provider files. **[SHARED with Slice 3]**
- `apps/server/src/stories/transitions.ts` — add `merged` as target from `qa_passed`.
- `apps/server/src/mcp/tools/index.ts` — add `pullRequestProvider` to `BuildRegistryDeps`; register 2 new tools. **[SHARED with Slice 3]**
- `apps/server/src/index.ts` — construct + wire `ConfigBackedPullRequestProvider`. **[SHARED with Slice 3]**
- `apps/server/src/mcp-stdio.ts` — same. **[SHARED with Slice 3]**

---

## Task 1: `PullRequestAdapter` contract

**Files:**
- Create: `packages/adapters-contracts/src/pullrequest.ts`
- Modify: `packages/adapters-contracts/src/index.ts`

- [ ] **Step 1: Write `pullrequest.ts`**

Create `packages/adapters-contracts/src/pullrequest.ts`:

```ts
import type { TenantCtx } from './tenant-context.js';

export type PrProviderKind = 'azure-devops-repos' | 'github';

/** Opaque reference to a pull request parsed from its URL. */
export interface PullRequestRef {
  url: string;
  pr_id: string;
  _parsed: Record<string, string>;
}

export type ReviewOutcome = 'approved' | 'changes_requested';

export interface RequestReviewInput {
  pr_ref: PullRequestRef;
  /** GitHub logins or ADO identity descriptor GUIDs. */
  reviewer_ids: string[];
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
  /** Raw platform status: ADO 'active'|'completed'|'abandoned'; GitHub 'open'|'closed'. */
  status: string;
  created_by: string;
}

export interface PullRequestAdapter {
  readonly kind: PrProviderKind;
  requestReview(input: RequestReviewInput, ctx: TenantCtx): Promise<void>;
  submitOutcome(input: SubmitOutcomeInput, ctx: TenantCtx): Promise<void>;
  getPullRequest(ref: PullRequestRef, ctx: TenantCtx): Promise<PrDetails>;
  /** Parse a pr_url into a PullRequestRef. Throws if URL format is unrecognised. */
  parsePrUrl(url: string): PullRequestRef;
}
```

- [ ] **Step 2: Export from the barrel**

In `packages/adapters-contracts/src/index.ts`, add (after the existing exports):

```ts
export * from './pullrequest.js';
```

- [ ] **Step 3: Typecheck the contracts package**

Run: `pnpm --filter @sdlc/adapters-contracts typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/adapters-contracts/src/pullrequest.ts packages/adapters-contracts/src/index.ts
git commit -m "feat(contracts): PullRequestAdapter contract + types"
```

---

## Task 2: Story FSM transition (`qa_passed → merged`)

**Files:**
- Modify: `apps/server/src/stories/transitions.ts`
- Test: `apps/server/test/story-transitions.test.ts` (extend existing)

- [ ] **Step 1: Extend the transition test**

Open `apps/server/test/story-transitions.test.ts`. Add a test case:

```ts
it('allows qa_passed → merged', () => {
  expect(canTransition('qa_passed', 'merged')).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sdlc/server test story-transitions`
Expected: FAIL — `canTransition('qa_passed', 'merged')` returns `false`.

- [ ] **Step 3: Update the transition table**

In `apps/server/src/stories/transitions.ts`, change:

```ts
  qa_passed: [],
```

to:

```ts
  qa_passed: ['merged'],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sdlc/server test story-transitions`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/stories/transitions.ts apps/server/test/story-transitions.test.ts
git commit -m "feat(stories): allow qa_passed → merged transition"
```

---

## Task 3: `AzureDevOpsPullRequestAdapter`

**Files:**
- Create: `apps/server/src/adapters/azure-devops-pr-adapter.ts`
- Test: `apps/server/test/azure-devops-pr-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/azure-devops-pr-adapter.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AzureDevOpsPullRequestAdapter } from '../src/adapters/azure-devops-pr-adapter.js';

const mockFetch = vi.fn();
beforeEach(() => vi.stubGlobal('fetch', mockFetch));
afterEach(() => vi.unstubAllGlobals());

function resp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ctx = { tenantId: 't1', userId: 'u1', roles: [], resolveSecret: async () => '' };
const adapter = new AzureDevOpsPullRequestAdapter({ pat: 'test-pat' });

const PR_URL =
  'https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/42';

describe('AzureDevOpsPullRequestAdapter', () => {
  describe('parsePrUrl', () => {
    it('parses a valid ADO PR URL', () => {
      const ref = adapter.parsePrUrl(PR_URL);
      expect(ref.pr_id).toBe('42');
      expect(ref._parsed.org).toBe('myorg');
      expect(ref._parsed.project).toBe('myproject');
      expect(ref._parsed.repo).toBe('myrepo');
    });

    it('throws on a non-ADO URL', () => {
      expect(() => adapter.parsePrUrl('https://github.com/o/r/pull/1')).toThrow();
    });
  });

  describe('getPullRequest', () => {
    it('returns PrDetails from the ADO response', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockResolvedValueOnce(
        resp({
          pullRequestId: 42,
          title: 'Fix login bug',
          status: 'active',
          createdBy: { uniqueName: 'alice@example.com' },
        }),
      );
      const details = await adapter.getPullRequest(prRef, ctx);
      expect(details.pr_id).toBe('42');
      expect(details.title).toBe('Fix login bug');
      expect(details.status).toBe('active');
      expect(details.created_by).toBe('alice@example.com');
    });

    it('throws with PR not found message on HTTP 404', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockResolvedValueOnce(resp({ message: 'not found' }, 404));
      await expect(adapter.getPullRequest(prRef, ctx)).rejects.toThrow(/PR not found/);
    });
  });

  describe('requestReview', () => {
    it('PUTs each reviewer_id with vote=0 and no thread when no message', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockResolvedValue(resp({}));
      await adapter.requestReview({ pr_ref: prRef, reviewer_ids: ['id-alice', 'id-bob'] }, ctx);
      const calls = mockFetch.mock.calls;
      expect(calls).toHaveLength(2);
      const bodies = calls.map((c) => JSON.parse(c[1].body as string));
      expect(bodies.every((b: { vote: number }) => b.vote === 0)).toBe(true);
    });

    it('posts a thread when message is supplied', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockResolvedValue(resp({}));
      await adapter.requestReview(
        { pr_ref: prRef, reviewer_ids: ['id-alice'], message: 'please review' },
        ctx,
      );
      // 1 reviewer PUT + 1 thread POST = 2 calls
      expect(mockFetch.mock.calls).toHaveLength(2);
    });
  });

  describe('submitOutcome', () => {
    it('PUTs vote=10 for approved', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockResolvedValue(resp({}));
      await adapter.submitOutcome(
        { pr_ref: prRef, outcome: 'approved', comment: 'LGTM' },
        ctx,
      );
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.vote).toBe(10);
    });

    it('PUTs vote=-10 and posts thread for changes_requested', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockResolvedValue(resp({}));
      await adapter.submitOutcome(
        { pr_ref: prRef, outcome: 'changes_requested', comment: 'needs work' },
        ctx,
      );
      // 1 vote PUT + 1 thread POST
      expect(mockFetch.mock.calls).toHaveLength(2);
      const votebody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(votebody.vote).toBe(-10);
    });

    it('throws PrRateLimitError on HTTP 429', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockResolvedValueOnce(new Response('', { status: 429 }));
      await expect(
        adapter.submitOutcome({ pr_ref: prRef, outcome: 'approved' }, ctx),
      ).rejects.toThrow(/rate limit/i);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sdlc/server test azure-devops-pr-adapter`
Expected: FAIL — cannot find `../src/adapters/azure-devops-pr-adapter.js`.

- [ ] **Step 3: Write `azure-devops-pr-adapter.ts`**

Create `apps/server/src/adapters/azure-devops-pr-adapter.ts`:

```ts
import type {
  PrDetails,
  PullRequestAdapter,
  PullRequestRef,
  RequestReviewInput,
  SubmitOutcomeInput,
} from '@sdlc/adapters-contracts';
import type { TenantCtx } from '@sdlc/adapters-contracts';

export class PrAuthError extends Error {
  constructor(msg: string) { super(msg); this.name = 'PrAuthError'; }
}
export class PrRateLimitError extends Error {
  constructor(msg: string) { super(msg); this.name = 'PrRateLimitError'; }
}
export class PrApiError extends Error {
  constructor(public readonly status: number, msg: string) {
    super(msg); this.name = 'PrApiError';
  }
}

const ADO_PR_RE =
  /^https:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/i;
const API_VERSION = 'api-version=7.1';

export interface AzureDevOpsPrAdapterOptions {
  pat: string;
}

export class AzureDevOpsPullRequestAdapter implements PullRequestAdapter {
  readonly kind = 'azure-devops-repos' as const;
  private readonly authHeader: string;

  constructor(private readonly opts: AzureDevOpsPrAdapterOptions) {
    this.authHeader = 'Basic ' + Buffer.from(':' + opts.pat).toString('base64');
  }

  parsePrUrl(url: string): PullRequestRef {
    const m = ADO_PR_RE.exec(url);
    if (!m) throw new Error(`AzureDevOpsPullRequestAdapter: cannot parse PR URL: ${url}`);
    return {
      url,
      pr_id: m[4],
      _parsed: { org: m[1], project: m[2], repo: m[3], prId: m[4] },
    };
  }

  private base(ref: PullRequestRef): string {
    const { org, project, repo, prId } = ref._parsed;
    return `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${repo}/pullRequests/${prId}`;
  }

  private async request(url: string, options: RequestInit): Promise<unknown> {
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: this.authHeader,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...((options.headers ?? {}) as Record<string, string>),
      },
    });
    if (res.status === 429) throw new PrRateLimitError('ADO rate limit reached; retry later');
    if (res.status === 401 || res.status === 403)
      throw new PrAuthError(`ADO auth failed (${res.status})`);
    if (res.status === 404) {
      throw new Error(`PR not found: ${url}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new PrApiError(res.status, `ADO API error ${res.status}: ${body}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  async getPullRequest(ref: PullRequestRef, _ctx: TenantCtx): Promise<PrDetails> {
    const url = `${this.base(ref)}?${API_VERSION}`;
    const data = (await this.request(url, { method: 'GET' })) as {
      pullRequestId: number;
      title: string;
      status: string;
      createdBy: { uniqueName: string };
    };
    return {
      pr_id: String(data.pullRequestId),
      url: ref.url,
      title: data.title,
      status: data.status,
      created_by: data.createdBy.uniqueName,
    };
  }

  async requestReview(input: RequestReviewInput, _ctx: TenantCtx): Promise<void> {
    const base = this.base(input.pr_ref);
    for (const reviewerId of input.reviewer_ids) {
      await this.request(
        `${base}/reviewers/${encodeURIComponent(reviewerId)}?${API_VERSION}`,
        { method: 'PUT', body: JSON.stringify({ vote: 0, isRequired: false }) },
      );
    }
    if (input.message) {
      await this.postThread(input.pr_ref, input.message);
    }
  }

  async submitOutcome(input: SubmitOutcomeInput, ctx: TenantCtx): Promise<void> {
    const vote = input.outcome === 'approved' ? 10 : -10;
    // Use ctx.userId as the reviewer identity descriptor when available.
    const reviewerId = ctx.userId;
    await this.request(
      `${this.base(input.pr_ref)}/reviewers/${encodeURIComponent(reviewerId)}?${API_VERSION}`,
      { method: 'PUT', body: JSON.stringify({ vote }) },
    );
    if (input.comment) {
      await this.postThread(input.pr_ref, input.comment);
    }
  }

  private async postThread(ref: PullRequestRef, content: string): Promise<void> {
    await this.request(
      `${this.base(ref)}/threads?${API_VERSION}`,
      {
        method: 'POST',
        body: JSON.stringify({
          comments: [{ parentCommentId: 0, content, commentType: 1 }],
          status: 'active',
        }),
      },
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sdlc/server test azure-devops-pr-adapter`
Expected: PASS (all unit tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/adapters/azure-devops-pr-adapter.ts apps/server/test/azure-devops-pr-adapter.test.ts
git commit -m "feat(adapters): AzureDevOpsPullRequestAdapter with reviewer + vote operations"
```

---

## Task 4: `GitHubPullRequestAdapter`

**Files:**
- Create: `apps/server/src/adapters/github-pr-adapter.ts`
- Test: `apps/server/test/github-pr-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/github-pr-adapter.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubPullRequestAdapter } from '../src/adapters/github-pr-adapter.js';

const mockFetch = vi.fn();
beforeEach(() => vi.stubGlobal('fetch', mockFetch));
afterEach(() => vi.unstubAllGlobals());

function resp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ctx = { tenantId: 't1', userId: 'alice', roles: [], resolveSecret: async () => '' };
const adapter = new GitHubPullRequestAdapter({ token: 'ghp_test' });

const PR_URL = 'https://github.com/myowner/myrepo/pull/7';

describe('GitHubPullRequestAdapter', () => {
  describe('parsePrUrl', () => {
    it('parses a valid GitHub PR URL', () => {
      const ref = adapter.parsePrUrl(PR_URL);
      expect(ref.pr_id).toBe('7');
      expect(ref._parsed.owner).toBe('myowner');
      expect(ref._parsed.repo).toBe('myrepo');
    });

    it('throws on a non-GitHub URL', () => {
      expect(() =>
        adapter.parsePrUrl('https://dev.azure.com/o/p/_git/r/pullrequest/1'),
      ).toThrow();
    });
  });

  describe('getPullRequest', () => {
    it('maps GitHub response to PrDetails', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockResolvedValueOnce(
        resp({
          number: 7,
          title: 'Add feature',
          state: 'open',
          user: { login: 'alice' },
        }),
      );
      const details = await adapter.getPullRequest(prRef, ctx);
      expect(details.pr_id).toBe('7');
      expect(details.title).toBe('Add feature');
      expect(details.status).toBe('open');
      expect(details.created_by).toBe('alice');
    });

    it('throws on HTTP 404', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockResolvedValueOnce(resp({ message: 'Not Found' }, 404));
      await expect(adapter.getPullRequest(prRef, ctx)).rejects.toThrow(/PR not found/);
    });
  });

  describe('requestReview', () => {
    it('POSTs to requested_reviewers with correct logins', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockResolvedValue(resp({}));
      await adapter.requestReview({ pr_ref: prRef, reviewer_ids: ['bob', 'carol'] }, ctx);
      const call = mockFetch.mock.calls[0];
      expect(call[0]).toMatch(/requested_reviewers/);
      const body = JSON.parse(call[1].body as string);
      expect(body.reviewers).toEqual(['bob', 'carol']);
    });

    it('posts a COMMENT review when message is supplied', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockResolvedValue(resp({}));
      await adapter.requestReview(
        { pr_ref: prRef, reviewer_ids: ['bob'], message: 'heads up' },
        ctx,
      );
      // 1 reviewers POST + 1 review POST = 2 calls
      expect(mockFetch.mock.calls).toHaveLength(2);
      const reviewBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
      expect(reviewBody.event).toBe('COMMENT');
      expect(reviewBody.body).toBe('heads up');
    });
  });

  describe('submitOutcome', () => {
    it('posts APPROVE review', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockResolvedValue(resp({ id: 1 }));
      await adapter.submitOutcome({ pr_ref: prRef, outcome: 'approved', comment: 'LGTM' }, ctx);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.event).toBe('APPROVE');
      expect(body.body).toBe('LGTM');
    });

    it('posts REQUEST_CHANGES review with body', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockResolvedValue(resp({ id: 2 }));
      await adapter.submitOutcome(
        { pr_ref: prRef, outcome: 'changes_requested', comment: 'please fix X' },
        ctx,
      );
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.event).toBe('REQUEST_CHANGES');
    });

    it('throws PrAuthError on HTTP 401', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockResolvedValueOnce(new Response('', { status: 401 }));
      await expect(adapter.submitOutcome({ pr_ref: prRef, outcome: 'approved' }, ctx)).rejects.toThrow(
        /auth/i,
      );
    });

    it('throws PrApiError on HTTP 422', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockResolvedValueOnce(resp({ message: 'unprocessable' }, 422));
      await expect(adapter.submitOutcome({ pr_ref: prRef, outcome: 'approved' }, ctx)).rejects.toThrow(
        /422/,
      );
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sdlc/server test github-pr-adapter`
Expected: FAIL — cannot find `../src/adapters/github-pr-adapter.js`.

- [ ] **Step 3: Write `github-pr-adapter.ts`**

Create `apps/server/src/adapters/github-pr-adapter.ts`:

```ts
import type {
  PrDetails,
  PullRequestAdapter,
  PullRequestRef,
  RequestReviewInput,
  SubmitOutcomeInput,
} from '@sdlc/adapters-contracts';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { PrApiError, PrAuthError, PrRateLimitError } from './azure-devops-pr-adapter.js';

const GH_PR_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i;

export interface GitHubPrAdapterOptions {
  token: string;
}

export class GitHubPullRequestAdapter implements PullRequestAdapter {
  readonly kind = 'github' as const;

  constructor(private readonly opts: GitHubPrAdapterOptions) {}

  parsePrUrl(url: string): PullRequestRef {
    const m = GH_PR_RE.exec(url);
    if (!m) throw new Error(`GitHubPullRequestAdapter: cannot parse PR URL: ${url}`);
    return {
      url,
      pr_id: m[3],
      _parsed: { owner: m[1], repo: m[2], number: m[3] },
    };
  }

  private base(ref: PullRequestRef): string {
    const { owner, repo, number } = ref._parsed;
    return `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;
  }

  private async request(url: string, options: RequestInit): Promise<unknown> {
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        ...((options.headers ?? {}) as Record<string, string>),
      },
    });
    if (res.status === 429) throw new PrRateLimitError('GitHub rate limit reached; retry later');
    if (res.status === 401 || res.status === 403)
      throw new PrAuthError(`GitHub auth failed (${res.status})`);
    if (res.status === 404) throw new Error(`PR not found: ${url}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new PrApiError(res.status, `GitHub API error ${res.status}: ${body}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  async getPullRequest(ref: PullRequestRef, _ctx: TenantCtx): Promise<PrDetails> {
    const data = (await this.request(this.base(ref), { method: 'GET' })) as {
      number: number;
      title: string;
      state: string;
      user: { login: string };
    };
    return {
      pr_id: String(data.number),
      url: ref.url,
      title: data.title,
      status: data.state,
      created_by: data.user.login,
    };
  }

  async requestReview(input: RequestReviewInput, _ctx: TenantCtx): Promise<void> {
    const { owner, repo, number } = input.pr_ref._parsed;
    await this.request(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/requested_reviewers`,
      { method: 'POST', body: JSON.stringify({ reviewers: input.reviewer_ids }) },
    );
    if (input.message) {
      await this.request(`${this.base(input.pr_ref)}/reviews`, {
        method: 'POST',
        body: JSON.stringify({ event: 'COMMENT', body: input.message }),
      });
    }
  }

  async submitOutcome(input: SubmitOutcomeInput, _ctx: TenantCtx): Promise<void> {
    const event = input.outcome === 'approved' ? 'APPROVE' : 'REQUEST_CHANGES';
    await this.request(`${this.base(input.pr_ref)}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ event, body: input.comment ?? '' }),
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sdlc/server test github-pr-adapter`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/adapters/github-pr-adapter.ts apps/server/test/github-pr-adapter.test.ts
git commit -m "feat(adapters): GitHubPullRequestAdapter with reviewer + review operations"
```

---

## Task 5: `ConfigBackedPullRequestProvider` + `NoOpPullRequestAdapter`

**Files:**
- Create: `apps/server/src/adapters/pull-request-provider.ts`
- Test: `apps/server/test/pull-request-provider.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/pull-request-provider.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Flow } from '@sdlc/core';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import {
  ConfigBackedPullRequestProvider,
  NoOpPullRequestAdapter,
} from '../src/adapters/pull-request-provider.js';
import { AzureDevOpsPullRequestAdapter } from '../src/adapters/azure-devops-pr-adapter.js';
import { GitHubPullRequestAdapter } from '../src/adapters/github-pr-adapter.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';

const FLOW = { flow_id: 't1:proj:slug', tenant_id: 't1', project: 'proj' } as Flow;

function ctx(resolveSecret: TenantCtx['resolveSecret'] = async () => 'secret'): TenantCtx {
  return { tenantId: 't1', userId: 'u', roles: [], resolveSecret };
}

describe('ConfigBackedPullRequestProvider', () => {
  it('returns NoOpPullRequestAdapter when no pr_provider config exists', async () => {
    const configStore = new InMemoryIntegrationConfigStore();
    const noOp = new NoOpPullRequestAdapter();
    const provider = new ConfigBackedPullRequestProvider({ configStore, noOp });
    const resolved = await provider.resolve(ctx(), FLOW);
    expect(resolved).toBe(noOp);
  });

  it('resolves secret and returns AzureDevOpsPullRequestAdapter for azure-devops-repos', async () => {
    const configStore = new InMemoryIntegrationConfigStore();
    configStore.seed('t1', 'proj', {
      pr_provider: { kind: 'azure-devops-repos', secret_ref: 'aws-sm://ado-pr#pat', settings: {} },
    });
    const provider = new ConfigBackedPullRequestProvider({
      configStore,
      noOp: new NoOpPullRequestAdapter(),
    });
    const seen: string[] = [];
    const resolved = await provider.resolve(
      ctx(async (ref) => { seen.push(ref); return 'my-pat'; }),
      FLOW,
    );
    expect(resolved).toBeInstanceOf(AzureDevOpsPullRequestAdapter);
    expect(seen).toEqual(['aws-sm://ado-pr#pat']);
  });

  it('resolves secret and returns GitHubPullRequestAdapter for github', async () => {
    const configStore = new InMemoryIntegrationConfigStore();
    configStore.seed('t1', 'proj', {
      pr_provider: { kind: 'github', secret_ref: 'aws-sm://gh-token', settings: {} },
    });
    const provider = new ConfigBackedPullRequestProvider({
      configStore,
      noOp: new NoOpPullRequestAdapter(),
    });
    const resolved = await provider.resolve(ctx(), FLOW);
    expect(resolved).toBeInstanceOf(GitHubPullRequestAdapter);
  });

  it('throws on an unknown kind', async () => {
    const configStore = new InMemoryIntegrationConfigStore();
    configStore.seed('t1', 'proj', {
      pr_provider: { kind: 'gitlab', secret_ref: 'aws-sm://gl', settings: {} },
    });
    const provider = new ConfigBackedPullRequestProvider({
      configStore,
      noOp: new NoOpPullRequestAdapter(),
    });
    await expect(provider.resolve(ctx(), FLOW)).rejects.toThrow(/unknown pr_provider kind: gitlab/);
  });

  it('NoOpPullRequestAdapter requestReview is a no-op', async () => {
    const noOp = new NoOpPullRequestAdapter();
    const prRef = { url: 'https://example.com', pr_id: '1', _parsed: {} };
    await expect(
      noOp.requestReview({ pr_ref: prRef, reviewer_ids: ['x'] }, ctx()),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sdlc/server test pull-request-provider`
Expected: FAIL — cannot find `../src/adapters/pull-request-provider.js`.

- [ ] **Step 3: Write `pull-request-provider.ts`**

Create `apps/server/src/adapters/pull-request-provider.ts`:

```ts
import type { Flow } from '@sdlc/core';
import type {
  PrDetails,
  PullRequestAdapter,
  PullRequestRef,
  RequestReviewInput,
  SubmitOutcomeInput,
} from '@sdlc/adapters-contracts';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { IntegrationConfigStore } from '../integrations/types.js';
import { AzureDevOpsPullRequestAdapter } from './azure-devops-pr-adapter.js';
import { GitHubPullRequestAdapter } from './github-pr-adapter.js';

export interface PullRequestProvider {
  resolve(ctx: TenantCtx, flow: Flow): Promise<PullRequestAdapter>;
}

export interface ConfigBackedPullRequestProviderDeps {
  configStore: IntegrationConfigStore;
  noOp: NoOpPullRequestAdapter;
}

export class ConfigBackedPullRequestProvider implements PullRequestProvider {
  constructor(private readonly deps: ConfigBackedPullRequestProviderDeps) {}

  async resolve(ctx: TenantCtx, flow: Flow): Promise<PullRequestAdapter> {
    const cfg = await this.deps.configStore.getPrProviderConfig(ctx.tenantId, flow.project);
    if (!cfg) return this.deps.noOp;
    switch (cfg.kind) {
      case 'azure-devops-repos': {
        if (!cfg.secret_ref) throw new Error('azure-devops-repos pr_provider: secret_ref is required');
        const pat = await ctx.resolveSecret(cfg.secret_ref);
        return new AzureDevOpsPullRequestAdapter({ pat });
      }
      case 'github': {
        if (!cfg.secret_ref) throw new Error('github pr_provider: secret_ref is required');
        const token = await ctx.resolveSecret(cfg.secret_ref);
        return new GitHubPullRequestAdapter({ token });
      }
      default:
        throw new Error(`unknown pr_provider kind: ${cfg.kind}`);
    }
  }
}

/** No-op adapter used when no pr_provider is configured. Flow/story still advance. */
export class NoOpPullRequestAdapter implements PullRequestAdapter {
  readonly kind = 'github' as const; // satisfies the type; unused in no-op context

  parsePrUrl(url: string): PullRequestRef {
    return { url, pr_id: 'noop', _parsed: {} };
  }

  async requestReview(_input: RequestReviewInput, _ctx: TenantCtx): Promise<void> {
    // intentional no-op
  }

  async submitOutcome(_input: SubmitOutcomeInput, _ctx: TenantCtx): Promise<void> {
    // intentional no-op
  }

  async getPullRequest(ref: PullRequestRef, _ctx: TenantCtx): Promise<PrDetails> {
    throw new Error(
      `No pr_provider configured; cannot fetch PR details for ${ref.url}. ` +
        'Set pr_provider in tenant_integrations to enable real PR operations.',
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sdlc/server test pull-request-provider`
Expected: PASS.

- [ ] **Step 5: Update the adapters barrel**

In `apps/server/src/adapters/index.ts`, add:

```ts
export * from './azure-devops-pr-adapter.js';
export * from './github-pr-adapter.js';
export * from './pull-request-provider.js';
```

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/adapters/pull-request-provider.ts apps/server/src/adapters/index.ts apps/server/test/pull-request-provider.test.ts
git commit -m "feat(adapters): ConfigBackedPullRequestProvider + NoOpPullRequestAdapter"
```

---

## Task 6: `request_code_review` tool

**Files:**
- Create: `apps/server/src/mcp/tools/request-code-review.ts`

This task creates the tool source only; it is tested in Task 8 via the full registry.

- [ ] **Step 1: Write `request-code-review.ts`**

Create `apps/server/src/mcp/tools/request-code-review.ts`:

```ts
import { z } from 'zod';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';
import type { PullRequestProvider } from '../../adapters/pull-request-provider.js';

export const RequestCodeReviewInput = z.object({
  story_id: z.string().min(1),
  reviewer_ids: z.array(z.string().min(1)).min(1),
  message: z.string().optional(),
});
export type RequestCodeReviewInput = z.infer<typeof RequestCodeReviewInput>;

export function makeRequestCodeReviewTool(store: FlowStore, pullRequestProvider: PullRequestProvider) {
  return {
    name: 'request_code_review',
    description:
      'Requests a code review for a QA-passed story. Adds the specified reviewers to the PR ' +
      'identified by the story\'s pr_url, advances the flow to the review phase, and emits ' +
      'review.requested.',
    inputSchema: RequestCodeReviewInput,
    handler: async (input: RequestCodeReviewInput, ctx: TenantCtx) => {
      const story = await store.getStory(input.story_id);
      if (!story) return { ok: false, error: `Unknown story: ${input.story_id}` };

      const flow = await store.getFlow(story.flow_id);
      if (!flow) return { ok: false, error: `Unknown flow: ${story.flow_id}` };
      if (flow.tenant_id !== ctx.tenantId) {
        return { ok: false, error: 'Flow belongs to a different tenant' };
      }

      if (story.status !== 'qa_passed') {
        return {
          ok: false,
          error: `Can only request review for a qa_passed story (current status=${story.status})`,
        };
      }
      if (!story.pr_url) {
        return {
          ok: false,
          error:
            'story has no pr_url; call report_progress({status:"in_review", pr_url}) first',
        };
      }

      const prAdapter = await pullRequestProvider.resolve(ctx, flow);
      const prRef = prAdapter.parsePrUrl(story.pr_url);

      await prAdapter.requestReview(
        { pr_ref: prRef, reviewer_ids: input.reviewer_ids, message: input.message },
        ctx,
      );

      const updatedFlow = await store.updateFlow(flow.flow_id, {
        current_phase: 'review',
        status: 'impl_in_review',
      });

      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'review.requested',
        actor: ctx.userId,
        payload: {
          story_id: story.story_id,
          pr_url: story.pr_url,
          reviewer_ids: input.reviewer_ids,
        },
      });

      return {
        ok: true,
        data: { story, flow: updatedFlow },
        next_actions: ['submit_review_outcome'],
      };
    },
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @sdlc/server typecheck`
Expected: no errors related to `request-code-review.ts`.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/mcp/tools/request-code-review.ts
git commit -m "feat(tools): request_code_review tool"
```

---

## Task 7: `submit_review_outcome` tool

**Files:**
- Create: `apps/server/src/mcp/tools/submit-review-outcome.ts`

- [ ] **Step 1: Write `submit-review-outcome.ts`**

Create `apps/server/src/mcp/tools/submit-review-outcome.ts`:

```ts
import { z } from 'zod';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { FlowStore } from '../../state/index.js';
import type { PullRequestProvider } from '../../adapters/pull-request-provider.js';

export const SubmitReviewOutcomeInput = z.object({
  story_id: z.string().min(1),
  outcome: z.enum(['approved', 'changes_requested']),
  comment: z.string().optional(),
});
export type SubmitReviewOutcomeInput = z.infer<typeof SubmitReviewOutcomeInput>;

export function makeSubmitReviewOutcomeTool(store: FlowStore, pullRequestProvider: PullRequestProvider) {
  return {
    name: 'submit_review_outcome',
    description:
      'Records the review outcome (approved | changes_requested) for a story in the review phase. ' +
      'Approved: advances story and flow to merged/done. ' +
      'Changes requested: returns story and flow to in_progress/implementation.',
    inputSchema: SubmitReviewOutcomeInput,
    handler: async (input: SubmitReviewOutcomeInput, ctx: TenantCtx) => {
      const story = await store.getStory(input.story_id);
      if (!story) return { ok: false, error: `Unknown story: ${input.story_id}` };

      const flow = await store.getFlow(story.flow_id);
      if (!flow) return { ok: false, error: `Unknown flow: ${story.flow_id}` };
      if (flow.tenant_id !== ctx.tenantId) {
        return { ok: false, error: 'Flow belongs to a different tenant' };
      }

      if (story.status !== 'qa_passed') {
        return {
          ok: false,
          error: `submit_review_outcome requires story status=qa_passed (current=${story.status})`,
        };
      }
      if (!story.pr_url) {
        return {
          ok: false,
          error: 'story has no pr_url; cannot submit review outcome',
        };
      }
      if (input.outcome === 'changes_requested' && !input.comment) {
        return {
          ok: false,
          error: 'comment is required when outcome=changes_requested',
        };
      }

      const prAdapter = await pullRequestProvider.resolve(ctx, flow);
      const prRef = prAdapter.parsePrUrl(story.pr_url);

      await prAdapter.submitOutcome(
        { pr_ref: prRef, outcome: input.outcome, comment: input.comment },
        ctx,
      );

      let updatedStory: typeof story;
      let updatedFlow: typeof flow;
      let nextActions: string[];

      if (input.outcome === 'approved') {
        updatedStory = await store.updateStory(story.story_id, { status: 'merged' });
        updatedFlow = await store.updateFlow(flow.flow_id, {
          status: 'merged',
          current_phase: 'done',
        });
        nextActions = [];
      } else {
        updatedStory = await store.updateStory(story.story_id, { status: 'in_progress' });
        updatedFlow = await store.updateFlow(flow.flow_id, {
          status: 'impl_in_review',
          current_phase: 'implementation',
        });
        nextActions = ['report_progress({status:"in_progress"})'];
      }

      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'review.outcome.submitted',
        actor: ctx.userId,
        payload: {
          story_id: story.story_id,
          pr_url: story.pr_url,
          outcome: input.outcome,
          comment: input.comment ?? null,
        },
      });

      return {
        ok: true,
        data: { story: updatedStory, flow: updatedFlow },
        next_actions: nextActions,
      };
    },
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @sdlc/server typecheck`
Expected: no errors related to `submit-review-outcome.ts`.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/mcp/tools/submit-review-outcome.ts
git commit -m "feat(tools): submit_review_outcome tool"
```

---

## Task 8: Registry, bootstrap wiring, and full tool tests

**Files:**
- Modify: `apps/server/src/mcp/tools/index.ts` **[SHARED with Slice 3]**
- Modify: `apps/server/src/index.ts` **[SHARED with Slice 3]**
- Modify: `apps/server/src/mcp-stdio.ts` **[SHARED with Slice 3]**
- Create: `apps/server/test/review-tools.test.ts`

- [ ] **Step 1: Write the failing tool test first**

Create `apps/server/test/review-tools.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { Catalog } from '@sdlc/catalog';
import { resolve } from 'node:path';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';
import { ConfigBackedTaskSystemProvider } from '../src/adapters/task-system-provider.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import {
  ConfigBackedPullRequestProvider,
  NoOpPullRequestAdapter,
} from '../src/adapters/pull-request-provider.js';
import { buildToolRegistry } from '../src/mcp/tools/index.js';

const PR_URL = 'https://github.com/owner/repo/pull/99';

const ctx = (overrides: Partial<TenantCtx> = {}): TenantCtx => ({
  tenantId: 't1',
  userId: 'alice',
  roles: ['reviewer'],
  resolveSecret: async () => { throw new Error('no secrets in test'); },
  ...overrides,
});

const mockFetch = vi.fn();
beforeEach(() => vi.stubGlobal('fetch', mockFetch));
afterEach(() => vi.unstubAllGlobals());

async function makeRegistry() {
  const catalog = await Catalog.load(resolve(__dirname, '../../../packages/catalog'));
  const store = new InMemoryFlowStore();
  const taskSystem = new InMemoryTaskSystemAdapter();
  const taskSystemProvider = new ConfigBackedTaskSystemProvider({
    configStore: new InMemoryIntegrationConfigStore(),
    inMemory: taskSystem,
  });
  const pullRequestProvider = new ConfigBackedPullRequestProvider({
    configStore: new InMemoryIntegrationConfigStore(),
    noOp: new NoOpPullRequestAdapter(),
  });
  const registry = buildToolRegistry({ catalog, store, taskSystemProvider, pullRequestProvider });
  return { store, taskSystem, registry };
}

async function seedQaPassed(store: InMemoryFlowStore, taskSystem: InMemoryTaskSystemAdapter) {
  const flow = await store.createFlow({
    tenant_id: 't1', project: 'demo', slug: 'login', title: 'Login feature',
  });
  await store.updateFlow(flow.flow_id, {
    status: 'qa_passed', current_phase: 'qa',
    epic_external_id: 'ADO-1', architecture_mode: 'new', codebase_status: 'greenfield',
  });
  const epicRef = await taskSystem.createEpic(
    { project_key: 'demo', title: 'Login', description: 'x' }, ctx(),
  );
  const storyRef = await taskSystem.createStory({
    project_key: 'demo', epic_id: epicRef.external_id, title: 'User logs in',
    description: 'happy login', acceptance_criteria: ['email/password works'],
  }, ctx());
  const story = await store.createStory({
    flow_id: flow.flow_id, external_id: storyRef.external_id, external_url: storyRef.url,
    title: 'User logs in', acceptance_criteria: ['email/password works'],
  });
  // manually advance story to qa_passed (mirrors what submit_qa_results does)
  const updatedStory = await store.updateStory(story.story_id, {
    status: 'qa_passed', pr_url: PR_URL,
  });
  return { flow, story: updatedStory };
}

describe('request_code_review', () => {
  it('calls adapter requestReview, advances flow to review phase, emits event', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem);
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    const tool = registry.get('request_code_review');
    expect(tool).toBeDefined();

    const out = (await tool!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'], message: 'please review' },
      ctx(),
    )) as { ok: boolean; data?: { flow: { current_phase: string; status: string } } };

    expect(out.ok).toBe(true);
    expect(out.data?.flow.current_phase).toBe('review');
    expect(out.data?.flow.status).toBe('impl_in_review');

    const events = await store.listEvents(flow.flow_id);
    expect(events.some((e) => e.type === 'review.requested')).toBe(true);
  });

  it('rejects story not in qa_passed', async () => {
    const { store, registry } = await makeRegistry();
    const flow = await store.createFlow({ tenant_id: 't1', project: 'demo', slug: 'other', title: 'x' });
    const story = await store.createStory({
      flow_id: flow.flow_id, external_id: 'ext-1', external_url: 'https://example.com',
      title: 't', acceptance_criteria: [],
    });
    const out = (await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] },
      ctx(),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/qa_passed/);
  });

  it('rejects story with no pr_url', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem);
    // remove pr_url
    await store.updateStory(story.story_id, { pr_url: undefined });
    const storyNoPr = await store.getStory(story.story_id);
    const out = (await registry.get('request_code_review')!.handler(
      { story_id: storyNoPr!.story_id, reviewer_ids: ['bob'] },
      ctx(),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/pr_url/);
  });
});

describe('submit_review_outcome', () => {
  it('approved: advances story to merged and flow to done', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem);
    // Advance flow to review phase first
    await store.updateFlow(flow.flow_id, { current_phase: 'review', status: 'impl_in_review' });

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'LGTM' },
      ctx(),
    )) as {
      ok: boolean;
      data?: {
        story: { status: string };
        flow: { status: string; current_phase: string };
      };
    };

    expect(out.ok).toBe(true);
    expect(out.data?.story.status).toBe('merged');
    expect(out.data?.flow.status).toBe('merged');
    expect(out.data?.flow.current_phase).toBe('done');

    const events = await store.listEvents(flow.flow_id);
    expect(events.some((e) => e.type === 'review.outcome.submitted')).toBe(true);
  });

  it('changes_requested: returns story to in_progress and flow to implementation', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem);
    await store.updateFlow(flow.flow_id, { current_phase: 'review', status: 'impl_in_review' });

    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'changes_requested', comment: 'please fix X' },
      ctx(),
    )) as {
      ok: boolean;
      data?: {
        story: { status: string };
        flow: { current_phase: string };
      };
    };

    expect(out.ok).toBe(true);
    expect(out.data?.story.status).toBe('in_progress');
    expect(out.data?.flow.current_phase).toBe('implementation');
  });

  it('rejects changes_requested without comment', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedQaPassed(store, taskSystem);
    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'changes_requested' },
      ctx(),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/comment.*required|required.*comment/i);
  });

  it('rejects story not in qa_passed', async () => {
    const { store, registry } = await makeRegistry();
    const flow = await store.createFlow({ tenant_id: 't1', project: 'p', slug: 's', title: 't' });
    const story = await store.createStory({
      flow_id: flow.flow_id, external_id: 'x', external_url: 'https://example.com',
      title: 't', acceptance_criteria: [],
    });
    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved' },
      ctx(),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/qa_passed/);
  });
});

describe('integration: full review loop', () => {
  it('qa_passed → request_code_review → submit_review_outcome(approved) → merged', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem);
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] },
      ctx(),
    );
    const finalOut = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'Approved!' },
      ctx(),
    )) as { ok: boolean; data?: { story: { status: string }; flow: { status: string } } };

    expect(finalOut.ok).toBe(true);
    expect(finalOut.data?.story.status).toBe('merged');
    expect(finalOut.data?.flow.status).toBe('merged');

    const events = await store.listEvents(flow.flow_id);
    const types = events.map((e) => e.type);
    expect(types).toContain('review.requested');
    expect(types).toContain('review.outcome.submitted');
  });

  it('changes_requested loop: dev fixes → qa_passed again → approved', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedQaPassed(store, taskSystem);
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    // Request review
    await registry.get('request_code_review')!.handler(
      { story_id: story.story_id, reviewer_ids: ['bob'] },
      ctx(),
    );
    // Reviewer requests changes
    await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'changes_requested', comment: 'fix X please' },
      ctx(),
    );
    // Check story is back to in_progress
    const reworked = await store.getStory(story.story_id);
    expect(reworked?.status).toBe('in_progress');

    // Simulate re-QA by manually resetting to qa_passed
    await store.updateStory(story.story_id, { status: 'qa_passed' });
    await store.updateFlow(flow.flow_id, { current_phase: 'review', status: 'impl_in_review' });

    // Final approval
    const approved = (await registry.get('submit_review_outcome')!.handler(
      { story_id: story.story_id, outcome: 'approved', comment: 'Now LGTM' },
      ctx(),
    )) as { ok: boolean; data?: { story: { status: string } } };
    expect(approved.ok).toBe(true);
    expect(approved.data?.story.status).toBe('merged');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sdlc/server test review-tools`
Expected: FAIL — `buildToolRegistry` does not accept `pullRequestProvider` yet; tools not registered.

- [ ] **Step 3: Update `apps/server/src/mcp/tools/index.ts`**

Add imports:
```ts
import type { PullRequestProvider } from '../../adapters/pull-request-provider.js';
import { makeRequestCodeReviewTool } from './request-code-review.js';
import { makeSubmitReviewOutcomeTool } from './submit-review-outcome.js';
```

Extend `BuildRegistryDeps`:
```ts
export interface BuildRegistryDeps {
  catalog: Catalog;
  store: FlowStore;
  taskSystemProvider: TaskSystemProvider;
  pullRequestProvider: PullRequestProvider;   // NEW
}
```

Destructure + register in `buildToolRegistry`:
```ts
const { catalog, store, taskSystemProvider, pullRequestProvider } = deps;
```

Add to the `tools` array (after `makeBlockStoryTool`):
```ts
makeRequestCodeReviewTool(store, pullRequestProvider) as unknown as ToolDef,
makeSubmitReviewOutcomeTool(store, pullRequestProvider) as unknown as ToolDef,
```

- [ ] **Step 4: Run tool test to verify it passes**

Run: `pnpm --filter @sdlc/server test review-tools`
Expected: PASS.

- [ ] **Step 5: Update `apps/server/src/index.ts`**

Add imports:
```ts
import {
  ConfigBackedPullRequestProvider,
  NoOpPullRequestAdapter,
} from './adapters/index.js';
```

After the `taskSystemProvider` construction, add:
```ts
const pullRequestProvider = new ConfigBackedPullRequestProvider({
  configStore: integrationConfig.store,
  noOp: new NoOpPullRequestAdapter(),
});
```

Pass to `buildToolRegistry`:
```ts
const registry = buildToolRegistry({
  catalog,
  store: storeHandle.store,
  taskSystemProvider,
  pullRequestProvider,
});
```

- [ ] **Step 6: Update `apps/server/src/mcp-stdio.ts`**

Mirror Step 5: add import, construct `ConfigBackedPullRequestProvider` + `NoOpPullRequestAdapter`, pass `pullRequestProvider` to `buildToolRegistry`.

- [ ] **Step 7: Run the full server test suite**

Run: `pnpm --filter @sdlc/server test`
Expected: PASS — all pre-existing tests plus the new review-tools suite. Tool count should be 23 (21 existing + 2 new).

- [ ] **Step 8: Typecheck and build**

Run:
```bash
pnpm --filter @sdlc/server typecheck
pnpm turbo run build
```
Expected: no errors.

- [ ] **Step 9: Verify tool count in smoke boot**

Run (no DATABASE_URL → in-memory everything):
```bash
API_KEYS="demo-tenant:dev-key-12345" pnpm --filter @sdlc/server dev &
sleep 3
curl -s localhost:3000/health | grep ok
curl -s localhost:3000/mcp/tools | python3 -c "import sys,json; t=json.load(sys.stdin)['tools']; print(len(t), 'tools')"
kill %1
```
Expected: health returns `"ok":true`; tool count is 23.

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/mcp/tools/index.ts apps/server/src/index.ts apps/server/src/mcp-stdio.ts apps/server/test/review-tools.test.ts
git commit -m "feat(server): wire pullRequestProvider into registry and bootstrap"
```

---

## Task 9: Optional live integration tests

**Files:**
- Create: `apps/server/test/azure-devops-pr-adapter.integration.test.ts`
- Create: `apps/server/test/github-pr-adapter.integration.test.ts`

- [ ] **Step 1: Write ADO live integration test (always-skip stub)**

Create `apps/server/test/azure-devops-pr-adapter.integration.test.ts`:

```ts
import { afterAll, describe, expect, it } from 'vitest';
import { AzureDevOpsPullRequestAdapter } from '../src/adapters/azure-devops-pr-adapter.js';

const ORG = process.env.ADO_PR_TEST_ORG;
const maybe = ORG ? describe : describe.skip;

maybe('AzureDevOpsPullRequestAdapter (live)', () => {
  const PROJECT = process.env.ADO_PR_TEST_PROJECT!;
  const REPO = process.env.ADO_PR_TEST_REPO!;
  const PR_ID = process.env.ADO_PR_TEST_PR_ID!;
  const PAT = process.env.ADO_PR_TEST_PAT!;
  const REVIEWER_ID = process.env.ADO_PR_TEST_REVIEWER_ID!;

  const PR_URL = `https://dev.azure.com/${ORG}/${PROJECT}/_git/${REPO}/pullrequest/${PR_ID}`;
  const adapter = new AzureDevOpsPullRequestAdapter({ pat: PAT });
  const ctx = { tenantId: 't1', userId: REVIEWER_ID, roles: [], resolveSecret: async () => '' };

  afterAll(async () => {
    // No cleanup needed — we only read and add votes (not comments), so state is non-destructive.
  });

  it('getPullRequest returns PR details', async () => {
    const ref = adapter.parsePrUrl(PR_URL);
    const details = await adapter.getPullRequest(ref, ctx);
    expect(details.pr_id).toBe(PR_ID);
    expect(typeof details.title).toBe('string');
  });

  it('requestReview adds reviewer with no-vote', async () => {
    const ref = adapter.parsePrUrl(PR_URL);
    await expect(
      adapter.requestReview({ pr_ref: ref, reviewer_ids: [REVIEWER_ID] }, ctx),
    ).resolves.toBeUndefined();
  });

  it('submitOutcome records approval', async () => {
    const ref = adapter.parsePrUrl(PR_URL);
    await expect(
      adapter.submitOutcome({ pr_ref: ref, outcome: 'approved', comment: '[sdlc-mcp live test] LGTM' }, ctx),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Write GitHub live integration test (always-skip stub)**

Create `apps/server/test/github-pr-adapter.integration.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { GitHubPullRequestAdapter } from '../src/adapters/github-pr-adapter.js';

const OWNER = process.env.GH_PR_TEST_OWNER;
const maybe = OWNER ? describe : describe.skip;

maybe('GitHubPullRequestAdapter (live)', () => {
  const REPO = process.env.GH_PR_TEST_REPO!;
  const PR_NUMBER = process.env.GH_PR_TEST_PR_NUMBER!;
  const TOKEN = process.env.GH_PR_TEST_TOKEN!;
  const REVIEWER = process.env.GH_PR_TEST_REVIEWER!;

  const PR_URL = `https://github.com/${OWNER}/${REPO}/pull/${PR_NUMBER}`;
  const adapter = new GitHubPullRequestAdapter({ token: TOKEN });
  const ctx = { tenantId: 't1', userId: REVIEWER, roles: [], resolveSecret: async () => '' };

  it('getPullRequest returns PR details', async () => {
    const ref = adapter.parsePrUrl(PR_URL);
    const details = await adapter.getPullRequest(ref, ctx);
    expect(details.pr_id).toBe(PR_NUMBER);
    expect(typeof details.title).toBe('string');
  });

  it('requestReview adds reviewer', async () => {
    const ref = adapter.parsePrUrl(PR_URL);
    await expect(
      adapter.requestReview({ pr_ref: ref, reviewer_ids: [REVIEWER] }, ctx),
    ).resolves.toBeUndefined();
  });

  it('submitOutcome records approval', async () => {
    const ref = adapter.parsePrUrl(PR_URL);
    await expect(
      adapter.submitOutcome({ pr_ref: ref, outcome: 'approved', comment: '[sdlc-mcp live test] LGTM' }, ctx),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Verify the stubs skip cleanly**

Run: `pnpm --filter @sdlc/server test`
Expected: PASS — integration tests are skipped (gate env vars unset); no test count regression.

- [ ] **Step 4: Commit**

```bash
git add apps/server/test/azure-devops-pr-adapter.integration.test.ts apps/server/test/github-pr-adapter.integration.test.ts
git commit -m "test(adapters): optional live PR adapter integration tests (gated)"
```

---

## Task 10: Update `submit_qa_results` next_actions hint

**Files:**
- Modify: `apps/server/src/mcp/tools/submit-qa-results.ts`

The `submit_qa_results` tool currently says `'request_code_review (future slice)'` in its `next_actions`. Now that the tool exists, remove the `(future slice)` label.

- [ ] **Step 1: Update the hint**

In `apps/server/src/mcp/tools/submit-qa-results.ts`, change:

```ts
next_actions:
  input.verdict === 'passed'
    ? ['request_code_review (future slice)']
    : ['report_progress({status:"in_progress"})'],
```

to:

```ts
next_actions:
  input.verdict === 'passed'
    ? ['request_code_review']
    : ['report_progress({status:"in_progress"})'],
```

- [ ] **Step 2: Run the full test suite one final time**

Run: `pnpm --filter @sdlc/server test`
Expected: PASS. Confirm test count is consistent with all previous steps.

- [ ] **Step 3: Typecheck final check**

Run: `pnpm --filter @sdlc/server typecheck && pnpm turbo run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/mcp/tools/submit-qa-results.ts
git commit -m "chore(tools): remove (future slice) label from submit_qa_results next_actions"
```

---

## Self-Review Notes

- **Spec coverage:** Contract (T1) · story FSM (`qa_passed → merged`, T2) · `AzureDevOpsPullRequestAdapter` — parsePrUrl, getPR, requestReview, submitOutcome + all error paths (T3) · `GitHubPullRequestAdapter` — same set (T4) · `ConfigBackedPullRequestProvider` + `NoOpPullRequestAdapter` (T5) · `request_code_review` tool — story validation, adapter call, flow advancement, event emission (T6/T8) · `submit_review_outcome` — both outcomes + comment guard (T7/T8) · registry + bootstrap wiring (T8) · optional live integration tests always-skip (T9) · next_actions cleanup (T10).
- **Type consistency:** `PullRequestRef._parsed` is `Record<string, string>` — implementers and tests use named keys (`org`, `prId`, `owner`, `repo`, `number`) but the contract only guarantees the record type. `PrProviderKind` union exported from contract. `NoOpPullRequestAdapter.kind` is set to `'github'` as a valid enum value; its no-op behaviour is what matters, not the `kind` string.
- **Shared file sequencing:** `tools/index.ts`, `index.ts`, `mcp-stdio.ts`, `adapters/index.ts` are all additive changes. Rebase onto Slice 3 branch before merging. Conflicts will be simple line additions with no logic overlap.
- **No migration:** `pr_provider` column already exists in `tenant_integrations` (migration `0003`). Migration `0004` is Slice 3's. Slice 4 claims no migration number.
- **No new core types:** `FlowStatus`, `CurrentPhase`, `FlowEventType`, and `StoryStatus` (including `merged`) are all already present in `packages/core/src/flow.ts` and `packages/core/src/story.ts`. The only core-adjacent change is adding `merged` to the `qa_passed` transition targets in `apps/server/src/stories/transitions.ts`.
