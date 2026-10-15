import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(join(__dirname, '../migrations/0009_workspaces.sql'), 'utf8');

describe('migración 0009 (squads → workspaces)', () => {
  it('renombra tablas y columnas preservando datos (usa RENAME, no DROP)', () => {
    expect(sql).toMatch(/ALTER TABLE "squads" RENAME TO "workspaces"/);
    expect(sql).toMatch(/ALTER TABLE "squad_members" RENAME TO "workspace_members"/);
    expect(sql).toMatch(/RENAME COLUMN "squad_id" TO "workspace_id"/);
    expect(sql).toMatch(/ALTER TABLE "oauth_codes" RENAME COLUMN "squads" TO "workspaces"/);
    expect(sql).toMatch(/ALTER TABLE "oauth_refresh_tokens" RENAME COLUMN "squads" TO "workspaces"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "groups"/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "group_id"/);
    expect(sql).not.toMatch(/\bDROP TABLE\b/);
  });
});
