import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCli } from '../scripts/build.mjs';

// Seam: el ejecutable `sdlc` empaquetado, que es lo que corre la persona.
let cli: string;

beforeAll(async () => {
  cli = join(mkdtempSync(join(tmpdir(), 'sdlc-cli-')), 'cli.mjs');
  await buildCli(cli);
});

describe('ejecutable sdlc', () => {
  it('sin comando muestra el uso y sale con 0', () => {
    const r = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/^Uso: sdlc/);
    expect(r.stderr).toMatch(/login \[--server URL\]/);
  });

  it('con un comando desconocido sale con 1', () => {
    const r = spawnSync(process.execPath, [cli, 'otro'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
  });

  it('login contra un server inaccesible falla con un mensaje y código 1', () => {
    const r = spawnSync(process.execPath, [cli, 'login', '--server', 'http://127.0.0.1:9'], {
      encoding: 'utf8',
      env: { ...process.env, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'sdlc-cred-')) },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^sdlc: /);
  });
});
