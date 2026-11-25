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
    await client`DELETE FROM gate_events WHERE tenant_id = 'it-tenant'`;
  });
  afterAll(async () => {
    await client`DELETE FROM gate_leases WHERE tenant_id = 'it-tenant'`;
    await client`DELETE FROM gate_events WHERE tenant_id = 'it-tenant'`;
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

  it('bindAndRenew ata repo y branch la primera vez y después sólo acepta los mismos', async () => {
    const grant = await issueStoryLease(store, { ...req, storyId: 'it-tenant:it-ws:f::bind' });
    const hash = hashLeaseId(grant.lease_id);
    const exp = new Date(Date.now() + 3_600_000).toISOString();

    const bound = await store.bindAndRenew(hash, { repo: 'r', branch: 'feat/a', expires_at: exp });
    expect(bound).toMatchObject({ repo: 'r', branch: 'feat/a', expires_at: exp });
    expect(
      await store.bindAndRenew(hash, { repo: 'r', branch: 'feat/b', expires_at: exp }),
    ).toBeUndefined();
    expect((await store.getLease(hash))?.branch).toBe('feat/a');
  });

  it('insertEvents guarda el batch', async () => {
    await store.insertEvents([
      {
        tenant_id: 'it-tenant',
        workspace_id: 'it-ws',
        user_id: 'alice',
        repo: 'r',
        branch: 'feat/a',
        kind: 'commit.allowed',
        lease_kind: 'story',
        story_id: 'it-tenant:it-ws:f::bind',
        reason: null,
        detail: { tool: 'Bash' },
        created_at: new Date().toISOString(),
      },
    ]);
    const rows = await client`SELECT kind, detail FROM gate_events WHERE tenant_id = 'it-tenant'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'commit.allowed', detail: { tool: 'Bash' } });
  });

  it('issueBypassLease guarda lease y evento juntos, y countEvents los cuenta por workspace y fecha', async () => {
    const created = new Date().toISOString();
    const lease = await store.issueBypassLease(
      {
        lease_hash: hashLeaseId('gl_it_bypass'),
        tenant_id: 'it-tenant',
        workspace_id: 'it-ws',
        user_id: 'alice',
        repo: 'r',
        branch: 'hotfix/x',
        reason: 'prod caído, fix urgente',
        created_at: created,
        expires_at: new Date(Date.now() + 1_800_000).toISOString(),
      },
      {
        tenant_id: 'it-tenant',
        workspace_id: 'it-ws',
        user_id: 'alice',
        repo: 'r',
        branch: 'hotfix/x',
        kind: 'bypass.created',
        lease_kind: 'bypass',
        story_id: null,
        reason: 'prod caído, fix urgente',
        detail: {},
        created_at: created,
      },
    );
    expect(lease).toMatchObject({ kind: 'bypass', branch: 'hotfix/x', story_id: null });

    const counts = await store.countEvents(
      'it-tenant',
      'it-ws',
      new Date(Date.now() - 60_000).toISOString(),
    );
    expect(counts).toEqual({
      commits_allowed_story: 1,
      commits_allowed_bypass: 0,
      commits_blocked: 0,
      edits_blocked: 0,
      bypasses: 1,
    });
    expect((await store.countEvents('it-tenant', 'otro-ws', '1970-01-01T00:00:00Z')).bypasses).toBe(
      0,
    );
  });
});
