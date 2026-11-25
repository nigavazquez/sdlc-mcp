import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeServerCredential } from '../src/credentials.js';
import { parseTtl, runBypass, type BypassDeps } from '../src/bypass/bypass.js';
import { decidePre } from '../src/gate/decide.js';
import { leasePath } from '../src/gate/session-files.js';
import { runInit } from '../src/init/init.js';
import { runUninstall } from '../src/uninstall/uninstall.js';

// Historia #15 (épica #5). Seams: `runBypass` contra un server HTTP falso, `decidePre`
// para el bloqueo desde Bash, y `runUninstall` sobre un repo instalado con `runInit`.

let srv: Server;
let serverUrl: string;
const bypassCalls: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  srv = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (req.url === '/gate/v1/bypass') {
        const body = JSON.parse(data);
        bypassCalls.push(body);
        return res.end(
          JSON.stringify({
            ok: true,
            data: { lease_id: 'gl_bypass', expires_at: '2026-11-25T13:00:00.000Z' },
          }),
        );
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  serverUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => srv.close());

let repo: string;
let xdg: string;
const git = (...a: string[]) =>
  execFileSync('git', a, { cwd: repo, stdio: 'pipe', encoding: 'utf8' });

beforeEach(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-byp-')));
  repo = join(base, 'repo');
  xdg = join(base, 'xdg');
  mkdirSync(join(repo, '.claude'), { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.org');
  git('config', 'user.name', 'T');
  writeFileSync(
    join(repo, '.claude', 'settings.json'),
    JSON.stringify({
      model: 'opus',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo fin' }] }] },
      permissions: { deny: ['Read(.env)'] },
    }),
  );
  writeFileSync(join(repo, 'CLAUDE.md'), '# Proyecto\n\nReglas propias.\n');
  writeFileSync(
    join(repo, '.mcp.json'),
    JSON.stringify({ mcpServers: { otro: { type: 'stdio', command: 'x' } } }),
  );
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  writeServerCredential(
    serverUrl,
    {
      client_id: 'c',
      token_endpoint: `${serverUrl}/oauth/token`,
      access_token: 'at',
      refresh_token: 'rt',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    },
    { XDG_CONFIG_HOME: xdg },
  );
  await runInit({
    cwd: repo,
    prompter: { ask: async () => '', confirm: async () => true },
    log: () => {},
    gateSource: '// gate\n',
    login: async () => {},
    listWorkspaces: async () => ['demo'],
    flags: { server: serverUrl, workspace: 'demo', exclude: [], yes: true },
    env: { XDG_CONFIG_HOME: xdg },
  });
  bypassCalls.length = 0;
});

function bypassDeps(extra: Partial<BypassDeps> = {}): BypassDeps {
  return {
    cwd: repo,
    reason: 'prod caído, fix urgente',
    ttl: '30m',
    isTTY: true,
    askConfirmation: async (expected) => expected,
    log: () => {},
    env: { XDG_CONFIG_HOME: xdg },
    ...extra,
  };
}

describe('sdlc bypass', () => {
  it('con TTY y confirmación tipeada escribe el lease bypass en la raíz de la sesión', async () => {
    git('switch', '-q', '-c', 'hotfix/x');
    const out = await runBypass(bypassDeps());
    expect(out.root).toBe(repo);
    expect(JSON.parse(readFileSync(leasePath(repo), 'utf8'))).toEqual({
      lease_id: 'gl_bypass',
      kind: 'bypass',
      expires_at: '2026-11-25T13:00:00.000Z',
    });
    expect(bypassCalls[0]).toMatchObject({
      workspace: 'demo',
      branch: 'hotfix/x',
      reason: 'prod caído, fix urgente',
      ttl_minutes: 30,
    });
  });

  it('en un worktree escribe el lease en el worktree', async () => {
    const wt = join(repo, '.claude', 'worktrees', 'hf');
    git('worktree', 'add', '-q', '-b', 'hotfix/wt', wt);
    const out = await runBypass(bypassDeps({ cwd: wt }));
    expect(out.root).toBe(wt);
    expect(existsSync(leasePath(wt))).toBe(true);
  });

  it('sin TTY falla sin llamar al server', async () => {
    git('switch', '-q', '-c', 'hotfix/x');
    await expect(runBypass(bypassDeps({ isTTY: false }))).rejects.toThrow(/terminal interactiva/);
    expect(bypassCalls).toHaveLength(0);
  });

  it('una confirmación distinta del nombre de la branch cancela', async () => {
    git('switch', '-q', '-c', 'hotfix/x');
    await expect(runBypass(bypassDeps({ askConfirmation: async () => 'si' }))).rejects.toThrow(
      /confirmación incorrecta/,
    );
    expect(bypassCalls).toHaveLength(0);
    expect(existsSync(leasePath(repo))).toBe(false);
  });

  it('sobre la branch default no se hace bypass', async () => {
    await expect(runBypass(bypassDeps())).rejects.toThrow(/main/);
  });

  it('motivo corto o TTL fuera de rango se rechazan antes de pedir nada', async () => {
    git('switch', '-q', '-c', 'hotfix/x');
    await expect(runBypass(bypassDeps({ reason: 'urgente' }))).rejects.toThrow(/10 caracteres/);
    await expect(runBypass(bypassDeps({ ttl: '3h' }))).rejects.toThrow(/120/);
    expect(bypassCalls).toHaveLength(0);
  });

  it('parseTtl entiende minutos y horas', () => {
    expect(parseTtl('30m')).toBe(30);
    expect(parseTtl('2h')).toBe(120);
    expect(parseTtl('45')).toBe(45);
    expect(() => parseTtl('mañana')).toThrow(/inválido/);
  });

  it('el gate deniega invocar sdlc bypass desde Bash', () => {
    const config = JSON.parse(readFileSync(join(repo, '.claude/sdlc/config.json'), 'utf8'));
    for (const command of [
      'sdlc bypass --reason "lo necesito ya"',
      'npx sdlc bypass --ttl 30m',
      'node packages/cli/dist/cli.mjs bypass',
    ]) {
      expect(
        decidePre({ tool_name: 'Bash', tool_input: { command }, cwd: repo }, repo, config),
      ).toMatchObject({
        decision: 'deny',
        reason: expect.stringMatching(/bypass/),
      });
    }
    expect(
      decidePre(
        { tool_name: 'Bash', tool_input: { command: 'sdlc doctor' }, cwd: repo },
        repo,
        config,
      ),
    ).toEqual({ decision: 'allow' });
  });
});

describe('sdlc uninstall', () => {
  it('quita hooks, deny rules, gate, .claude/sdlc y el bloque de CLAUDE.md, sin tocar lo demás', async () => {
    const mcpBefore = readFileSync(join(repo, '.mcp.json'), 'utf8');
    const out = await runUninstall({ cwd: repo, confirm: async () => true, log: () => {} });
    expect(out.applied).toBe(true);

    expect(JSON.parse(readFileSync(join(repo, '.claude/settings.json'), 'utf8'))).toEqual({
      model: 'opus',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo fin' }] }] },
      permissions: { deny: ['Read(.env)'] },
    });
    expect(readFileSync(join(repo, 'CLAUDE.md'), 'utf8')).toBe('# Proyecto\n\nReglas propias.\n');
    expect(existsSync(join(repo, '.claude/hooks/sdlc-gate.mjs'))).toBe(false);
    expect(existsSync(join(repo, '.claude/sdlc'))).toBe(false);
    expect(readFileSync(join(repo, '.mcp.json'), 'utf8')).toBe(mcpBefore);
  });

  it('sin confirmar no toca nada; una segunda corrida no encuentra nada', async () => {
    expect(
      (await runUninstall({ cwd: repo, confirm: async () => false, log: () => {} })).applied,
    ).toBe(false);
    expect(existsSync(join(repo, '.claude/sdlc/config.json'))).toBe(true);

    await runUninstall({ cwd: repo, confirm: async () => true, log: () => {} });
    const lines: string[] = [];
    const again = await runUninstall({
      cwd: repo,
      confirm: async () => true,
      log: (l) => lines.push(l),
    });
    expect(again.plan).toEqual({ rewrite: [], remove: [] });
    expect(lines.join('\n')).toMatch(/No hay nada de sdlc/);
  });
});
