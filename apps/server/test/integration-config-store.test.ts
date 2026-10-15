import { describe, expect, it } from 'vitest';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';

describe('InMemoryIntegrationConfigStore', () => {
  it('defaults to kind "in-memory" when no config exists', async () => {
    const store = new InMemoryIntegrationConfigStore();
    const cfg = await store.getTaskSystemConfig('t1', 'proj-a');
    expect(cfg).toEqual({ kind: 'in-memory', settings: {} });
  });

  it('returns the exact (tenant, project) match', async () => {
    const store = new InMemoryIntegrationConfigStore();
    store.seed('t1', 'proj-a', {
      task_system: { kind: 'azure-devops', secret_ref: 'aws-sm://ado#token', settings: { org: 'acme' } },
    });
    const cfg = await store.getTaskSystemConfig('t1', 'proj-a');
    expect(cfg.kind).toBe('azure-devops');
    expect(cfg.settings).toEqual({ org: 'acme' });
  });

  it('falls back to the tenant default row (project="")', async () => {
    const store = new InMemoryIntegrationConfigStore();
    store.seed('t1', '', { task_system: { kind: 'azure-devops', settings: {} } });
    const cfg = await store.getTaskSystemConfig('t1', 'proj-z');
    expect(cfg.kind).toBe('azure-devops');
  });
});
