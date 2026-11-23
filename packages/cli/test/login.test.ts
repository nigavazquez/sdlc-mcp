import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { login } from '../src/login.js';
import { getAccessToken, LoginRequiredError } from '../src/token.js';
import { credentialsPath, readCredentials } from '../src/credentials.js';
import { startFakeAs, type FakeAs } from './helpers/fake-as.js';

// Historia #12. Seams: `login()` (lo que corre `sdlc login`), `getAccessToken()` (lo que
// usan el CLI y el gate) y el archivo de credenciales en disco.

let as: FakeAs;
let configHome: string;
const env = () => ({ XDG_CONFIG_HOME: configHome });

/** "Navegador" que sigue los redirects del AS hasta el loopback del CLI. */
const browser = async (url: string) => {
  const r = await fetch(url, { redirect: 'follow' });
  await r.text();
};

beforeEach(async () => {
  as = await startFakeAs();
  configHome = mkdtempSync(join(tmpdir(), 'sdlc-cred-'));
});
afterEach(async () => {
  await as.close();
});

describe('sdlc login', () => {
  it('completa OAuth con PKCE y guarda las credenciales con permisos 0600', async () => {
    await login({ serverUrl: as.url, env: env(), openBrowser: browser, log: () => {} });

    const path = credentialsPath(env());
    expect(path).toBe(join(configHome, 'sdlc', 'credentials.json'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(configHome, 'sdlc')).mode & 0o777).toBe(0o700);

    const cred = readCredentials(env()).servers[as.url];
    expect(cred).toMatchObject({
      access_token: 'at_1',
      refresh_token: 'rt_1',
      client_id: 'client_1',
    });
    expect(Date.parse(cred!.expires_at)).toBeGreaterThan(Date.now());
  });

  it('falla si el state que vuelve al loopback no coincide', async () => {
    const forged = async (url: string) => {
      const r = await fetch(url, { redirect: 'manual' });
      const target = new URL(r.headers.get('location')!);
      target.searchParams.set('state', 'otro');
      await fetch(target).then((x) => x.text());
    };
    await expect(
      login({ serverUrl: as.url, env: env(), openBrowser: forged, log: () => {} }),
    ).rejects.toThrow(/state/);
  });
});

describe('getAccessToken', () => {
  it('devuelve el access token vigente sin llamar al server', async () => {
    await login({ serverUrl: as.url, env: env(), openBrowser: browser, log: () => {} });
    expect(await getAccessToken(as.url, { env: env() })).toBe('at_1');
    expect(as.refreshCalls).toBe(0);
  });

  it('con el access token vencido renueva con el refresh token y guarda el par nuevo', async () => {
    await login({ serverUrl: as.url, env: env(), openBrowser: browser, log: () => {} });
    const later = new Date(Date.now() + 2 * 3600 * 1000);

    expect(await getAccessToken(as.url, { env: env(), now: later })).toBe('at_2');
    expect(readCredentials(env()).servers[as.url]?.refresh_token).toBe('rt_2');
    expect(statSync(credentialsPath(env())).mode & 0o777).toBe(0o600);
  });

  it('dos renovaciones concurrentes no queman el refresh token rotativo', async () => {
    await login({ serverUrl: as.url, env: env(), openBrowser: browser, log: () => {} });
    const later = new Date(Date.now() + 2 * 3600 * 1000);

    const tokens = await Promise.all([
      getAccessToken(as.url, { env: env(), now: later }),
      getAccessToken(as.url, { env: env(), now: later }),
    ]);
    expect(tokens).toEqual(['at_2', 'at_2']);
    expect(as.refreshCalls).toBe(1);
  });

  it('si la renovación falla pide correr sdlc login', async () => {
    await login({ serverUrl: as.url, env: env(), openBrowser: browser, log: () => {} });
    as.liveRefresh.clear();
    const later = new Date(Date.now() + 2 * 3600 * 1000);

    const err = await getAccessToken(as.url, { env: env(), now: later }).catch((e) => e);
    expect(err).toBeInstanceOf(LoginRequiredError);
    expect(err.message).toMatch(/sdlc login/);
  });

  it('sin credencial para ese server pide correr sdlc login', async () => {
    await expect(getAccessToken(as.url, { env: env() })).rejects.toThrow(/sdlc login/);
  });

  it('un archivo de credenciales corrupto no se interpreta: pide login', async () => {
    await login({ serverUrl: as.url, env: env(), openBrowser: browser, log: () => {} });
    writeFileSync(credentialsPath(env()), '{no es json', { mode: 0o600 });
    await expect(getAccessToken(as.url, { env: env() })).rejects.toBeInstanceOf(LoginRequiredError);
    expect(readFileSync(credentialsPath(env()), 'utf8')).toBe('{no es json');
  });
});
