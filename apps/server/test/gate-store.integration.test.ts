import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { PostgresGateStore, hashLeaseId, issueStoryLease } from '../src/gate/index.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe('PostgresGateStore', () => {
  const client = postgres(url!, { max: 2 });
  const store = new PostgresGateStore({ databaseUrl: url!, client });
  const req = {
    tenantId: 'it-tenant',
    workspaceId: 'it-ws',
    storyId: 'it-tenant:it-ws:f::1',
    flowId: 'it-tenant:it-ws:f',
    userId: 'alice',
  };

  beforeAll(async () => {
    await client`DELETE FROM gate_leases WHERE tenant_id = 'it-tenant'`;
  });
  afterAll(async () => {
    await client`DELETE FROM gate_leases WHERE tenant_id = 'it-tenant'`;
    await store.close();
  });

  it('guarda el lease por hash, sin el secreto', async () => {
    const grant = await issueStoryLease(store, req);
    const row = await store.getLease(hashLeaseId(grant.lease_id));

    expect(row).toMatchObject({ kind: 'story', workspace_id: 'it-ws', revoked_at: null });
    expect(row?.expires_at).toBe(grant.expires_at);
    const raw = await client`SELECT * FROM gate_leases WHERE tenant_id = 'it-tenant'`;
    expect(JSON.stringify(raw)).not.toContain(grant.lease_id);
  });

  it('un lease nuevo de la misma story revoca el anterior', async () => {
    const first = await issueStoryLease(store, req);
    const second = await issueStoryLease(store, req);

    expect((await store.getLease(hashLeaseId(first.lease_id)))?.revoked_at).not.toBeNull();
    expect((await store.getLease(hashLeaseId(second.lease_id)))?.revoked_at).toBeNull();
  });
});
