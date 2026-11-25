import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGate } from '../scripts/build.mjs';
import { writeServerCredential } from '../src/credentials.js';
import { runDoctor, type DoctorDeps } from '../src/doctor/doctor.js';
import { dryRunGate } from '../src/doctor/dry-run.js';
import type { SettingsSource } from '../src/doctor/settings-audit.js';
import { runInit } from '../src/init/init.js';

// Historia #14 (épica #5). Seams: `runDoctor` sobre un repo instalado con `runInit` y el
// gate real (bundle), contra un server HTTP falso; y `dryRunGate` sobre el bundle.

let gateSource: string;
let gatePath: string;
let srv: Server;
let serverUrl: string;

beforeAll(async () => {
  gatePath = join(mkdtempSync(join(tmpdir(), 'sdlc-doctor-gate-')), 'gate.mjs');
  await buildGate(gatePath);
  gateSource = readFileSync(gatePath, 'utf8');
  srv = createServer((_req, res) => res.end('{}'));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  serverUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => srv.close());

let repo: string;
let home: string;
let xdg: string;
let sources: SettingsSource[];

beforeEach(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-doctor-')));
  repo = join(base, 'repo');
  home = join(base, 'home');
  xdg = join(base, 'xdg');
  mkdirSync(repo);
  mkdirSync(join(home, '.claude'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
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
    gateSource,
    login: async () => {},
    listWorkspaces: async () => ['demo'],
    flags: { server: serverUrl, workspace: 'demo', exclude: [], yes: true },
    env: { XDG_CONFIG_HOME: xdg },
  });
  sources = [
    { label: 'usuario', path: join(home, '.claude', 'settings.json') },
    { label: 'proyecto', path: join(repo, '.claude', 'settings.json') },
    { label: 'local', path: join(repo, '.claude', 'settings.local.json') },
    { label: 'managed', path: join(home, 'managed-settings.json') },
  ];
});

function deps(extra: Partial<DoctorDeps> = {}): DoctorDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    cwd: repo,
    log: (l) => lines.push(l),
    bundledGate: gateSource,
    listWorkspaces: async () => ['demo'],
    env: { XDG_CONFIG_HOME: xdg },
    sources,
    lines,
    ...extra,
  };
}

describe('sdlc doctor', () => {
  it('en un repo sano pasan todos los chequeos y sale con 0', async () => {
    const d = deps();
    const out = await runDoctor(d);
    const names = out.checks.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'node',
        'versión del gate',
        'hooks',
        'server',
        'token',
        'membresía',
        'settings que anulan el gate',
      ]),
    );
    expect(out.checks.filter((c) => !c.ok)).toEqual([]);
    expect(out.exitCode).toBe(0);
    expect(d.lines.at(-1)).toMatch(/Todo en orden/);
  });

  it.each([
    ['local', '.claude/settings.local.json'],
    ['managed', 'managed'],
  ])('disableAllHooks en el nivel %s se reporta y sale distinto de 0', async (_lvl, where) => {
    const path = where === 'managed' ? join(home, 'managed-settings.json') : join(repo, where);
    writeFileSync(path, JSON.stringify({ disableAllHooks: true }));
    const out = await runDoctor(deps());
    expect(out.exitCode).not.toBe(0);
    expect(out.checks.find((c) => c.name === 'settings que anulan el gate')?.detail).toMatch(
      /disableAllHooks/,
    );
  });

  it('un permiso del usuario que habilita editar archivos protegidos se reporta', async () => {
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Edit(.claude/**)', 'Bash(pnpm test)'] } }),
    );
    const out = await runDoctor(deps());
    expect(out.exitCode).toBe(1);
    const detail = out.checks.find((c) => c.name === 'settings que anulan el gate')!.detail;
    expect(detail).toMatch(/Edit\(\.claude\/\*\*\)/);
    expect(detail).not.toMatch(/pnpm test/);
  });

  it('sin los hooks del gate o con un gate distinto del del CLI falla', async () => {
    const settings = JSON.parse(readFileSync(join(repo, '.claude/settings.json'), 'utf8'));
    delete settings.hooks.PostToolUse;
    writeFileSync(join(repo, '.claude/settings.json'), JSON.stringify(settings));
    writeFileSync(join(repo, '.claude/hooks/sdlc-gate.mjs'), '// viejo');
    const out = await runDoctor(deps());
    expect(out.checks.find((c) => c.name === 'hooks')?.ok).toBe(false);
    expect(out.checks.find((c) => c.name === 'versión del gate')?.ok).toBe(false);
  });

  it('sin membresía al workspace del repo falla', async () => {
    const out = await runDoctor(deps({ listWorkspaces: async () => ['otro'] }));
    expect(out.checks.find((c) => c.name === 'membresía')).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/otro/),
    });
  });

  it('sin sesión con el server falla en token', async () => {
    const out = await runDoctor(deps({ env: { XDG_CONFIG_HOME: join(home, 'vacio') } }));
    expect(out.checks.find((c) => c.name === 'token')).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/sdlc login/),
    });
  });

  it('con node < 20 falla', async () => {
    const out = await runDoctor(deps({ nodeVersion: '18.19.0' }));
    expect(out.checks.find((c) => c.name === 'node')?.ok).toBe(false);
  });
});

describe('dry-run del gate', () => {
  it('Edit sin lease → deny, excluida → allow, commit sin lease → deny, server inaccesible → deny', () => {
    const cases = dryRunGate(gatePath);
    expect(cases.map((c) => [c.name, c.got])).toEqual([
      ['Edit sin lease', 'deny'],
      ['ruta excluida (CLAUDE.md)', 'allow'],
      ['commit sin lease', 'deny'],
      ['server inaccesible', 'deny'],
    ]);
    expect(cases.every((c) => c.ok)).toBe(true);
  });

  it('un gate que deja pasar todo falla el dry-run', () => {
    const permissive = join(mkdtempSync(join(tmpdir(), 'sdlc-perm-')), 'gate.mjs');
    writeFileSync(permissive, '');
    const cases = dryRunGate(permissive);
    expect(cases.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      'Edit sin lease',
      'commit sin lease',
      'server inaccesible',
    ]);
  });
});
