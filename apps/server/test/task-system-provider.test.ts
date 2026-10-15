import { describe, expect, it } from 'vitest';
import type { Flow } from '@sdlc/core';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';
import { ConfigBackedTaskSystemProvider } from '../src/adapters/task-system-provider.js';
import { AzureDevOpsTaskSystemAdapter } from '../src/adapters/azure-devops-task-system.js';
import { LinearTaskSystemAdapter } from '../src/adapters/linear-task-system.js';
import { GitHubIssuesTaskSystemAdapter } from '../src/adapters/github-issues-task-system.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';

const FLOW = { flow_id: 't1:proj-a:slug', tenant_id: 't1', project: 'proj-a' } as Flow;

function ctx(resolveSecret: TenantCtx['resolveSecret']): TenantCtx {
  return { tenantId: 't1', userId: 'u', roles: [], resolveSecret };
}

describe('ConfigBackedTaskSystemProvider', () => {
  it('returns the shared in-memory adapter by default', async () => {
    const inMemory = new InMemoryTaskSystemAdapter();
    const provider = new ConfigBackedTaskSystemProvider({
      configStore: new InMemoryIntegrationConfigStore(),
      inMemory,
    });
    const resolved = await provider.resolve(ctx(async () => 'x'), FLOW);
    expect(resolved).toBe(inMemory);
  });

  it('throws on azure-devops config missing secret_ref', async () => {
    const configStore = new InMemoryIntegrationConfigStore();
    configStore.seed('t1', 'proj-a', {
      task_system: { kind: 'azure-devops', settings: { org: 'acme', project: 'my-project' } },
    });
    const provider = new ConfigBackedTaskSystemProvider({
      configStore,
      inMemory: new InMemoryTaskSystemAdapter(),
    });
    await expect(
      provider.resolve(ctx(async () => 'x'), FLOW),
    ).rejects.toThrow('secret_ref is required');
  });

  it('throws on an unknown kind', async () => {
    const configStore = new InMemoryIntegrationConfigStore();
    configStore.seed('t1', 'proj-a', { task_system: { kind: 'jira', settings: {} } });
    const provider = new ConfigBackedTaskSystemProvider({
      configStore,
      inMemory: new InMemoryTaskSystemAdapter(),
    });
    await expect(provider.resolve(ctx(async () => 'x'), FLOW)).rejects.toThrow(/unknown task_system kind: jira/);
  });
});

describe('ConfigBackedTaskSystemProvider — azure-devops real adapter', () => {
  it('constructs AzureDevOpsTaskSystemAdapter and returns it (no throw)', async () => {
    const configStore = new InMemoryIntegrationConfigStore();
    configStore.seed('t1', 'proj-a', {
      task_system: {
        kind: 'azure-devops',
        secret_ref: 'aws-sm://ado#token',
        settings: { org: 'acme', project: 'my-project' },
      },
    });
    const provider = new ConfigBackedTaskSystemProvider({
      configStore,
      inMemory: new InMemoryTaskSystemAdapter(),
    });
    const resolved = await provider.resolve(
      ctx(async () => 'my-pat'),
      FLOW,
    );
    expect(resolved).toBeInstanceOf(AzureDevOpsTaskSystemAdapter);
    expect(resolved.kind).toBe('azure-devops');
  });

  it('passes org and project from settings to the adapter', async () => {
    const configStore = new InMemoryIntegrationConfigStore();
    configStore.seed('t1', 'proj-a', {
      task_system: {
        kind: 'azure-devops',
        secret_ref: 'aws-sm://ado#token',
        settings: { org: 'contoso', project: 'platform' },
      },
    });
    const provider = new ConfigBackedTaskSystemProvider({
      configStore,
      inMemory: new InMemoryTaskSystemAdapter(),
    });
    const resolved = (await provider.resolve(
      ctx(async () => 'pat'),
      FLOW,
    )) as AzureDevOpsTaskSystemAdapter;
    expect(resolved.orgName()).toBe('contoso');
    expect(resolved.projectName()).toBe('platform');
  });
});

describe('ConfigBackedTaskSystemProvider — linear', () => {
  function providerWith(settings: Record<string, unknown>, secret_ref?: string) {
    const configStore = new InMemoryIntegrationConfigStore();
    configStore.seed('t1', 'proj-a', {
      task_system: { kind: 'linear', ...(secret_ref ? { secret_ref } : {}), settings },
    });
    return new ConfigBackedTaskSystemProvider({
      configStore,
      inMemory: new InMemoryTaskSystemAdapter(),
    });
  }

  it('exige secret_ref', async () => {
    await expect(
      providerWith({ teamId: 'team-uuid' }).resolve(ctx(async () => 'x'), FLOW),
    ).rejects.toThrow('secret_ref is required');
  });

  it('resuelve el secreto y construye el adapter con el teamId de settings', async () => {
    const refs: string[] = [];
    const resolved = (await providerWith({ teamId: 'team-uuid' }, 'aws-sm://linear#key').resolve(
      ctx(async (r) => {
        refs.push(r);
        return 'lin_api_x';
      }),
      FLOW,
    )) as LinearTaskSystemAdapter;

    expect(resolved).toBeInstanceOf(LinearTaskSystemAdapter);
    expect(resolved.kind).toBe('linear');
    expect(resolved.teamIdentifier()).toBe('team-uuid');
    expect(refs).toEqual(['aws-sm://linear#key']);
  });

  it('propaga el error de settings faltantes del adapter', async () => {
    await expect(
      providerWith({}, 'aws-sm://linear#key').resolve(ctx(async () => 'k'), FLOW),
    ).rejects.toThrow(/missing required settings/);
  });
});

describe('ConfigBackedTaskSystemProvider — github', () => {
  function providerWith(settings: Record<string, unknown>, secret_ref?: string) {
    const configStore = new InMemoryIntegrationConfigStore();
    configStore.seed('t1', 'proj-a', {
      task_system: { kind: 'github', ...(secret_ref ? { secret_ref } : {}), settings },
    });
    return new ConfigBackedTaskSystemProvider({
      configStore,
      inMemory: new InMemoryTaskSystemAdapter(),
    });
  }

  it('exige secret_ref', async () => {
    await expect(
      providerWith({ owner: 'acme', repo: 'checkout' }).resolve(ctx(async () => 'x'), FLOW),
    ).rejects.toThrow('secret_ref is required');
  });

  it('resuelve el secreto y construye el adapter con owner/repo de settings', async () => {
    const refs: string[] = [];
    const resolved = (await providerWith(
      { owner: 'acme', repo: 'checkout' },
      'aws-sm://github#token',
    ).resolve(
      ctx(async (r) => {
        refs.push(r);
        return 'ghp_x';
      }),
      FLOW,
    )) as GitHubIssuesTaskSystemAdapter;

    expect(resolved).toBeInstanceOf(GitHubIssuesTaskSystemAdapter);
    expect(resolved.kind).toBe('github');
    expect(resolved.repoSlug()).toBe('acme/checkout');
    expect(refs).toEqual(['aws-sm://github#token']);
  });

  it('propaga el error de settings faltantes del adapter', async () => {
    await expect(
      providerWith({ owner: 'acme' }, 'aws-sm://github#token').resolve(ctx(async () => 'k'), FLOW),
    ).rejects.toThrow(/missing required settings/);
  });
});
