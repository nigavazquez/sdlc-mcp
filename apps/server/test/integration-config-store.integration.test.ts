import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { PostgresIntegrationConfigStore } from '../src/integrations/postgres.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe('PostgresIntegrationConfigStore', () => {
  const client = postgres(url!, { max: 2 });
  const store = new PostgresIntegrationConfigStore({ databaseUrl: url!, client });

  beforeAll(async () => {
    await client`DELETE FROM tenant_integrations WHERE tenant_id = 'it-tenant'`;
  });
  afterAll(async () => {
    await client`DELETE FROM tenant_integrations WHERE tenant_id = 'it-tenant'`;
    await store.close();
  });

  it('defaults to in-memory when no row exists', async () => {
    const cfg = await store.getTaskSystemConfig('it-tenant', 'proj-a');
    expect(cfg).toEqual({ kind: 'in-memory', settings: {} });
  });

  it('reads an exact (tenant, project) row', async () => {
    const taskSystem = JSON.stringify({ kind: 'azure-devops', settings: { org: 'acme' } });
    await client`
      INSERT INTO tenant_integrations (tenant_id, project, task_system)
      VALUES ('it-tenant', 'proj-a', ${taskSystem}::jsonb)
    `;
    const cfg = await store.getTaskSystemConfig('it-tenant', 'proj-a');
    expect(cfg.kind).toBe('azure-devops');
    expect(cfg.settings).toEqual({ org: 'acme' });
  });

  it('falls back to the tenant default row (project="")', async () => {
    const taskSystem = JSON.stringify({ kind: 'azure-devops', settings: {} });
    await client`
      INSERT INTO tenant_integrations (tenant_id, project, task_system)
      VALUES ('it-tenant', '', ${taskSystem}::jsonb)
    `;
    const cfg = await store.getTaskSystemConfig('it-tenant', 'proj-unknown');
    expect(cfg.kind).toBe('azure-devops');
  });
});
