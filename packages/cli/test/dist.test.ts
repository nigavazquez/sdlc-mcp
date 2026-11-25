import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeServerCredential } from '../src/credentials.js';
import { originOf } from '../src/version.js';

// Historia #16 (épica #5). Seam: el artefacto distribuido. Se empaqueta con `npm pack`,
// se instala en un directorio vacío fuera del monorepo y se usa como lo usaría alguien
// con `npx`; y se usa desde el monorepo con `pnpm sdlc`.

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const monorepo = join(pkgDir, '..', '..');
const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
  version: string;
};

let srv: Server;
let serverUrl: string;
let installDir: string;
let installedCli: string;

beforeAll(async () => {
  srv = createServer((req, res) => {
    if (req.url === '/.well-known/oauth-authorization-server') return res.end('{}');
    if (req.url === '/mcp/tools/whoami')
      return res.end(JSON.stringify({ ok: true, data: { self_signoff: { demo: true } } }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  serverUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  const packDir = mkdtempSync(join(tmpdir(), 'sdlc-pack-'));
  execFileSync('npm', ['pack', '--pack-destination', packDir], { cwd: pkgDir, stdio: 'ignore' });
  const tgz = join(packDir, readdirSync(packDir).find((f) => f.endsWith('.tgz'))!);
  installDir = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-npm-')));
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', tgz], {
    cwd: installDir,
    stdio: 'ignore',
  });
  installedCli = join(installDir, 'node_modules', '.bin', 'sdlc');
}, 120_000);
afterAll(() => srv.close());

/** Repo git vacío + sesión con el server falso, con HOME propio para no leer los settings reales. */
function freshRepo() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-dist-repo-')));
  const repo = join(base, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const env = { ...process.env, HOME: join(base, 'home'), XDG_CONFIG_HOME: join(base, 'xdg') };
  writeServerCredential(
    serverUrl,
    {
      client_id: 'c',
      token_endpoint: `${serverUrl}/oauth/token`,
      access_token: 'at',
      refresh_token: 'rt',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    },
    { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME },
  );
  return { repo, env };
}

/**
 * Asíncrono a propósito: el server falso corre en este mismo proceso, y un `spawnSync`
 * bloquearía el event loop que tiene que responderle al CLI.
 */
function run(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) {
  return new Promise<{ status: number | null; stdout: string }>((resolve) => {
    const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    p.stdout.on('data', (c) => (stdout += c));
    p.on('close', (status) => resolve({ status, stdout }));
  });
}

const initArgs = () => [
  'init',
  '--server',
  serverUrl,
  '--workspace',
  'demo',
  '--exclude',
  '',
  '--yes',
];

describe('paquete npm (@nigav/sdlc)', () => {
  it('instalado fuera del monorepo no arrastra dependencias @sdlc/* ni workspace:', () => {
    const installed = JSON.parse(
      readFileSync(join(installDir, 'node_modules', '@nigav', 'sdlc', 'package.json'), 'utf8'),
    );
    expect(installed.name).toBe('@nigav/sdlc');
    expect(installed.dependencies ?? {}).toEqual({});
    expect(JSON.stringify(installed)).not.toMatch(/workspace:|@sdlc\//);
    expect(readdirSync(join(installDir, 'node_modules', '@nigav', 'sdlc', 'dist')).sort()).toEqual([
      'cli.mjs',
      'gate.mjs',
    ]);
  });

  it('`sdlc --version` responde la versión del paquete', () => {
    expect(execFileSync(installedCli, ['--version'], { encoding: 'utf8' }).trim()).toBe(version);
  });

  it('`init` funciona y doctor reporta versión y origen npm del gate', async () => {
    const { repo, env } = freshRepo();
    const r = await run(installedCli, initArgs(), { cwd: repo, env });
    expect(r.stdout).toMatch(
      new RegExp(`versión del gate: v${version.replace(/\./g, '\\.')} \\(npm\\)`),
    );
    expect(r.stdout).toMatch(/Todo en orden/);
    expect(r.status).toBe(0);
    const config = JSON.parse(readFileSync(join(repo, '.claude/sdlc/config.json'), 'utf8'));
    expect(config.installed_with).toEqual({ version, origin: 'npm' });
    expect(
      execFileSync(process.execPath, [join(repo, '.claude/hooks/sdlc-gate.mjs'), '--version'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe(version);
  });
});

describe('desde el monorepo', () => {
  it('`pnpm sdlc --version` corre el mismo CLI', () => {
    const out = execFileSync('pnpm', ['--silent', 'sdlc', '--version'], {
      cwd: monorepo,
      encoding: 'utf8',
    });
    expect(out.trim()).toBe(version);
  });

  it('`pnpm sdlc init` funciona igual y el origen queda como monorepo', async () => {
    const { repo, env } = freshRepo();
    const r = await run(process.execPath, [join(pkgDir, 'dist', 'cli.mjs'), ...initArgs()], {
      cwd: repo,
      env,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/\(monorepo\)/);
    expect(
      JSON.parse(readFileSync(join(repo, '.claude/sdlc/config.json'), 'utf8')).installed_with
        .origin,
    ).toBe('monorepo');
  });
});

describe('originOf', () => {
  it.each([
    ['/home/a/proj/node_modules/@nigav/sdlc/dist/cli.mjs', 'npm'],
    ['/home/a/.npm/_npx/1a2b/node_modules/@nigav/sdlc/dist/cli.mjs', 'npm'],
    ['/home/a/sdlc-mcp/packages/cli/dist/cli.mjs', 'monorepo'],
  ])('%s → %s', (path, origin) => expect(originOf(path)).toBe(origin));
});
