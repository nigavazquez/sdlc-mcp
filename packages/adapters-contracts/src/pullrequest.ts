import type { Annotation } from './annotation.js';
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
  /**
   * Etiqueta el PR y deja un comentario (ver `Annotation`). Idempotente por el
   * marcador del body. Tira un error explícito si el provider no sabe anotar.
   */
  annotate(ref: PullRequestRef, annotation: Annotation, ctx: TenantCtx): Promise<void>;
  /** Parse a pr_url into a PullRequestRef. Throws if URL format is unrecognised. */
  parsePrUrl(url: string): PullRequestRef;
}
