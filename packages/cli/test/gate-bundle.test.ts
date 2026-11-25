import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGate } from '../scripts/build.mjs';
import { hookCommand } from '../src/hooks.js';

// Seam: el archivo que `init` copia a `.claude/hooks/sdlc-gate.mjs` y el comando con
// el que Claude Code lo invoca. Se prueba el bundle, no los módulos sueltos.
let outDir: string;
let gate: string;

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'sdlc-gate-'));
  gate = join(outDir, 'gate.mjs');
  await buildGate(gate);
});

function runGate(mode: string, stdin: string) {
  return spawnSync(process.execPath, [gate, mode], { input: stdin, encoding: 'utf8' });
}

function runHook(mode: 'pre' | 'post', projectDir: string, stdin: string) {
  return spawnSync('sh', ['-c', hookCommand(mode)], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
}

describe('bundle del gate', () => {
  it('es un único archivo sin imports fuera de los módulos de node', () => {
    expect(readdirSync(outDir)).toEqual(['gate.mjs']);
    const code = readFileSync(gate, 'utf8');
    const specifiers = [...code.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
      (m) => m[1],
    );
    expect(specifiers.length).toBeGreaterThan(0);
    for (const s of specifiers) expect(s).toMatch(/^node:/);
  });

  it('arranca con node y, en un repo con config, decide: excluido pasa y la branch default no', () => {
    const repo = mkdtempSync(join(tmpdir(), 'sdlc-gate-repo-'));
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    mkdirSync(join(repo, '.claude', 'sdlc'), { recursive: true });
    writeFileSync(
      join(repo, '.claude', 'sdlc', 'config.json'),
      JSON.stringify({
        version: 1,
        server_url: 'http://localhost:3100',
        workspace: 'demo',
        default_branch: 'main',
        exclude: [],
      }),
    );
    const run = (file_path: string) =>
      spawnSync(process.execPath, [gate, 'pre'], {
        input: JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Edit',
          tool_input: { file_path },
          cwd: repo,
        }),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
      });

    const excluded = run(join(repo, 'CLAUDE.md'));
    expect(excluded.status).toBe(0);
    expect(excluded.stdout).toBe('');

    const onMain = run(join(repo, 'src', 'x.ts'));
    expect(onMain.status).toBe(0);
    expect(JSON.parse(onMain.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(
      /branch default/,
    );
  });

  it('sin config.json deniega', () => {
    const r = spawnSync(process.execPath, [gate, 'pre'], {
      input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: '/x' } }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: outDir },
    });
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('ante un error interno deniega por stdout con exit 0', () => {
    const r = runGate('pre', 'no es json');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
    });
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/^Gate SDLC: /);
  });

  it('con un modo desconocido deniega', () => {
    const r = runGate('otro', '{}');
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('comando del hook', () => {
  it('sale con 2 (bloqueo en Claude Code) si el gate no se puede cargar', () => {
    const r = runHook('pre', join(outDir, 'no-existe'), '{}');
    expect(r.status).toBe(2);
  });

  it('sale con 2 si falta node en el PATH', () => {
    const r = spawnSync('/bin/sh', ['-c', hookCommand('pre')], {
      input: '{}',
      encoding: 'utf8',
      env: { PATH: '/nonexistent', CLAUDE_PROJECT_DIR: outDir },
    });
    expect(r.status).toBe(2);
  });

  it('apunta a .claude/hooks/sdlc-gate.mjs bajo CLAUDE_PROJECT_DIR', () => {
    expect(hookCommand('post')).toBe(
      'node "$CLAUDE_PROJECT_DIR/.claude/hooks/sdlc-gate.mjs" post || exit 2',
    );
  });
});
