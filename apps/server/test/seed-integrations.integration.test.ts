import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { seedIntegrations } from '../src/integrations/seed.js';
import { PostgresIntegrationConfigStore } from '../src/integrations/postgres.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe('seedIntegrations (integration)', () => {
  const client = postgres(url!, { max: 2 });
  const db = drizzle(client);
  const store = new PostgresIntegrationConfigStore({ databaseUrl: url!, client });

  beforeAll(async () => {
    await client`DELETE FROM tenant_integrations WHERE tenant_id = 'seed-it'`;
  });
  afterAll(async () => {
    await client`DELETE FROM tenant_integrations WHERE tenant_id = 'seed-it'`;
    await client.end({ timeout: 5 });
  });

  const cfg = {
    tenants: [
      {
        tenant_id: 'seed-it',
        projects: [
          {
            project: 'checkout',
            task_system: {
              kind: 'azure-devops',
              secret_ref: 'aws-sm://sdlc/ado-pat#token',
              settings: { org: 'your-org', project: 'Checkout' },
            },
          },
        ],
      },
    ],
  };

  it('upserts a row that the config store then reads back', async () => {
    const res = await seedIntegrations(db, cfg);
    expect(res.created).toContain('seed-it/checkout');
    const ref = await store.getTaskSystemConfig('seed-it', 'checkout');
    expect(ref.kind).toBe('azure-devops');
    expect(ref.settings).toEqual({ org: 'your-org', project: 'Checkout' });
  });

  it('is idempotent — second run updates, does not duplicate', async () => {
    const updated = {
      tenants: [
        {
          tenant_id: 'seed-it',
          projects: [
            {
              project: 'checkout',
              task_system: {
                kind: 'azure-devops',
                secret_ref: 'aws-sm://sdlc/ado-pat#token',
                settings: { org: 'your-org', project: 'CheckoutV2' },
              },
            },
          ],
        },
      ],
    };
    const res = await seedIntegrations(db, updated);
    expect(res.updated).toContain('seed-it/checkout');
    const rows = await client`
      SELECT count(*)::int AS n FROM tenant_integrations
      WHERE tenant_id = 'seed-it' AND project = 'checkout'
    `;
    expect(rows[0]!.n).toBe(1);
    const ref = await store.getTaskSystemConfig('seed-it', 'checkout');
    expect(ref.settings).toEqual({ org: 'your-org', project: 'CheckoutV2' });
  });
});
