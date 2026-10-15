#!/usr/bin/env tsx
/**
 * Upserts tenant_integrations rows from a JSON config file.
 * Usage: DATABASE_URL=... tsx scripts/seed-integrations.ts <path-to-config.json>
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { parseIntegrationsConfig, seedIntegrations } from '../src/integrations/seed.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required to seed integrations.');
  process.exit(1);
}

const fileArg = process.argv[2];
if (!fileArg) {
  console.error('Usage: pnpm --filter @sdlc/server seed:integrations <path-to-config.json>');
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });

async function run() {
  // Resolve against the dir the user invoked the command from. pnpm/npm set
  // INIT_CWD to that dir; `pnpm --filter @sdlc/server …` otherwise runs with
  // cwd=apps/server, which would break a repo-root-relative path.
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const raw = await readFile(resolve(baseDir, fileArg!), 'utf8');
  const config = parseIntegrationsConfig(JSON.parse(raw));
  const db = drizzle(sql);
  const { created, updated } = await seedIntegrations(db, config);
  for (const c of created) console.log(`+ created ${c}`);
  for (const u of updated) console.log(`~ updated ${u}`);
  console.log(`done — ${created.length} created, ${updated.length} updated.`);
}

try {
  await run();
} catch (err) {
  console.error('seed failed:', err);
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 });
}
