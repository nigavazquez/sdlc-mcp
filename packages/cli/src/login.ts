import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeServerCredential, serverKey, type Env } from './credentials.js';
import { credentialFromTokens, type TokenResponse } from './token.js';

const CALLBACK_TIMEOUT_MS = 5 * 60_000;

export interface LoginOptions {
  serverUrl: string;
  env?: Env;
  /** Abre la URL de autorización. El CLI usa el navegador del sistema; los tests, fetch. */
  openBrowser: (url: string) => Promise<void>;
  log: (line: string) => void;
}

interface AsMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
}

/**
 * `sdlc login`: OAuth 2.1 + PKCE contra el authorization server de sdlc-mcp, con
 * redirect a un servidor loopback efímero. Como el AS exige `redirect_uri` exacto, se
 * registra un cliente por login con el puerto que tocó.
 */
export async function login(opts: LoginOptions): Promise<void> {
  const server = serverKey(opts.serverUrl);
  const meta = await getJson<AsMetadata>(`${server}/.well-known/oauth-authorization-server`);

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');

  const loopback = await startLoopback(state);
  try {
    const client = await postJson<{ client_id: string }>(meta.registration_endpoint, {
      client_name: 'sdlc-cli',
      redirect_uris: [loopback.redirectUri],
    });

    const authorize = new URL(meta.authorization_endpoint);
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: loopback.redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    }).toString();

    opts.log(
      `Abriendo el navegador para iniciar sesión. Si no se abre, entrá a:\n${authorize.toString()}`,
    );
    await opts.openBrowser(authorize.toString());
    const code = await loopback.code;

    const res = await fetch(meta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: client.client_id,
        redirect_uri: loopback.redirectUri,
      }).toString(),
    });
    if (!res.ok)
      throw new Error(`el server rechazó el código de autorización (HTTP ${res.status})`);
    const tokens = (await res.json()) as TokenResponse;

    writeServerCredential(
      server,
      credentialFromTokens(client.client_id, meta.token_endpoint, tokens, new Date()),
      opts.env,
    );
    opts.log(`Sesión iniciada con ${server}.`);
  } finally {
    await loopback.close();
  }
}

interface Loopback {
  redirectUri: string;
  code: Promise<string>;
  close: () => Promise<void>;
}

/** Servidor en 127.0.0.1 que espera un único callback y valida el `state`. */
async function startLoopback(expectedState: string): Promise<Loopback> {
  let resolve!: (code: string) => void;
  let reject!: (err: Error) => void;
  const code = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Evita un unhandled rejection si el login falla antes de esperar el código.
  code.catch(() => {});

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const finish = (status: number, message: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><p>${message}</p>`);
    };
    if (url.searchParams.get('state') !== expectedState) {
      finish(400, 'Login rechazado: el state no coincide. Volvé a correr sdlc login.');
      reject(new Error('el state del callback no coincide; login abortado'));
      return;
    }
    const received = url.searchParams.get('code');
    if (!received) {
      finish(400, 'Login rechazado por el server.');
      reject(
        new Error(
          `el server no devolvió un código (${url.searchParams.get('error') ?? 'sin detalle'})`,
        ),
      );
      return;
    }
    finish(200, 'Listo, ya podés volver a la terminal.');
    resolve(received);
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const timer = setTimeout(
    () => reject(new Error('se venció el tiempo para completar el login')),
    CALLBACK_TIMEOUT_MS,
  );
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    code,
    close: () =>
      new Promise((r) => {
        clearTimeout(timer);
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} respondió HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${url} respondió HTTP ${res.status}`);
  return (await res.json()) as T;
}
