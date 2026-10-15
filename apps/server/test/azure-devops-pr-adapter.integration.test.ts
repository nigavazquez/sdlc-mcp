/**
 * Live integration test against a real Azure DevOps pull request.
 * Skipped unless ADO_PR_TEST_ORG (and related vars) are set.
 * Never run in CI without those env vars configured.
 *
 * Non-destructive: only reads the PR and adds votes/threads.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AzureDevOpsPullRequestAdapter } from '../src/adapters/azure-devops-pull-request.js';
import type { TenantCtx } from '@sdlc/adapters-contracts';

const ORG = process.env.ADO_PR_TEST_ORG;
const maybe = ORG ? describe : describe.skip;

maybe('AzureDevOpsPullRequestAdapter (live)', () => {
  const PROJECT = process.env.ADO_PR_TEST_PROJECT!;
  const REPO = process.env.ADO_PR_TEST_REPO!;
  const PR_ID = process.env.ADO_PR_TEST_PR_ID!;
  const PAT = process.env.ADO_PR_TEST_PAT!;
  const REVIEWER_ID = process.env.ADO_PR_TEST_REVIEWER_ID!;

  const PR_URL = `https://dev.azure.com/${ORG}/${PROJECT}/_git/${REPO}/pullrequest/${PR_ID}`;
  const ctx: TenantCtx = {
    tenantId: 't1',
    userId: REVIEWER_ID,
    roles: [],
    resolveSecret: async () => '',
  };

  let adapter: AzureDevOpsPullRequestAdapter;

  beforeAll(() => {
    adapter = new AzureDevOpsPullRequestAdapter({ pat: PAT });
  });

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
      adapter.submitOutcome(
        { pr_ref: ref, outcome: 'approved', comment: '[sdlc-mcp live test] LGTM' },
        ctx,
      ),
    ).resolves.toBeUndefined();
  });
});
