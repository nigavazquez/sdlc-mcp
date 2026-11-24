import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubPullRequestAdapter } from '../src/adapters/github-pr-adapter.js';

const mockFetch = vi.fn();
beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});
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
      mockFetch.mockImplementation(() => Promise.resolve(resp({})));
      await adapter.requestReview({ pr_ref: prRef, reviewer_ids: ['bob', 'carol'] }, ctx);
      const call = mockFetch.mock.calls[0];
      expect(call[0]).toMatch(/requested_reviewers/);
      const body = JSON.parse(call[1].body as string);
      expect(body.reviewers).toEqual(['bob', 'carol']);
    });

    it('posts a COMMENT review when message is supplied', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockImplementation(() => Promise.resolve(resp({})));
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
      mockFetch.mockImplementation(() => Promise.resolve(resp({ id: 1 })));
      await adapter.submitOutcome({ pr_ref: prRef, outcome: 'approved', comment: 'LGTM' }, ctx);
      const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
      expect(body.event).toBe('APPROVE');
      expect(body.body).toBe('LGTM');
    });

    it('posts REQUEST_CHANGES review with body', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockImplementation(() => Promise.resolve(resp({ id: 2 })));
      await adapter.submitOutcome(
        { pr_ref: prRef, outcome: 'changes_requested', comment: 'please fix X' },
        ctx,
      );
      const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
      expect(body.event).toBe('REQUEST_CHANGES');
    });

    // Review propio (#27): GitHub no deja que el autor del PR apruebe ni pida
    // cambios sobre su propio PR (422), así que la firma propia queda como COMMENT.
    it('as_author: approved se publica como COMMENT con el detalle, no como APPROVE', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockImplementation(() => Promise.resolve(resp({ id: 3 })));
      await adapter.submitOutcome(
        { pr_ref: prRef, outcome: 'approved', comment: 'detalle del review', as_author: true },
        ctx,
      );
      const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
      expect(body.event).toBe('COMMENT');
      expect(body.body).toBe('detalle del review');
    });

    it('as_author: changes_requested también es COMMENT, con el comentario', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockImplementation(() => Promise.resolve(resp({ id: 4 })));
      await adapter.submitOutcome(
        { pr_ref: prRef, outcome: 'changes_requested', comment: 'arreglar X', as_author: true },
        ctx,
      );
      const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
      expect(body.event).toBe('COMMENT');
      expect(body.body).toBe('arreglar X');
    });

    it('as_author sin comentario no manda un body vacío (GitHub rechaza COMMENT vacío)', async () => {
      const prRef = adapter.parsePrUrl(PR_URL);
      mockFetch.mockImplementation(() => Promise.resolve(resp({ id: 5 })));
      await adapter.submitOutcome({ pr_ref: prRef, outcome: 'approved', as_author: true }, ctx);
      const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
      expect(body.event).toBe('COMMENT');
      expect(body.body).toMatch(/review propio/i);
      expect(body.body).toMatch(/approved/);
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
