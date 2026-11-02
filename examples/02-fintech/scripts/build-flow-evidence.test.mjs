// node --test examples/02-fintech/scripts/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractArtifacts, parseNotes, renderFailures, renderSummary, slugify } from './build-flow-evidence.mjs';

const call = (seq, tool, ok, input = {}, result = ok ? { ok: true } : { ok: false, error: `err ${seq}` }) => ({
  seq,
  ts: `2026-11-02T10:00:${String(seq).padStart(2, '0')}Z`,
  persona: 'nicolas',
  session_id: 'aaaaaaaa-1111',
  tool,
  input,
  ok,
  result,
});

const calls = [
  call(1, 'submit_prd', false, { prd_markdown: '# v1' }),
  call(2, 'submit_prd', true, { prd_markdown: '# v2' }),
  call(3, 'submit_adr', true, { title: 'Ledger de doble entrada', adr_markdown: '# ADR' }),
  call(4, 'submit_qa_results', false, { story_id: 's1', verdict: 'passed' }),
];

test('artefactos: la versión aceptada, más cada intento rechazado', () => {
  const files = extractArtifacts(calls);
  assert.equal(files['prd.md'], '# v2');
  assert.equal(files['attempts/prd.rechazado-1.md'], '# v1');
  assert.equal(files['adr/0001-ledger-de-doble-entrada.md'], '# ADR');
  assert.ok(files['qa/s1.resultados-1.rechazado.json']);
});

test('failures: una entrada por falla, con el reintento aceptado', () => {
  const md = renderFailures(calls);
  assert.match(md, /#1 `submit_prd`/);
  assert.match(md, /Reintento aceptado: #2/);
  assert.match(md, /#4 `submit_qa_results`[\s\S]*Sin reintento aceptado/);
});

test('failures: conserva las notas manuales al regenerar, aunque cambie el seq', () => {
  const first = renderFailures(calls).replace(
    '- **Causa:** _(completar)_\n- **Corrección:** _(completar)_',
    '- **Causa:** faltaba Goals\n- **Corrección:** se agregó',
  );
  const renumbered = calls.map((c) => ({ ...c, seq: c.seq + 10 }));
  const again = renderFailures(renumbered, parseNotes(first));
  assert.match(again, /faltaba Goals/);
  assert.equal((again.match(/_\(completar\)_/g) ?? []).length, 2); // la de QA sigue sin anotar
});

test('summary: escapa los pipes del error en la tabla', () => {
  const md = renderSummary('f', [call(1, 'x', false, {}, { ok: false, error: 'a | b' })], null);
  assert.match(md, /a \\\| b/);
});

test('slugify', () => {
  assert.equal(slugify('Límites diarios: ¿cuántos?'), 'limites-diarios-cuantos');
});
