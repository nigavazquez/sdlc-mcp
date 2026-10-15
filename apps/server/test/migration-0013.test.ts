import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { REVIEW_ENVELOPE_SCHEMA } from '@sdlc/core';

const sql = readFileSync(join(__dirname, '../migrations/0013_review_envelope.sql'), 'utf8');

describe('migración 0013 (review_envelope)', () => {
  it('agrega review_envelope como jsonb', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "review_envelope" jsonb/);
  });

  it('no toca ninguna columna existente', () => {
    expect(sql).not.toMatch(/DROP COLUMN/);
  });
});

describe('review_envelope sobrevive el round-trip del store', () => {
  it('se guarda y se lee con los dos ejes', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({
      tenant_id: 't1', project: 'p1', slug: 's', title: 'T', initiative_type: 'fix',
    });
    const story = await store.createStory({
      flow_id: flow.flow_id,
      external_id: 'AB-1',
      external_url: 'https://example.com/1',
      title: 'Una story',
      acceptance_criteria: ['anda'],
    });

    const envelope = {
      schema: REVIEW_ENVELOPE_SCHEMA,
      standards: { verdict: 'advisory' as const, findings: [{ file: 'a.ts', why: 'nombre' }] },
      spec: { verdict: 'ok' as const, findings: [] },
      submitted_at: '2026-09-03T00:00:00.000Z',
    };
    await store.updateStory(story.story_id, { review_envelope: envelope });

    expect((await store.getStory(story.story_id))?.review_envelope).toEqual(envelope);
  });
});
