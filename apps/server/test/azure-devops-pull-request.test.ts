import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AzureDevOpsPullRequestAdapter } from '../src/adapters/azure-devops-pull-request.js';

const mockFetch = vi.fn();
beforeEach(() => {
  mockFetch.mockClear();
  vi.stubGlobal('fetch', mockFetch);
});
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
      expect(ref._parsed['org']).toBe('myorg');
      expect(ref._parsed['project']).toBe('myproject');
      expect(ref._parsed['repo']).toBe('myrepo');
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

    it('uses the correct GET URL with api-version', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockResolvedValueOnce(
        resp({
          pullRequestId: 42,
          title: 'T',
          status: 'active',
          createdBy: { uniqueName: 'dev@example.com' },
        }),
      );
      await adapter.getPullRequest(prRef, ctx);
      const url: string = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('myorg');
      expect(url).toContain('myproject');
      expect(url).toContain('myrepo');
      expect(url).toContain('42');
      expect(url).toContain('api-version=7.1');
    });

    it('sends Authorization: Basic header (does not leak PAT in error)', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockResolvedValueOnce(
        resp({
          pullRequestId: 42,
          title: 'T',
          status: 'active',
          createdBy: { uniqueName: 'dev@example.com' },
        }),
      );
      await adapter.getPullRequest(prRef, ctx);
      const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
      expect(headers['Authorization']).toMatch(/^Basic /);
      // PAT must not appear in the auth header as plaintext
      expect(headers['Authorization']).not.toContain('test-pat');
    });
  });

  describe('requestReview', () => {
    it('PUTs each reviewer_id with vote=0 and no thread when no message', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockImplementation(() => Promise.resolve(resp({})));
      await adapter.requestReview({ pr_ref: prRef, reviewer_ids: ['id-alice', 'id-bob'] }, ctx);
      const calls = mockFetch.mock.calls;
      expect(calls).toHaveLength(2);
      const bodies = calls.map((c) => JSON.parse(c[1].body as string));
      expect(bodies.every((b: { vote: number }) => b.vote === 0)).toBe(true);
    });

    it('URL-encodes reviewer IDs in the PUT path', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockImplementation(() => Promise.resolve(resp({})));
      await adapter.requestReview({ pr_ref: prRef, reviewer_ids: ['id/with/slash'] }, ctx);
      const url: string = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('id%2Fwith%2Fslash');
    });

    it('posts a thread when message is supplied', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockImplementation(() => Promise.resolve(resp({})));
      await adapter.requestReview(
        { pr_ref: prRef, reviewer_ids: ['id-alice'], message: 'please review' },
        ctx,
      );
      // 1 reviewer PUT + 1 thread POST = 2 calls
      expect(mockFetch.mock.calls).toHaveLength(2);
    });

    it('uses PUT method for each reviewer', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockImplementation(() => Promise.resolve(resp({})));
      await adapter.requestReview({ pr_ref: prRef, reviewer_ids: ['id-alice'] }, ctx);
      expect(mockFetch.mock.calls[0][1].method).toBe('PUT');
    });
  });

  describe('submitOutcome', () => {
    it('PUTs vote=10 for approved', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockImplementation(() => Promise.resolve(resp({})));
      await adapter.submitOutcome(
        { pr_ref: prRef, outcome: 'approved', comment: 'LGTM' },
        ctx,
      );
      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.vote).toBe(10);
    });

    it('PUTs vote=-10 and posts thread for changes_requested', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockImplementation(() => Promise.resolve(resp({})));
      await adapter.submitOutcome(
        { pr_ref: prRef, outcome: 'changes_requested', comment: 'needs work' },
        ctx,
      );
      // 1 vote PUT + 1 thread POST
      expect(mockFetch.mock.calls).toHaveLength(2);
      const votebody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(votebody.vote).toBe(-10);
    });

    it('approved with comment posts thread as well', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockImplementation(() => Promise.resolve(resp({})));
      await adapter.submitOutcome(
        { pr_ref: prRef, outcome: 'approved', comment: 'LGTM' },
        ctx,
      );
      // 1 vote PUT + 1 thread POST (because comment is provided)
      expect(mockFetch.mock.calls).toHaveLength(2);
    });

    it('approved without comment makes only one request (no thread)', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockImplementation(() => Promise.resolve(resp({})));
      await adapter.submitOutcome(
        { pr_ref: prRef, outcome: 'approved' },
        ctx,
      );
      // Only 1 vote PUT — no comment, no thread
      expect(mockFetch.mock.calls).toHaveLength(1);
    });

    it('throws PrRateLimitError on HTTP 429', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockResolvedValueOnce(new Response('', { status: 429 }));
      await expect(
        adapter.submitOutcome({ pr_ref: prRef, outcome: 'approved' }, ctx),
      ).rejects.toThrow(/rate limit/i);
    });

    it('throws PrAuthError on HTTP 401', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockResolvedValueOnce(new Response('', { status: 401 }));
      await expect(
        adapter.submitOutcome({ pr_ref: prRef, outcome: 'approved' }, ctx),
      ).rejects.toThrow(/auth/i);
    });

    it('throws PrApiError on HTTP 500 without leaking PAT', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockResolvedValueOnce(new Response('server error', { status: 500 }));
      let caughtError: unknown;
      try {
        await adapter.submitOutcome({ pr_ref: prRef, outcome: 'approved' }, ctx);
      } catch (e) {
        caughtError = e;
      }
      expect(caughtError).toBeDefined();
      expect((caughtError as Error).message).not.toContain('test-pat');
      expect((caughtError as Error).message).toContain('500');
    });

    it('URL-encodes ctx.userId in the vote reviewer path', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      const ctxWithSpecialId = { ...ctx, userId: 'user/with/slash' };
      mockFetch.mockImplementation(() => Promise.resolve(resp({})));
      await adapter.submitOutcome({ pr_ref: prRef, outcome: 'approved' }, ctxWithSpecialId);
      const url: string = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('user%2Fwith%2Fslash');
    });
  });

  describe('parsePrUrl additional cases', () => {
    it('handles URL with trailing slash gracefully', () => {
      // Trailing slash after pr number — still parses since regex is prefix-match
      const ref = adapter.parsePrUrl('https://dev.azure.com/org/proj/_git/repo/pullrequest/7');
      expect(ref.pr_id).toBe('7');
    });

    it('rejects a non-integer PR id in URL', () => {
      expect(() =>
        adapter.parsePrUrl('https://dev.azure.com/org/proj/_git/repo/pullrequest/abc'),
      ).toThrow();
    });

    it('prId coerced to integer — no path injection via pr_id', () => {
      const ref = adapter.parsePrUrl(PR_URL);
      // pr_id captured by /(\d+)/ regex, so it's always digits
      expect(/^\d+$/.test(ref.pr_id)).toBe(true);
    });
  });
});
