import {
  chmodSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Env = Record<string, string | undefined>;

/** Credencial OAuth de un server sdlc. `expires_at` es el vencimiento del access token. */
export interface ServerCredential {
  client_id: string;
  token_endpoint: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

export interface CredentialsFile {
  version: 1;
  servers: Record<string, ServerCredential>;
}

/**
 * `~/.config/sdlc` (o `$XDG_CONFIG_HOME/sdlc`): fuera de cualquier repo, así el agente
 * no la commitea y el token no viaja con el código (RFC sdlc-repo-onboarding, Security).
 */
export function credentialsDir(env: Env = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'sdlc');
}

export function credentialsPath(env: Env = process.env): string {
  return join(credentialsDir(env), 'credentials.json');
}

/** Una URL de server se guarda sin `/` final, para que `--server` con o sin barra sea el mismo. */
export function serverKey(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, '');
}

/** Lee el archivo. Si no existe devuelve uno vacío; si está corrupto tira (no se adivina). */
export function readCredentials(env: Env = process.env): CredentialsFile {
  let raw: string;
  try {
    raw = readFileSync(credentialsPath(env), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, servers: {} };
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<CredentialsFile>;
  if (parsed.version !== 1 || typeof parsed.servers !== 'object' || parsed.servers === null) {
    throw new Error(`formato desconocido en ${credentialsPath(env)}`);
  }
  return parsed as CredentialsFile;
}

/**
 * Escribe la credencial de un server preservando las de los demás. Escritura atómica
 * (archivo temporal + rename) y siempre 0600 dentro de un directorio 0700.
 */
export function writeServerCredential(
  serverUrl: string,
  cred: ServerCredential,
  env: Env = process.env,
): void {
  const dir = credentialsDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  let current: CredentialsFile;
  try {
    current = readCredentials(env);
  } catch {
    // Un archivo ilegible se reemplaza sólo al escribir una credencial nueva y válida.
    current = { version: 1, servers: {} };
  }
  current.servers[serverKey(serverUrl)] = cred;

  const path = credentialsPath(env);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

/**
 * Exclusión entre procesos sobre el archivo de credenciales. Hace falta porque el
 * refresh token del server es de un solo uso: dos hooks que renuevan a la vez
 * quemarían el mismo token y uno quedaría deslogueado.
 */
export async function withCredentialsLock<T>(env: Env, fn: () => Promise<T>): Promise<T> {
  mkdirSync(credentialsDir(env), { recursive: true, mode: 0o700 });
  const lock = `${credentialsPath(env)}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx', 0o600));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (isStale(lock)) {
        unlinkSync(lock);
        continue;
      }
      if (Date.now() > deadline) throw new Error(`no se pudo tomar el lock ${lock}`);
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    unlinkSync(lock);
  }
}

function isStale(lock: string): boolean {
  try {
    return Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}
