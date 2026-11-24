import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { PostgresAdminStore } from '../src/admin/postgres.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe('PostgresAdminStore — self_signoff (migración 0015)', () => {
  const client = postgres(url!, { max: 2 });
  const store = new PostgresAdminStore({ databaseUrl: url!, client });
  const migration = readFileSync(join(__dirname, '../migrations/0015_self_signoff.sql'), 'utf8');

  const cleanup = async () => {
    await client`DELETE FROM workspace_settings_audit WHERE workspace_id LIKE 'it-ss-%'`;
    await client`DELETE FROM workspaces WHERE workspace_id LIKE 'it-ss-%'`;
  };
  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await store.close();
  });

  it('un workspace que existía antes de la migración queda con self_signoff=true', async () => {
    // Simula la base previa a 0015: sin la columna, con un workspace ya creado.
    await client`ALTER TABLE workspaces DROP COLUMN IF EXISTS self_signoff`;
    await client`INSERT INTO workspaces (workspace_id, name) VALUES ('it-ss-viejo', 'Viejo')`;
    await client.unsafe(migration);

    expect((await store.getWorkspace('it-ss-viejo'))?.self_signoff).toBe(true);
  });

  it('setSelfSignoff cambia el valor y audita; repetirlo no agrega auditoría', async () => {
    await store.createWorkspace({ workspace_id: 'it-ss-a', name: 'A' });
    await store.setSelfSignoff('it-ss-a', false, 'admin@example.com');
    await store.setSelfSignoff('it-ss-a', false, 'admin@example.com');

    expect((await store.getWorkspace('it-ss-a'))?.self_signoff).toBe(false);
    const audit = await store.listSettingsAudit('it-ss-a');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      old_value: true,
      new_value: false,
      actor: 'admin@example.com',
    });
  });

  it('con un workspace inexistente devuelve undefined y no audita', async () => {
    expect(await store.setSelfSignoff('it-ss-nada', false, 'admin@example.com')).toBeUndefined();
    expect(await store.listSettingsAudit('it-ss-nada')).toHaveLength(0);
  });
});
