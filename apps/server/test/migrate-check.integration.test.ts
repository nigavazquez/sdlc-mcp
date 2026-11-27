import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `migrate-cli --check` de punta a punta contra Postgres (historia C1, #76): el
 * proceso real, sus códigos de salida y que no escribe nada. Usa una base propia
 * para no chocar con otras suites de integración que migran en paralelo.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const SERVER_DIR = resolve(__dirname, '..');
const MIGRATIONS_DIR = join(SERVER_DIR, 'migrations');
const DB = 'sdlc_migrate_check_test';

function runCli(args: string[], env: Record<string, string>) {
  return spawnSync('npx', ['tsx', 'src/state/migrate-cli.ts', ...args], {
    cwd: SERVER_DIR,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

describeIfDb('migrate-cli --check (integración)', () => {
  let admin: ReturnType<typeof postgres>;
  let url: string;
  let dirConUnaMas: string;

  beforeAll(async () => {
    admin = postgres(TEST_DATABASE_URL!, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.unsafe(`CREATE DATABASE ${DB}`);
    const u = new URL(TEST_DATABASE_URL!);
    u.pathname = `/${DB}`;
    url = u.toString();

    // Las migraciones reales más una de más, para tener una pendiente después de migrar.
    dirConUnaMas = await mkdtemp(join(tmpdir(), 'sdlc-migrate-check-'));
    for (const f of await readdir(MIGRATIONS_DIR)) {
      if (f.endsWith('.sql')) await copyFile(join(MIGRATIONS_DIR, f), join(dirConUnaMas, f));
    }
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dirConUnaMas, '9999_extra.sql'), 'CREATE TABLE IF NOT EXISTS migrate_check_extra (id int);');
  }, 60_000);

  afterAll(async () => {
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end({ timeout: 5 });
    }
  });

  it('con la base vacía sale 3, lista las pendientes y no crea _sdlc_migrations', async () => {
    const r = runCli(['--check'], { DATABASE_URL: url });
    expect(r.status, r.stderr).toBe(3);
    expect(r.stdout).toMatch(/pendiente/);
    expect(r.stdout).toContain('0000_init');

    const db = postgres(url, { max: 1 });
    const [row] = await db`SELECT to_regclass('_sdlc_migrations')::text AS t`;
    await db.end({ timeout: 5 });
    expect(row?.t).toBeNull();
  }, 60_000);

  it('después de migrar sale 0', async () => {
    const migrate = runCli([], { DATABASE_URL: url });
    expect(migrate.status, migrate.stderr).toBe(0);

    const r = runCli(['--check'], { DATABASE_URL: url });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/al día/);
  }, 60_000);

  it('con una migración nueva en la imagen sale 3 y no la aplica', async () => {
    const r = runCli(['--check'], { DATABASE_URL: url, SDLC_MIGRATIONS_DIR: dirConUnaMas });
    expect(r.status, r.stderr).toBe(3);
    expect(r.stdout).toContain('9999_extra');

    const db = postgres(url, { max: 1 });
    const [row] = await db`SELECT to_regclass('migrate_check_extra')::text AS t`;
    await db.end({ timeout: 5 });
    expect(row?.t).toBeNull();
  }, 60_000);
});
