import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(join(__dirname, '../migrations/0011_doc_folder_path.sql'), 'utf8');

describe('migración 0011 (tribu/squad → doc_folder_path)', () => {
  it('agrega doc_folder_path como text[]', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "doc_folder_path" text\[\]/);
  });

  it('backfillea la ruta histórica antes de dropear las columnas viejas', () => {
    const backfillAt = sql.search(/UPDATE "flows"/);
    const dropAt = sql.search(/DROP COLUMN/);
    expect(backfillAt).toBeGreaterThan(-1);
    expect(dropAt).toBeGreaterThan(-1);
    // El orden importa: dropear primero perdería los datos.
    expect(backfillAt).toBeLessThan(dropAt);
  });

  it('cubre el caso de tener solo tribu, sin squad', () => {
    expect(sql).toMatch(/ARRAY\["tribu", "squad"\]/);
    expect(sql).toMatch(/ARRAY\["tribu"\]/);
  });

  it('dropea tribu y squad', () => {
    expect(sql).toMatch(/DROP COLUMN IF EXISTS "tribu"/);
    expect(sql).toMatch(/DROP COLUMN IF EXISTS "squad"/);
  });
});
