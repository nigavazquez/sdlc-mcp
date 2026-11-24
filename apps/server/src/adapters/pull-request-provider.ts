import type { Flow } from '@sdlc/core';
import type {
  Annotation,
  PrDetails,
  PullRequestAdapter,
  PullRequestRef,
  RequestReviewInput,
  SubmitOutcomeInput,
} from '@sdlc/adapters-contracts';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { IntegrationConfigStore } from '../integrations/types.js';
import { AzureDevOpsPullRequestAdapter } from './azure-devops-pull-request.js';
import { GitHubPullRequestAdapter } from './github-pr-adapter.js';
import { InMemoryAnnotationLog, type RecordedAnnotations } from './in-memory-annotations.js';

/** Selects + builds the PullRequestAdapter for a given flow at call time. */
export interface PullRequestProvider {
  /**
   * Resolves the PR adapter for a flow. `opts.project` overrides the integration
   * project key used to look up the provider config — used for multi-repo flows
   * where a story's target component lives under a different integration project
   * than the flow default.
   */
  resolve(ctx: TenantCtx, flow: Flow, opts?: { project?: string }): Promise<PullRequestAdapter>;
}

export interface ConfigBackedPullRequestProviderDeps {
  configStore: IntegrationConfigStore;
  /** Shared no-op used when no pr_provider is configured (tests/dev). */
  noOp: NoOpPullRequestAdapter;
}

export class ConfigBackedPullRequestProvider implements PullRequestProvider {
  constructor(private readonly deps: ConfigBackedPullRequestProviderDeps) {}

  async resolve(ctx: TenantCtx, flow: Flow, opts?: { project?: string }): Promise<PullRequestAdapter> {
    const cfg = await this.deps.configStore.getPrProviderConfig(ctx.tenantId, opts?.project ?? flow.project);
    if (!cfg) {
      // An explicit component repo_project that has no seeded config is a
      // misconfiguration — fail loudly instead of silently no-op'ing the
      // review. Only the flow-default lookup keeps the NoOp fallback
      // (tests/dev without integrations).
      if (opts?.project) {
        throw new Error(
          `No pr_provider configured for integration project "${opts.project}" (tenant ${ctx.tenantId}). ` +
            'Seed tenant_integrations for that project or fix the component repo_project in the RFC.',
        );
      }
      return this.deps.noOp;
    }
    switch (cfg.kind) {
      case 'azure-devops-repos': {
        if (!cfg.secret_ref) {
          throw new Error('azure-devops-repos pr_provider: secret_ref is required');
        }
        const pat = await ctx.resolveSecret(cfg.secret_ref);
        return new AzureDevOpsPullRequestAdapter({ pat });
      }
      case 'github': {
        if (!cfg.secret_ref) {
          throw new Error('github pr_provider: secret_ref is required');
        }
        const token = await ctx.resolveSecret(cfg.secret_ref);
        return new GitHubPullRequestAdapter({ token });
      }
      default:
        throw new Error(`unknown pr_provider kind: ${cfg.kind}`);
    }
  }
}

/**
 * Discriminante explícito del adapter no-op.
 *
 * Las tools que cierran un gate necesitan poder distinguirlo del adapter real:
 * el no-op acepta cualquier URL y no verifica nada, así que dejarlo pasar
 * fabrica un PR fantasma. Se expone como propiedad en vez de resolverlo con
 * `instanceof` porque `instanceof` se rompe silenciosamente cuando el módulo se
 * carga dos veces (ESM + CJS, o dobles de test) y el fallo sería fail-open.
 */
export function isNoOpPullRequestAdapter(adapter: PullRequestAdapter): boolean {
  return (adapter as Partial<NoOpPullRequestAdapter>).is_noop === true;
}

/** No-op adapter used when no pr_provider is configured. Flow/story still advance. */
export class NoOpPullRequestAdapter implements PullRequestAdapter {
  /** Satisfies the PullRequestAdapter contract; value is not used in no-op context. */
  readonly kind = 'github' as const;

  /** Marca leída por `isNoOpPullRequestAdapter`; ver el comentario de esa función. */
  readonly is_noop = true as const;

  private readonly annotations = new InMemoryAnnotationLog();

  parsePrUrl(url: string): PullRequestRef {
    return { url, pr_id: 'noop', _parsed: {} };
  }

  async requestReview(_input: RequestReviewInput, _ctx: TenantCtx): Promise<void> {
    // intentional no-op
  }

  async submitOutcome(_input: SubmitOutcomeInput, _ctx: TenantCtx): Promise<void> {
    // intentional no-op
  }

  /**
   * Guarda la anotación en memoria (por URL del PR) para que los tests la lean.
   * No llega a ningún lado: las tools que exigen la marca visible afuera tienen
   * que rechazar este adapter con `isNoOpPullRequestAdapter`.
   */
  async annotate(ref: PullRequestRef, annotation: Annotation, _ctx: TenantCtx): Promise<void> {
    this.annotations.record(ref.url, annotation);
  }

  /** Para tests: lo que quedó anotado sobre el PR. */
  annotationsOf(prUrl: string): RecordedAnnotations {
    return this.annotations.get(prUrl);
  }

  async getPullRequest(ref: PullRequestRef, _ctx: TenantCtx): Promise<PrDetails> {
    throw new Error(
      `No pr_provider configured; cannot fetch PR details for ${ref.url}. ` +
        'Set pr_provider in tenant_integrations to enable real PR operations.',
    );
  }
}
