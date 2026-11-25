import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGate } from '../scripts/build.mjs';
import type { GateConfig } from '../src/gate/config.js';
import { resolveLease, type LeaseOutcome } from '../src/gate/lease.js';
import { handlePost } from '../src/gate/post.js';
import { normalizeRemote } from '../src/gate/remote.js';
import {
  ServerUnavailableError,
  httpGateServer,
  type CheckResponse,
  type GateEvent,
  type GateServer,
} from '../src/gate/server.js';
import { cachePath, leasePath, writeLease } from '../src/gate/session-files.js';
import { writeServerCredential } from '../src/credentials.js';

// Historia #11 (épica #5). Seams: `handlePost` (PostToolUse de claim_story),
// `resolveLease` (pasos 7-9) con un server falso, el cliente HTTP con timeout, y el
// bundle del gate de punta a punta contra un server HTTP falso.

let repo: string;
let wt: string;
const config: GateConfig = {
  version: 1,
  server_url: 'http://127.0.0.1:1',
  workspace: 'demo',
  default_branch: 'main',
  exclude: [],
};
const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' });

beforeAll(() => {
  repo = join(realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-lease-'))), 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.org');
  git(repo, 'config', 'user.name', 'T');
  writeFileSync(join(repo, 'a.txt'), 'x');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  wt = join(repo, '.claude', 'worktrees', 'feat-a');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/a', wt);
});

const claimResponse = (body: unknown) => [{ type: 'text', text: JSON.stringify(body) }];

describe('PostToolUse de claim_story', () => {
  beforeEach(() => {
    rmSync(leasePath(wt), { force: true });
    rmSync(cachePath(wt), { force: true });
  });

  it('con ok:true y gate_lease escribe lease.json en la raíz de la sesión (el worktree)', () => {
    const root = handlePost(
      {
        tool_name: 'mcp__sdlc__claim_story',
        tool_input: { story_id: 's-1' },
        tool_response: claimResponse({
          ok: true,
          data: { gate_lease: { lease_id: 'gl_x', expires_at: '2026-12-01T00:00:00Z' } },
        }),
        cwd: join(wt, 'src'),
      },
      repo,
    );
    expect(root).toBe(wt);
    expect(JSON.parse(readFileSync(leasePath(wt), 'utf8'))).toEqual({
      lease_id: 'gl_x',
      kind: 'story',
      story_id: 's-1',
      expires_at: '2026-12-01T00:00:00Z',
    });
    expect(existsSync(leasePath(repo))).toBe(false);
  });

  it.each([
    ['ok:false', { ok: false, error: 'Unknown story' }],
    ['ok:true sin gate_lease', { ok: true, data: { story: {} } }],
  ])('con %s no escribe nada', (_n, body) => {
    expect(
      handlePost(
        { tool_name: 'mcp__sdlc__claim_story', tool_response: claimResponse(body), cwd: wt },
        repo,
      ),
    ).toBeUndefined();
    expect(existsSync(leasePath(wt))).toBe(false);
  });

  it('otra tool no escribe nada', () => {
    const body = { ok: true, data: { gate_lease: { lease_id: 'gl_x', expires_at: 'x' } } };
    expect(
      handlePost(
        { tool_name: 'mcp__sdlc__whoami', tool_response: claimResponse(body), cwd: wt },
        repo,
      ),
    ).toBeUndefined();
  });
});

/** Server falso: un lease válido sólo en la branch donde se usó primero. */
function fakeServer(validIds: string[]) {
  const bound = new Map<string, string>();
  const calls = { check: 0 };
  const events: GateEvent[] = [];
  let down = false;
  const server: GateServer = {
    async check(req) {
      if (down) throw new ServerUnavailableError('caído');
      calls.check++;
      if (!validIds.includes(req.lease_id))
        return { valid: false, reason: 'unknown', next_step: 'reclamá' };
      const b = bound.get(req.lease_id);
      if (b && b !== req.branch)
        return { valid: false, reason: 'branch_mismatch', next_step: 'otra branch' };
      bound.set(req.lease_id, req.branch);
      return { valid: true, kind: 'story', valid_until: '2026-12-31T00:00:00Z' } as CheckResponse;
    },
    async events(req) {
      if (down) throw new ServerUnavailableError('caído');
      events.push(...req.events);
    },
  };
  return { server, calls, events, setDown: (v: boolean) => (down = v) };
}

describe('resolveLease', () => {
  let now: Date;
  const deps = (server: GateServer) => ({
    server,
    config,
    repo: 'github.com/acme/app',
    now: () => now,
  });
  const edit = {
    decision: 'needs_lease' as const,
    action: 'edit' as const,
    root: '',
    branch: 'feat/a',
    path: 'src/x.ts',
  };
  const commit = {
    decision: 'needs_lease' as const,
    action: 'commit' as const,
    root: '',
    branch: 'feat/a',
  };

  beforeEach(() => {
    now = new Date('2026-11-25T12:00:00Z');
    edit.root = commit.root = wt;
    rmSync(leasePath(wt), { force: true });
    rmSync(cachePath(wt), { force: true });
  });

  it('un edit valida online una vez y después usa la caché de 60 s', async () => {
    const f = fakeServer(['gl_ok']);
    writeLease(wt, { lease_id: 'gl_ok', kind: 'story', expires_at: 'x' });

    expect(await resolveLease(edit, deps(f.server))).toEqual({ allow: true });
    now = new Date(now.getTime() + 59_000);
    expect(await resolveLease(edit, deps(f.server))).toEqual({ allow: true });
    expect(f.calls.check).toBe(1);

    now = new Date(now.getTime() + 2_000);
    await resolveLease(edit, deps(f.server));
    expect(f.calls.check).toBe(2);
  });

  it('un commit valida online siempre, aunque haya caché, y registra commit.allowed', async () => {
    const f = fakeServer(['gl_ok']);
    writeLease(wt, { lease_id: 'gl_ok', kind: 'story', expires_at: 'x' });
    await resolveLease(edit, deps(f.server));

    expect(await resolveLease(commit, deps(f.server))).toEqual({ allow: true });
    expect(await resolveLease(commit, deps(f.server))).toEqual({ allow: true });
    expect(f.calls.check).toBe(3);
    expect(f.events.map((e) => e.kind)).toEqual(['commit.allowed', 'commit.allowed']);
  });

  it('un lease.json inventado: deny, commit.blocked registrado y el archivo se borra', async () => {
    const f = fakeServer(['gl_ok']);
    writeLease(wt, { lease_id: 'gl_inventado', kind: 'story', expires_at: 'x' });

    const out = (await resolveLease(commit, deps(f.server))) as Extract<
      LeaseOutcome,
      { allow: false }
    >;
    expect(out.allow).toBe(false);
    expect(out.reason).toMatch(/unknown/);
    expect(f.events).toEqual([
      expect.objectContaining({ kind: 'commit.blocked', reason: 'unknown' }),
    ]);
    expect(existsSync(leasePath(wt))).toBe(false);
  });

  it('un lease copiado a otra branch: deny por branch_mismatch y bloqueo registrado', async () => {
    const f = fakeServer(['gl_ok']);
    writeLease(wt, { lease_id: 'gl_ok', kind: 'story', expires_at: 'x' });
    await resolveLease(commit, deps(f.server));

    const out = await resolveLease({ ...commit, branch: 'feat/otra' }, deps(f.server));
    expect(out).toMatchObject({ allow: false, reason: expect.stringMatching(/branch_mismatch/) });
    expect(f.events.at(-1)).toMatchObject({
      kind: 'commit.blocked',
      reason: 'branch_mismatch',
      branch: 'feat/otra',
    });
  });

  it('sin lease.json: deny pidiendo claim_story, y el commit bloqueado se registra', async () => {
    const f = fakeServer([]);
    expect(await resolveLease(commit, deps(f.server))).toMatchObject({
      allow: false,
      next: expect.stringMatching(/claim_story/),
    });
    expect(f.events[0]).toMatchObject({ kind: 'commit.blocked', reason: 'no_lease' });
  });

  it('si el commit pasa pero no se puede registrar, se deniega', async () => {
    const f = fakeServer(['gl_ok']);
    writeLease(wt, { lease_id: 'gl_ok', kind: 'story', expires_at: 'x' });
    const flaky: GateServer = {
      check: f.server.check,
      events: async () => {
        throw new ServerUnavailableError('el server respondió 500');
      },
    };
    expect(await resolveLease(commit, deps(flaky))).toMatchObject({
      allow: false,
      reason: expect.stringMatching(/registrar/),
    });
  });

  it('server caído: deny sugiriendo sdlc bypass', async () => {
    const f = fakeServer(['gl_ok']);
    writeLease(wt, { lease_id: 'gl_ok', kind: 'story', expires_at: 'x' });
    f.setDown(true);
    expect(await resolveLease(edit, deps(f.server))).toMatchObject({
      allow: false,
      next: expect.stringMatching(/sdlc bypass/),
    });
  });
});

describe('cliente HTTP del gate', () => {
  let slow: Server;
  let url: string;
  let env: string;

  beforeAll(async () => {
    slow = createServer((_req, res) => setTimeout(() => res.end('{}'), 3000));
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
    env = mkdtempSync(join(tmpdir(), 'sdlc-xdg-'));
    process.env.XDG_CONFIG_HOME = env;
    writeServerCredential(url, {
      client_id: 'c',
      token_endpoint: `${url}/oauth/token`,
      access_token: 'at',
      refresh_token: 'rt',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
  });
  afterAll(() => {
    slow.close();
    delete process.env.XDG_CONFIG_HOME;
  });

  it('con un server que tarda más de 1,5 s corta y falla como "no disponible"', async () => {
    const t0 = Date.now();
    await expect(
      httpGateServer(url).check({
        workspace: 'demo',
        lease_id: 'x',
        repo: 'r',
        branch: 'b',
        worktree: '/',
      }),
    ).rejects.toThrow(/sin respuesta/);
    expect(Date.now() - t0).toBeLessThan(2500);
  });
});

describe('remote normalizado', () => {
  it.each([
    ['https://github.com/Acme/app.git', 'github.com/Acme/app'],
    ['git@github.com:Acme/app.git', 'github.com/Acme/app'],
    ['ssh://git@GitHub.com:22/Acme/app', 'github.com/Acme/app'],
    ['https://x-token:abc@github.com/Acme/app/', 'github.com/Acme/app'],
  ])('%s → %s', (url, id) => expect(normalizeRemote(url)).toBe(id));
});

describe('gate de punta a punta (bundle + server HTTP falso)', () => {
  let gate: string;
  let srv: Server;
  let serverUrl: string;
  const received: Array<{ path: string; body: any }> = [];

  beforeAll(async () => {
    gate = join(mkdtempSync(join(tmpdir(), 'sdlc-gate-e2e-')), 'gate.mjs');
    await buildGate(gate);
    srv = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const body = JSON.parse(data || '{}');
        received.push({ path: req.url ?? '', body });
        const ok = (d: unknown) => res.end(JSON.stringify({ ok: true, data: d }));
        if (req.url === '/gate/v1/check') {
          return ok(
            body.lease_id === 'gl_real'
              ? { valid: true, kind: 'story', valid_until: '2026-12-31T00:00:00Z' }
              : {
                  valid: false,
                  reason: 'unknown',
                  next_step: 'reclamá una historia con claim_story',
                },
          );
        }
        return ok({ stored: body.events?.length ?? 0 });
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    serverUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    mkdirSync(join(repo, '.claude', 'sdlc'), { recursive: true });
    writeFileSync(
      join(repo, '.claude', 'sdlc', 'config.json'),
      JSON.stringify({ ...config, server_url: serverUrl }),
    );
  });
  afterAll(() => srv.close());

  function runGate(mode: 'pre' | 'post', event: unknown, xdg: string): Promise<string> {
    return new Promise((resolve) => {
      const p = spawn(process.execPath, [gate, mode], {
        env: { ...process.env, CLAUDE_PROJECT_DIR: repo, XDG_CONFIG_HOME: xdg },
      });
      let out = '';
      p.stdout.on('data', (c) => (out += c));
      p.on('close', () => resolve(out));
      p.stdin.end(JSON.stringify(event));
    });
  }

  it('claim → commit permitido y registrado; lease inventado → commit bloqueado y registrado', async () => {
    const xdg = mkdtempSync(join(tmpdir(), 'sdlc-xdg-'));
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

    const post = await runGate(
      'post',
      {
        tool_name: 'mcp__sdlc__claim_story',
        tool_input: { story_id: 's-1' },
        tool_response: claimResponse({
          ok: true,
          data: { gate_lease: { lease_id: 'gl_real', expires_at: '2026-12-31T00:00:00Z' } },
        }),
        cwd: wt,
      },
      xdg,
    );
    expect(post).toBe('');

    const commit = { tool_name: 'Bash', tool_input: { command: 'git commit -am x' }, cwd: wt };
    expect(await runGate('pre', commit, xdg)).toBe('');
    expect(received.find((r) => r.path === '/gate/v1/events')?.body.events[0]).toMatchObject({
      kind: 'commit.allowed',
      branch: 'feat/a',
    });

    writeLease(wt, { lease_id: 'gl_inventado', kind: 'story', expires_at: 'x' });
    const denied = JSON.parse(await runGate('pre', commit, xdg));
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(received.at(-1)?.body.events[0]).toMatchObject({
      kind: 'commit.blocked',
      reason: 'unknown',
    });
  });

  it('con el server inaccesible el gate deniega sugiriendo sdlc bypass', async () => {
    const xdg = mkdtempSync(join(tmpdir(), 'sdlc-xdg-'));
    writeFileSync(
      join(repo, '.claude', 'sdlc', 'config.json'),
      JSON.stringify({ ...config, server_url: 'http://127.0.0.1:9' }),
    );
    writeServerCredential(
      'http://127.0.0.1:9',
      {
        client_id: 'c',
        token_endpoint: 'http://127.0.0.1:9/oauth/token',
        access_token: 'at',
        refresh_token: 'rt',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
      { XDG_CONFIG_HOME: xdg },
    );
    writeLease(wt, { lease_id: 'gl_real', kind: 'story', expires_at: 'x' });
    const out = JSON.parse(
      await runGate(
        'pre',
        { tool_name: 'Edit', tool_input: { file_path: join(wt, 'b.ts') }, cwd: wt },
        xdg,
      ),
    );
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/sdlc bypass/);
  });
});
