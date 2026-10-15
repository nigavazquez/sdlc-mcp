import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'sdlc_admin';

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Sesión del panel admin. El login es vía Google SSO (/oauth/authorize?mode=admin);
 * acá solo vive el token de sesión firmado y el manejo de cookies.
 */

/** Token sin estado: base64url({exp, ...data}) + '.' + HMAC. Logout = borrar cookie. */
export function createSession(
  secret: string,
  ttlMs: number = SESSION_TTL_MS,
  now = Date.now(),
  data: Record<string, unknown> = {},
): string {
  const payload = Buffer.from(JSON.stringify({ ...data, exp: now + ttlMs })).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

/** Devuelve el payload de la sesión si es válida y no expiró; null en cualquier otro caso. */
export function readSession(secret: string, token: string, now = Date.now()): Record<string, unknown> | null {
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return null;
  const expected = sign(secret, payload);
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(expected);
  if (macBuf.length !== expBuf.length || !timingSafeEqual(macBuf, expBuf)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
    return typeof parsed.exp === 'number' && now < parsed.exp ? parsed : null;
  } catch {
    return null;
  }
}

export function verifySession(secret: string, token: string, now = Date.now()): boolean {
  return readSession(secret, token, now) !== null;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

export function serializeSessionCookie(token: string, secure: boolean): string {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (secure) attrs.push('Secure');
  return `${SESSION_COOKIE}=${token}; ${attrs.join('; ')}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
