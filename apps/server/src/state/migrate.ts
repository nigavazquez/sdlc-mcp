/**
 * Runner de migraciones: aplica los .sql de `migrations/` en orden lexicográfico,
 * una sola vez cada uno, anotándolos en `_sdlc_migrations`.
 *
 * Vivía en `scripts/migrate.ts` y se corría con tsx. Eso alcanzaba mientras las
 * migraciones se aplicaban desde un checkout del repo, pero en el deploy a prod la
 * única cosa que existe en la EC2 es la imagen, y la imagen no lleva tsx (es una
 * devDependency que la poda de `--prod` saca). Al estar acá se compila junto con el
 * server y el paso de migración del deploy es `node apps/server/dist/state/migrate-cli.js`
 * sobre la **misma imagen** que va a correr — que es justamente la garantía que se
 * quiere: no se puede migrar con un build y arrancar con otro.
 *
 * El driver está detrás de una interfaz para poder testear el orden y el salteo de
 * lo ya aplicado sin una base de por medio; `createPostgresDriver` es el único
 * implementador de producción.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sql } from 'postgres';

/** Lo que el runner necesita de la base. Un test lo implementa con un array. */
export interface MigrationDriver {
  /** Crea `_sdlc_migrations` si no existe. */
  ensureTable(): Promise<void>;
  /** Ids ya aplicados. */
  applied(): Promise<Set<string>>;
  /** Aplica el DDL y anota el id. */
  apply(id: string, ddl: string): Promise<void>;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export interface ApplyMigrationsOptions {
  /** Directorio con los archivos `NNNN_nombre.sql`. */
  dir: string;
  driver: MigrationDriver;
  /** Salida de progreso. Default: stdout. */
  log?: (line: string) => void;
}

/**
 * Aplica las migraciones pendientes. Idempotente: correrlo dos veces seguidas
 * deja `applied` vacío la segunda vez.
 */
export async function applyMigrations(opts: ApplyMigrationsOptions): Promise<MigrationResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  await opts.driver.ensureTable();
  const already = await opts.driver.applied();

  const entries = await readdir(opts.dir);
  const files = entries.filter((f) => f.endsWith('.sql')).sort();

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const id = file.replace(/\.sql$/, '');
    if (already.has(id)) {
      log(`✓ ${id} (already applied)`);
      skipped.push(id);
      continue;
    }
    const ddl = await readFile(join(opts.dir, file), 'utf8');
    log(`→ applying ${id}`);
    await opts.driver.apply(id, ddl);
    applied.push(id);
  }

  log(`done — applied ${applied.length} new migration(s); ${skipped.length + applied.length} total.`);
  return { applied, skipped };
}

/** Driver real contra Postgres. `sql` debería venir con `max: 1`. */
export function createPostgresDriver(sql: Sql): MigrationDriver {
  return {
    async ensureTable() {
      await sql`
        CREATE TABLE IF NOT EXISTS _sdlc_migrations (
          id text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        );
      `;
    },
    async applied() {
      const rows = await sql<{ id: string }[]>`SELECT id FROM _sdlc_migrations`;
      return new Set(rows.map((r) => r.id));
    },
    async apply(id, ddl) {
      await sql.unsafe(ddl);
      await sql`INSERT INTO _sdlc_migrations (id) VALUES (${id})`;
    },
  };
}
