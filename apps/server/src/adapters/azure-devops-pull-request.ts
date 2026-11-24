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
import { AnnotationNotSupportedError } from './annotation-errors.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Matches ADO pull-request URLs.
 * Only allows digit sequences for the PR id — no injection possible.
 * Org/project/repo segments are captured but later URL-encoded before use.
 */
const ADO_PR_RE =
  /^https:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/i;

const API_VERSION = 'api-version=7.1';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AzureDevOpsPrAdapterOptions {
  pat: string;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class AzureDevOpsPullRequestAdapter implements PullRequestAdapter {
  readonly kind = 'azure-devops-repos' as const;

  /**
   * Base64-encoded "Basic :<pat>" auth header.
   * The PAT itself is never interpolated into URL paths or error messages.
   */
  private readonly authHeader: string;

  constructor(private readonly opts: AzureDevOpsPrAdapterOptions) {
    // Standard ADO basic-auth: colon-prefixed PAT, base64-encoded.
    this.authHeader = 'Basic ' + Buffer.from(':' + opts.pat).toString('base64');
  }

  // ---------------------------------------------------------------------------
  // PullRequestAdapter — public API
  // ---------------------------------------------------------------------------

  parsePrUrl(url: string): PullRequestRef {
    const m = ADO_PR_RE.exec(url);
    if (!m) {
      throw new Error(
        `AzureDevOpsPullRequestAdapter: cannot parse PR URL — expected ` +
          `https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<id>`,
      );
    }
    // Coerce pr_id to integer to guarantee it is a safe integer — prevents
    // any residual injection via a crafted URL that somehow slips through the regex.
    const prId = String(parseInt(m[4]!, 10));
    return {
      url,
      pr_id: prId,
      _parsed: {
        org: m[1]!,
        project: m[2]!,
        repo: m[3]!,
        prId,
      },
    };
  }

  async getPullRequest(ref: PullRequestRef, _ctx: TenantCtx): Promise<PrDetails> {
    const url = `${this.baseUrl(ref)}?${API_VERSION}`;
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
    for (const reviewerId of input.reviewer_ids) {
      // URL-encode reviewer ID to prevent path injection via crafted GUIDs/descriptors.
      await this.request(
        `${this.baseUrl(input.pr_ref)}/reviewers/${encodeURIComponent(reviewerId)}?${API_VERSION}`,
        { method: 'PUT', body: JSON.stringify({ vote: 0, isRequired: false }) },
      );
    }
    if (input.message !== undefined) {
      await this.postThread(input.pr_ref, input.message);
    }
  }

  /** Thread con el detalle + label del PR: pendiente (historia #25). */
  async annotate(_ref: PullRequestRef, _annotation: Annotation, _ctx: TenantCtx): Promise<void> {
    throw new AnnotationNotSupportedError('azure-devops-repos');
  }

  async submitOutcome(input: SubmitOutcomeInput, ctx: TenantCtx): Promise<void> {
    const vote = input.outcome === 'approved' ? 10 : -10;
    // URL-encode userId — prevents path injection if userId contains slashes or special chars.
    await this.request(
      `${this.baseUrl(input.pr_ref)}/reviewers/${encodeURIComponent(ctx.userId)}?${API_VERSION}`,
      { method: 'PUT', body: JSON.stringify({ vote }) },
    );
    if (input.comment !== undefined) {
      await this.postThread(input.pr_ref, input.comment);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Constructs the base ADO Git/PR REST API URL for the given ref.
   * All dynamic segments (org, project, repo, prId) are URL-encoded to prevent
   * path injection if a crafted URL somehow contained encoded slashes.
   */
  private baseUrl(ref: PullRequestRef): string {
    const { org, project, repo, prId } = ref._parsed;
    return (
      `https://dev.azure.com/${encodeURIComponent(org!)}` +
      `/${encodeURIComponent(project!)}` +
      `/_apis/git/repositories/${encodeURIComponent(repo!)}` +
      `/pullRequests/${encodeURIComponent(prId!)}`
    );
  }

  /**
   * Posts a comment thread on the PR.
   * `content` is embedded in JSON (not HTML), so no HTML-escaping needed here.
   */
  private async postThread(ref: PullRequestRef, content: string): Promise<void> {
    await this.request(`${this.baseUrl(ref)}/threads?${API_VERSION}`, {
      method: 'POST',
      body: JSON.stringify({
        comments: [{ parentCommentId: 0, content, commentType: 1 }],
        status: 'active',
      }),
    });
  }

  /**
   * Core fetch wrapper.
   * Security:
   * - Authorization header carries the PAT; it is NEVER echoed in error messages.
   * - 429 → PrRateLimitError (safe message, no body read).
   * - 401/403 → PrAuthError (status code only, no body).
   * - 404 → generic Error with "PR not found" (no ADO body, no PAT).
   * - Other non-2xx → PrApiError (status + safe body text, no PAT).
   */
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

    if (res.status === 429) {
      throw new PrRateLimitError('ADO rate limit reached; retry later');
    }
    if (res.status === 401 || res.status === 403) {
      throw new PrAuthError(`ADO auth failed (${res.status})`);
    }
    if (res.status === 404) {
      throw new Error(`PR not found: ${url}`);
    }
    if (!res.ok) {
      // Read response body for debugging, but keep message safe (no PAT).
      const text = await res.text().catch(() => '');
      throw new PrApiError(res.status, `ADO API error ${res.status}: ${text}`);
    }

    return res.json() as Promise<unknown>;
  }
}
