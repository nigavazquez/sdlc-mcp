/**
 * Live integration test against a real GitHub pull request.
 * Skipped unless GH_PR_TEST_OWNER (and related vars) are set.
 * Never run in CI without those env vars configured.
 *
 * Non-destructive: reads the PR and posts a review approval.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { GitHubPullRequestAdapter } from '../src/adapters/github-pr-adapter.js';
import type { TenantCtx } from '@sdlc/adapters-contracts';

const OWNER = process.env.GH_PR_TEST_OWNER;
const maybe = OWNER ? describe : describe.skip;

maybe('GitHubPullRequestAdapter (live)', () => {
  const REPO = process.env.GH_PR_TEST_REPO!;
  const PR_NUMBER = process.env.GH_PR_TEST_PR_NUMBER!;
  const TOKEN = process.env.GH_PR_TEST_TOKEN!;
  const REVIEWER = process.env.GH_PR_TEST_REVIEWER!;

  const PR_URL = `https://github.com/${OWNER}/${REPO}/pull/${PR_NUMBER}`;
  const ctx: TenantCtx = {
    tenantId: 't1',
    userId: REVIEWER,
    roles: [],
    resolveSecret: async () => '',
  };

  let adapter: GitHubPullRequestAdapter;

  beforeAll(() => {
    adapter = new GitHubPullRequestAdapter({ token: TOKEN });
  });

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
      adapter.submitOutcome(
        { pr_ref: ref, outcome: 'approved', comment: '[sdlc-mcp live test] LGTM' },
        ctx,
      ),
    ).resolves.toBeUndefined();
  });
});
