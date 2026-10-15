import { describe, expect, it } from 'vitest';
import type { Flow } from '@sdlc/core';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import {
  ConfigBackedPullRequestProvider,
  NoOpPullRequestAdapter,
} from '../src/adapters/pull-request-provider.js';
import { AzureDevOpsPullRequestAdapter } from '../src/adapters/azure-devops-pull-request.js';
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

  it('honors an opts.project override over flow.project', async () => {
    const configStore = new InMemoryIntegrationConfigStore();
    // The flow's own project has no PR provider; a different project ("platform") does.
    configStore.seed('t1', 'platform', {
      pr_provider: { kind: 'github', secret_ref: 'aws-sm://gh-token', settings: {} },
    });
    const noOp = new NoOpPullRequestAdapter();
    const provider = new ConfigBackedPullRequestProvider({ configStore, noOp });

    // Without the override, resolution uses flow.project ("proj") → no config → noOp.
    expect(await provider.resolve(ctx(), FLOW)).toBe(noOp);
    // With the override, resolution uses "platform" → GitHub adapter.
    const resolved = await provider.resolve(ctx(), FLOW, { project: 'platform' });
    expect(resolved).toBeInstanceOf(GitHubPullRequestAdapter);
  });

  it('throws when an explicit opts.project has no config (instead of silent noOp)', async () => {
    const configStore = new InMemoryIntegrationConfigStore();
    const provider = new ConfigBackedPullRequestProvider({
      configStore,
      noOp: new NoOpPullRequestAdapter(),
    });
    await expect(provider.resolve(ctx(), FLOW, { project: 'platfrom' })).rejects.toThrow(
      /No pr_provider configured for integration project "platfrom"/,
    );
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
