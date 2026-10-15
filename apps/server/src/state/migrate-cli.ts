#!/usr/bin/env node
/**
 * Entry point del runner de migraciones.
 *
 *   dev   → pnpm --filter @sdlc/server db:migrate     (tsx src/state/migrate-cli.ts)
 *   prod  → node apps/server/dist/state/migrate-cli.js  (dentro de la imagen)
 *
 * La ruta a `migrations/` es la misma relativa desde `src/state/` y desde
 * `dist/state/`, así que los dos modos encuentran los mismos archivos sin condicionales.
 * `SDLC_MIGRATIONS_DIR` la pisa si hiciera falta.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { isSecretRef } from '../config/secret-env.js';
import { createSecretResolver } from '../secrets/index.js';
import { applyMigrations, createPostgresDriver } from './migrate.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = process.env.SDLC_MIGRATIONS_DIR ?? resolve(here, '../../migrations');

const rawDatabaseUrl = process.env.DATABASE_URL;
if (!rawDatabaseUrl) {
  console.error('DATABASE_URL is required to run migrations.');
  process.exit(1);
}

// Mismo trato que en el server: en prod `DATABASE_URL` es una referencia
// `aws-sm://…` y la resuelve el instance role. Si no lo aceptara acá, el paso de
// migración obligaría a materializar la password en el entorno del deploy.
const databaseUrl = isSecretRef(rawDatabaseUrl)
  ? await createSecretResolver(process.env.SECRETS_BACKEND === 'aws' ? 'aws' : 'env').resolve(
      rawDatabaseUrl,
    )
  : rawDatabaseUrl;

const sql = postgres(databaseUrl, { max: 1 });

try {
  await applyMigrations({ dir: migrationsDir, driver: createPostgresDriver(sql) });
} catch (err) {
  console.error('migration failed:', err);
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 });
}
