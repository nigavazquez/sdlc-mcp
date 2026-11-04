#!/usr/bin/env node
//
// examples/02-fintech/scripts/build-flow-evidence.mjs --out <evidence/NN-flow> --flow-id <id>
//
// A partir de tool-calls.jsonl y events.json (ya redactados) escribe:
//   - artifacts/   lo que efectivamente se entregó al MCP: la última versión aceptada
//                  de cada PRD/RFC/nota/ADR, y los planes, resultados de QA y reviews
//   - failures.md  una entrada por cada ok:false, con el error literal y lugar para
//                  anotar causa y corrección (las notas existentes se conservan)
//   - README.md    timeline, métricas y links del flow
//
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

/** tool → [campo del input con el markdown, nombre del archivo]. */
const DOC_INPUTS = {
  submit_prd: ['prd_markdown', 'prd.md'],
  submit_rfc: ['rfc_markdown', 'rfc.md'],
  submit_change_note: ['change_note_markdown', 'change-note.md'],
};

const NOTE_START = '<!-- notas:inicio -->';
const NOTE_END = '<!-- notas:fin -->';
const EMPTY_NOTE = '- **Causa:** _(completar)_\n- **Corrección:** _(completar)_';

export function slugify(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/** Error legible de un resultado fallido: el `error` del MCP o el texto crudo. */
export function errorOf(call) {
  const r = call.result;
  if (r && typeof r === 'object') return r.error ?? JSON.stringify(r);
  return String(r);
}

/** Notas manuales previas de failures.md, indexadas por la clave de cada entrada. */
export function parseNotes(md) {
  const notes = new Map();
  const re = /^### (\S+) .*$[\s\S]*?<!-- notas:inicio -->\n([\s\S]*?)\n<!-- notas:fin -->/gm;
  for (const m of md.matchAll(re)) notes.set(m[1], m[2]);
  return notes;
}

/**
 * La clave de una falla es estable entre regeneraciones aunque cambie el `seq`
 * (que depende del orden de las sesiones): sesión + timestamp.
 */
const failureKey = (c) => `${c.session_id.slice(0, 8)}@${c.ts}`;

export function renderFailures(calls, previous = new Map()) {
  const failed = calls.filter((c) => !c.ok);
  const lines = [
    '# Fallas y correcciones',
    '',
    'Una entrada por cada llamada al MCP que devolvió `ok:false`, generada desde',
    '`tool-calls.jsonl`. El error es literal; la causa y la corrección se anotan a',
    'mano entre los marcadores y sobreviven a `capture.sh`.',
    '',
  ];
  if (failed.length === 0) lines.push('_Ninguna llamada falló en este flow._', '');
  for (const c of failed) {
    const key = failureKey(c);
    const next = calls.find((x) => x.seq > c.seq && x.tool === c.tool && x.ok);
    lines.push(
      `### ${key} · #${c.seq} \`${c.tool}\` (${c.persona})`,
      '',
      '```',
      errorOf(c),
      '```',
      '',
      next
        ? `Reintento aceptado: #${next.seq} (${next.ts}), ${next.seq - c.seq} llamadas después.`
        : '**Sin reintento aceptado de esta tool en el flow.**',
      '',
      NOTE_START,
      previous.get(key) ?? EMPTY_NOTE,
      NOTE_END,
      '',
    );
  }
  return lines.join('\n');
}

export function extractArtifacts(calls) {
  const files = {};
  const ok = calls.filter((c) => c.ok);
  for (const [tool, [field, name]] of Object.entries(DOC_INPUTS)) {
    const last = ok.filter((c) => c.tool === tool).at(-1);
    if (last?.input?.[field]) files[name] = last.input[field];
    // Cada intento rechazado también se guarda: es la evidencia del loop.
    calls
      .filter((c) => c.tool === tool && !c.ok && c.input?.[field])
      .forEach((c, i) => (files[`attempts/${name.replace('.md', '')}.rechazado-${i + 1}.md`] = c.input[field]));
  }
  ok.filter((c) => c.tool === 'submit_adr').forEach((c, i) => {
    files[`adr/${String(i + 1).padStart(4, '0')}-${slugify(c.input.title)}.md`] = c.input.adr_markdown;
  });
  for (const c of ok.filter((x) => x.tool === 'generate_qa_plan')) {
    files[`qa/${c.input.story_id}.plan.json`] = JSON.stringify(c.result?.data ?? c.result, null, 2);
  }
  calls
    .filter((c) => c.tool === 'submit_qa_results')
    .forEach((c, i) => {
      files[`qa/${c.input.story_id}.resultados-${i + 1}${c.ok ? '' : '.rechazado'}.json`] = JSON.stringify(c.input, null, 2);
    });
  calls
    .filter((c) => c.tool === 'submit_review_outcome')
    .forEach((c, i) => {
      files[`review/${c.input.story_id}.${i + 1}-${c.input.outcome}${c.ok ? '' : '.rechazado'}.json`] = JSON.stringify(c.input, null, 2);
    });
  return files;
}

export function renderSummary(flowId, calls, state) {
  const flow = state?.flow ?? {};
  const stories = state?.stories ?? [];
  const byTool = {};
  for (const c of calls) {
    byTool[c.tool] ??= { ok: 0, fail: 0 };
    byTool[c.tool][c.ok ? 'ok' : 'fail']++;
  }
  const fails = calls.filter((c) => !c.ok).length;
  const personas = [...new Set(calls.map((c) => c.persona))];
  const prs = [...new Set(calls.map((c) => c.input?.pr_url).filter(Boolean))];

  return [
    `# Flow \`${flowId}\``,
    '',
    `- **Título:** ${flow.title ?? '?'} · **tipo:** ${flow.initiative_type ?? '?'} · **squad:** \`${flow.project ?? '?'}\``,
    `- **Estado final:** \`${flow.status ?? '?'}\` / fase \`${flow.current_phase ?? '?'}\``,
    `- **Llamadas al MCP:** ${calls.length} (${fails} rechazadas) · **personas:** ${personas.join(', ')}`,
    `- **Stories:** ${stories.length} — ${stories.map((s) => `\`${s.status}\``).join(', ') || '—'}`,
    '',
    '## Dónde mirar',
    '',
    '| Qué | Archivo |',
    '|---|---|',
    '| Conversación completa de cada sesión | `transcripts/` |',
    '| Prompt, skills y templates que entregó el MCP | `prompts/` |',
    '| Lo que se entregó (y los intentos rechazados) | `artifacts/` |',
    '| Cada rechazo, con causa y corrección | [`failures.md`](failures.md) |',
    '| Audit trail del server | `events.json` |',
    '| Todas las llamadas, en orden (fuente del replay) | `tool-calls.jsonl` |',
    '',
    '## Stories',
    '',
    '| Story | Estado | Repo / componente | Issue |',
    '|---|---|---|---|',
    ...stories.map(
      (s) => `| ${s.title} | \`${s.status}\` | ${s.component ?? s.target_repo ?? '—'} | ${s.external_url ?? s.external_id ?? '—'} |`,
    ),
    '',
    '## PRs',
    '',
    ...(prs.length ? prs.map((p) => `- ${p}`) : ['—']),
    '',
    '## Llamadas por tool',
    '',
    '| Tool | Aceptadas | Rechazadas |',
    '|---|---|---|',
    ...Object.entries(byTool).map(([t, n]) => `| \`${t}\` | ${n.ok} | ${n.fail || ''} |`),
    '',
    '## Timeline',
    '',
    '| # | Hora | Persona | Tool | Resultado |',
    '|---|---|---|---|---|',
    ...calls.map(
      (c) =>
        `| ${c.seq} | ${c.ts?.slice(11, 19) ?? ''} | ${c.persona} | \`${c.tool}\` | ${c.ok ? '✅' : `❌ ${errorOf(c).split('\n')[0].slice(0, 90).replace(/\|/g, '\\|')}`} |`,
    ),
    '',
  ].join('\n');
}

function main() {
  const { values } = parseArgs({ options: { out: { type: 'string' }, 'flow-id': { type: 'string' } } });
  const out = values.out;
  const calls = readFileSync(join(out, 'tool-calls.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const state = existsSync(join(out, 'events.json')) ? JSON.parse(readFileSync(join(out, 'events.json'), 'utf8')) : null;

  for (const [rel, content] of Object.entries(extractArtifacts(calls))) {
    const file = join(out, 'artifacts', rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
  }
  const failuresFile = join(out, 'failures.md');
  const previous = existsSync(failuresFile) ? parseNotes(readFileSync(failuresFile, 'utf8')) : new Map();
  writeFileSync(failuresFile, renderFailures(calls, previous));
  writeFileSync(join(out, 'README.md'), renderSummary(values['flow-id'], calls, state));
  console.log(`${calls.length} llamadas, ${calls.filter((c) => !c.ok).length} fallas`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
