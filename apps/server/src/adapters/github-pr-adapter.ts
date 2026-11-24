import type {
  Annotation,
  PrDetails,
  PullRequestAdapter,
  PullRequestRef,
  RequestReviewInput,
  SubmitOutcomeInput,
} from '@sdlc/adapters-contracts';
import type { TenantCtx } from '@sdlc/adapters-contracts';
export { PrApiError, PrAuthError, PrRateLimitError } from './pull-request-errors.js';
import { PrApiError, PrAuthError, PrRateLimitError } from './pull-request-errors.js';
import { annotateGitHubIssue } from './github-annotation.js';

const GH_PR_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i;

// ---------------------------------------------------------------------------

export interface GitHubPrAdapterOptions {
  token: string;
}

export class GitHubPullRequestAdapter implements PullRequestAdapter {
  readonly kind = 'github' as const;

  constructor(private readonly opts: GitHubPrAdapterOptions) {}

  parsePrUrl(url: string): PullRequestRef {
    const m = GH_PR_RE.exec(url);
    if (!m) throw new Error(`GitHubPullRequestAdapter: cannot parse PR URL: ${url}`);
    // Coerce PR number to an integer to prevent injection; URL-encode owner/repo
    const owner = encodeURIComponent(m[1]!);
    const repo = encodeURIComponent(m[2]!);
    const number = String(parseInt(m[3]!, 10));
    return {
      url,
      pr_id: number,
      _parsed: { owner, repo, number },
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
      // Safe message — does NOT leak the auth token
      throw new PrAuthError(`GitHub auth failed (HTTP ${res.status})`);
    if (res.status === 404) throw new Error(`PR not found: ${url}`);
    if (!res.ok) {
      // Read body for context but never include Authorization header value
      const body = await res.text().catch(() => '');
      throw new PrApiError(res.status, `GitHub API error ${res.status}: ${body}`);
    }

    const text = await res.text();
    return text ? (JSON.parse(text) as unknown) : {};
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

  /** Un PR es un issue para GitHub: etiquetas y comentarios van por la API de issues. */
  async annotate(ref: PullRequestRef, annotation: Annotation, _ctx: TenantCtx): Promise<void> {
    const { owner, repo, number } = ref._parsed;
    await annotateGitHubIssue(
      <T>(url: string, method: string, body?: unknown) =>
        this.request(url, {
          method,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }) as Promise<T>,
      `https://api.github.com/repos/${owner}/${repo}`,
      parseInt(number ?? '', 10),
      annotation,
    );
  }

  async submitOutcome(input: SubmitOutcomeInput, _ctx: TenantCtx): Promise<void> {
    const event = input.outcome === 'approved' ? 'APPROVE' : 'REQUEST_CHANGES';
    await this.request(`${this.base(input.pr_ref)}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ event, ...(input.comment !== undefined ? { body: input.comment } : { body: '' }) }),
    });
  }
}
