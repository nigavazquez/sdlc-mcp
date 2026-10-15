import { describe, expect, it } from 'vitest';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';

describe('integration config admin write path (in-memory)', () => {
  it('upsert + list + resolution', async () => {
    const s = new InMemoryIntegrationConfigStore();
    await s.upsertIntegration({
      tenant_id: 't1',
      project: 'demo',
      config: { task_system: { kind: 'azure-devops', secret_ref: 'aws-sm://pat', settings: { project: 'Demo' } } },
    });
    const rows = await s.listIntegrations('t1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.config.task_system?.kind).toBe('azure-devops');
    expect((await s.getTaskSystemConfig('t1', 'demo')).kind).toBe('azure-devops');
  });

  it('upsert replaces the whole row; delete removes it', async () => {
    const s = new InMemoryIntegrationConfigStore();
    await s.upsertIntegration({
      tenant_id: 't1',
      project: 'demo',
      config: { pr_provider: { kind: 'github', settings: {} } },
    });
    await s.upsertIntegration({
      tenant_id: 't1',
      project: 'demo',
      config: { doc_store: { kind: 'gdrive', settings: {} } },
    });
    const [row] = await s.listIntegrations('t1');
    expect(row?.config.pr_provider).toBeUndefined(); // fila canónica, no merge
    expect(row?.config.doc_store?.kind).toBe('gdrive');
    expect(await s.deleteIntegration('t1', 'demo')).toBe(true);
    expect(await s.deleteIntegration('t1', 'demo')).toBe(false);
    expect(await s.listIntegrations('t1')).toEqual([]);
  });
});
