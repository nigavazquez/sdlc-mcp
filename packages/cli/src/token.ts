import {
  readCredentials,
  serverKey,
  withCredentialsLock,
  writeServerCredential,
  type Env,
  type ServerCredential,
} from './credentials.js';

/** Margen para no usar un access token que vence en medio del request. */
const EXPIRY_SKEW_MS = 60_000;

/** No hay sesión utilizable: la única salida es que la persona corra `sdlc login`. */
export class LoginRequiredError extends Error {
  constructor(serverUrl: string, detail: string) {
    super(`${detail}. Corré \`sdlc login --server ${serverKey(serverUrl)}\``);
    this.name = 'LoginRequiredError';
  }
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface GetAccessTokenOptions {
  env?: Env;
  now?: Date;
}

/**
 * Access token vigente para `serverUrl`, renovándolo con el refresh token si venció.
 * Lo usan el CLI y el gate. Sin credencial, con el archivo ilegible o con la
 * renovación rechazada tira `LoginRequiredError`; un error de red se propaga tal cual
 * (es "server no disponible", no "volvé a loguearte").
 */
export async function getAccessToken(
  serverUrl: string,
  opts: GetAccessTokenOptions = {},
): Promise<string> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();

  const current = loadCredential(serverUrl, env);
  if (isFresh(current, now)) return current.access_token;

  return withCredentialsLock(env, async () => {
    // Otro proceso pudo haber renovado mientras esperábamos el lock.
    const latest = loadCredential(serverUrl, env);
    if (isFresh(latest, now)) return latest.access_token;

    const res = await fetch(latest.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: latest.refresh_token,
        client_id: latest.client_id,
      }).toString(),
    });
    if (!res.ok) throw new LoginRequiredError(serverUrl, 'la sesión con el server sdlc venció');

    const tokens = (await res.json()) as TokenResponse;
    const renewed = credentialFromTokens(latest.client_id, latest.token_endpoint, tokens, now);
    writeServerCredential(serverUrl, renewed, env);
    return renewed.access_token;
  });
}

export function credentialFromTokens(
  clientId: string,
  tokenEndpoint: string,
  tokens: TokenResponse,
  now: Date,
): ServerCredential {
  return {
    client_id: clientId,
    token_endpoint: tokenEndpoint,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: new Date(now.getTime() + tokens.expires_in * 1000).toISOString(),
  };
}

function loadCredential(serverUrl: string, env: Env): ServerCredential {
  let cred: ServerCredential | undefined;
  try {
    cred = readCredentials(env).servers[serverKey(serverUrl)];
  } catch {
    throw new LoginRequiredError(serverUrl, 'el archivo de credenciales no se puede leer');
  }
  if (!cred) throw new LoginRequiredError(serverUrl, `no hay sesión con ${serverKey(serverUrl)}`);
  return cred;
}

function isFresh(cred: ServerCredential, now: Date): boolean {
  return Date.parse(cred.expires_at) - EXPIRY_SKEW_MS > now.getTime();
}
