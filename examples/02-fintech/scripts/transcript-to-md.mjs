#!/usr/bin/env node
//
// examples/02-fintech/scripts/transcript-to-md.mjs
//
// Convierte el transcript JSONL de una sesión de Claude Code en evidencia:
//   - <out>/transcripts/<persona>-<n>.md  la conversación legible
//   - <out>/tool-calls.jsonl              cada llamada al sdlc-mcp (input + resultado), en orden
//   - <out>/prompts/<role>.<phase>.md      lo que devolvió cada get_role_prompt
//
// Todo pasa por `redact` antes de escribirse: el transcript tiene el token de la
// persona en el contexto de la sesión y puede tener secretos que el agente leyó.
//
// Uso:
//   node transcript-to-md.mjs --jsonl <file> --out <evidence/NN-flow> --persona <p> --session <uuid>
//
// Los valores de las env vars SECRET_* y OAUTH_SIGNING_SECRET del proceso también
// se redactan literalmente, así que corralo con el mismo .env.local cargado.
//
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const SDLC_PREFIX = 'mcp__sdlc__';
const MAX_OTHER_RESULT = 1500; // resultados de tools que no son del MCP: recortados

const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  [/("private_key"\s*:\s*")(?:[^"\\]|\\.)*(")/g, '$1[REDACTED]$2'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[REDACTED:github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED:github-token]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:jwt]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, '$1[REDACTED]'],
];

/** Valores literales a redactar: los secretos del entorno actual (>= 8 chars). */
export function secretValuesFromEnv(env = process.env) {
  return Object.entries(env)
    .filter(([k, v]) => (k.startsWith('SECRET_') || k === 'OAUTH_SIGNING_SECRET') && v && v.length >= 8)
    .map(([, v]) => v);
}

export function redact(text, literals = []) {
  let out = String(text);
  for (const lit of literals) out = out.split(lit).join('[REDACTED:secret]');
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/** El resultado de una tool MCP llega como string o como [{type:'text', text}]. */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return JSON.stringify(content);
}

function tryJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Recorre las líneas del JSONL y arma la conversación. Puro: no toca disco.
 * Devuelve { markdown, toolCalls, prompts }.
 */
export function convert(lines, { persona, sessionId, literals = [] }) {
  const r = (s) => redact(s, literals);
  const md = [`# Sesión ${persona} · ${sessionId}`, ''];
  const pending = new Map(); // tool_use_id → { name, input, ts }
  const toolCalls = [];
  const prompts = [];
  let seq = 0;

  for (const line of lines) {
    if ((line.type !== 'user' && line.type !== 'assistant') || line.isSidechain) continue;
    const content = line.message?.content;
    const ts = line.timestamp;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : (content ?? []);

    for (const b of blocks) {
      if (b.type === 'text' && b.text?.trim()) {
        // Los recordatorios del harness no son parte de la conversación.
        const text = b.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
        if (!text) continue;
        md.push(`## ${line.type === 'user' ? '🧑 Usuario' : '🤖 Agente'} · ${ts}`, '', r(text), '');
      } else if (b.type === 'tool_use') {
        pending.set(b.id, { name: b.name, input: b.input, ts });
        const isSdlc = b.name.startsWith(SDLC_PREFIX);
        const label = isSdlc ? `🔧 sdlc · \`${b.name.slice(SDLC_PREFIX.length)}\`` : `🛠 \`${b.name}\``;
        md.push(`### ${label}`, '', '```json', r(JSON.stringify(b.input, null, 2)), '```', '');
      } else if (b.type === 'tool_result') {
        const call = pending.get(b.tool_use_id);
        const raw = resultText(b.content);
        const isSdlc = call?.name.startsWith(SDLC_PREFIX);
        const parsed = isSdlc ? tryJson(raw) : undefined;
        const failed = b.is_error === true || parsed?.ok === false;
        const shown = isSdlc || raw.length <= MAX_OTHER_RESULT ? raw : `${raw.slice(0, MAX_OTHER_RESULT)}\n… (recortado)`;
        md.push(
          `<details${failed ? ' open' : ''}><summary>${failed ? '❌ resultado (falla)' : 'resultado'}</summary>`,
          '',
          '```',
          r(shown),
          '```',
          '',
          '</details>',
          '',
        );
        if (isSdlc) {
          const tool = call.name.slice(SDLC_PREFIX.length);
          const entry = {
            seq: ++seq,
            ts: call.ts,
            persona,
            session_id: sessionId,
            tool,
            input: JSON.parse(r(JSON.stringify(call.input))),
            ok: !failed,
            result: parsed !== undefined ? JSON.parse(r(JSON.stringify(parsed))) : r(raw),
          };
          toolCalls.push(entry);
          if (tool === 'get_role_prompt' && parsed?.ok) prompts.push(entry);
        }
        pending.delete(b.tool_use_id);
      }
    }
  }
  return { markdown: md.join('\n'), toolCalls, prompts };
}

function main() {
  const { values } = parseArgs({
    options: {
      jsonl: { type: 'string' },
      out: { type: 'string' },
      persona: { type: 'string' },
      session: { type: 'string' },
    },
  });
  for (const k of ['jsonl', 'out', 'persona', 'session']) {
    if (!values[k]) {
      console.error(`falta --${k}`);
      process.exit(1);
    }
  }
  const lines = readFileSync(values.jsonl, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => tryJson(l))
    .filter(Boolean);
  const { markdown, toolCalls, prompts } = convert(lines, {
    persona: values.persona,
    sessionId: values.session,
    literals: secretValuesFromEnv(),
  });

  const out = values.out;
  for (const d of ['transcripts', 'prompts']) mkdirSync(join(out, d), { recursive: true });
  writeFileSync(join(out, 'transcripts', `${values.persona}-${values.session.slice(0, 8)}.md`), markdown);
  // tool-calls.jsonl acumula todas las sesiones del flow; capture.sh lo regenera de cero.
  for (const c of toolCalls) appendFileSync(join(out, 'tool-calls.jsonl'), `${JSON.stringify(c)}\n`);
  for (const p of prompts) {
    const { role, phase, version, system_prompt, skills = [], templates = [] } = p.result.data ?? {};
    const file = join(out, 'prompts', `${role}.${phase}.md`);
    if (existsSync(file)) continue; // el mismo (rol, fase) pedido dos veces: alcanza con uno
    const parts = [
      `# Prompt entregado · ${role} / ${phase}`,
      '',
      `- versión: \`${version}\` · pedido por ${p.persona} · ${p.ts}`,
      '',
      '## System prompt',
      '',
      system_prompt ?? '',
      ...skills.map((s) => `\n## Skill \`${s.id}\` (${s.version})\n\n${s.markdown ?? ''}`),
      ...templates.map((t) => `\n## Template \`${t.id}\`\n\n${t.content ?? ''}`),
    ];
    writeFileSync(file, parts.join('\n'));
  }
  console.log(`${values.persona}: ${toolCalls.length} tool calls del MCP, ${prompts.length} prompts`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
