// ---------------------------------------------------------------------------
// Shared PR error types — shared by AzureDevOpsPullRequestAdapter and
// GitHubPullRequestAdapter so they can be barrel-exported without name collision.
// ---------------------------------------------------------------------------

/** Thrown on HTTP 401 or 403 (auth / permission failures). */
export class PrAuthError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'PrAuthError';
  }
}

/** Thrown on HTTP 429 (rate limit exceeded). */
export class PrRateLimitError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'PrRateLimitError';
  }
}

/** Thrown when the API returns a non-2xx, non-auth, non-rate-limit status. */
export class PrApiError extends Error {
  constructor(
    public readonly status: number,
    msg: string,
  ) {
    // Do NOT include any auth token in msg
    super(msg);
    this.name = 'PrApiError';
  }
}
