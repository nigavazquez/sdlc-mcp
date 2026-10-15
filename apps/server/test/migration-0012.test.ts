import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryFlowStore } from '../src/state/in-memory.js';

const sql = readFileSync(join(__dirname, '../migrations/0012_change_note_ref.sql'), 'utf8');

describe('migración 0012 (change_note_ref)', () => {
  it('agrega change_note_ref como jsonb', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "change_note_ref" jsonb/);
  });

  it('no toca ninguna columna existente', () => {
    // La nota de cambio es un artefacto nuevo, no un reemplazo: un flow del track
    // completo sigue teniendo su prd_ref y su rfc_ref intactos.
    expect(sql).not.toMatch(/DROP COLUMN/);
    expect(sql).not.toMatch(/UPDATE "flows"/);
  });
});

describe('change_note_ref sobrevive el round-trip del store', () => {
  it('se guarda y se lee con la misma forma que prd_ref', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({
      tenant_id: 't1',
      project: 'platform',
      slug: 'claim-refresh',
      title: 'El claim de workspaces no llega en el refresh',
      initiative_type: 'fix',
    });

    const ref = {
      repo_path: 'docs/change-notes/claim-refresh.md',
      sha256: 'a'.repeat(64),
    };
    const updated = await store.updateFlow(flow.flow_id, { change_note_ref: ref });

    expect(updated.change_note_ref).toEqual(ref);
    expect((await store.getFlow(flow.flow_id))?.change_note_ref).toEqual(ref);
  });
});
