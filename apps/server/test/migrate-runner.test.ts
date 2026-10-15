import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, type MigrationDriver } from '../src/state/migrate.js';

/** Driver de mentira: registra el orden real de aplicación, sin base de por medio. */
function fakeDriver(alreadyApplied: string[] = []) {
  const applied = [...alreadyApplied];
  const ddls: string[] = [];
  let tableEnsured = false;
  const driver: MigrationDriver = {
    async ensureTable() {
      tableEnsured = true;
    },
    async applied() {
      return new Set(applied);
    },
    async apply(id, ddl) {
      applied.push(id);
      ddls.push(ddl);
    },
  };
  return { driver, applied, ddls, ensured: () => tableEnsured };
}

async function migrationsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sdlc-migrations-'));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body, 'utf8');
  }
  return dir;
}

describe('applyMigrations', () => {
  const silent = () => undefined;
  let dir: string;

  beforeEach(async () => {
    dir = await migrationsDir({
      '0010_diez.sql': 'SELECT 10;',
      '0002_dos.sql': 'SELECT 2;',
      '0001_uno.sql': 'SELECT 1;',
      'README.md': 'no soy una migración',
    });
  });

  it('aplica en orden lexicográfico e ignora lo que no sea .sql', async () => {
    const { driver, applied, ddls, ensured } = fakeDriver();

    const result = await applyMigrations({ dir, driver, log: silent });

    expect(ensured()).toBe(true);
    expect(applied).toEqual(['0001_uno', '0002_dos', '0010_diez']);
    expect(result.applied).toEqual(['0001_uno', '0002_dos', '0010_diez']);
    expect(ddls).toEqual(['SELECT 1;', 'SELECT 2;', 'SELECT 10;']);
  });

  it('saltea lo ya aplicado y no lo vuelve a correr', async () => {
    const { driver, ddls } = fakeDriver(['0001_uno', '0002_dos']);

    const result = await applyMigrations({ dir, driver, log: silent });

    expect(result.skipped).toEqual(['0001_uno', '0002_dos']);
    expect(result.applied).toEqual(['0010_diez']);
    expect(ddls).toEqual(['SELECT 10;']);
  });

  it('es idempotente: la segunda corrida no aplica nada', async () => {
    const { driver } = fakeDriver();

    await applyMigrations({ dir, driver, log: silent });
    const second = await applyMigrations({ dir, driver, log: silent });

    expect(second.applied).toEqual([]);
    expect(second.skipped).toHaveLength(3);
  });
});
