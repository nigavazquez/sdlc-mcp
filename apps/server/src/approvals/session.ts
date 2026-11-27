import { createHmac, timingSafeEqual } from 'node:crypto';
import { createSession, parseCookies, readSession } from '../admin/auth.js';

/**
 * Sesión web de quien aprueba (RFC aprobacion-de-fases). Es la única puerta por la
 * que entra una aprobación: el token MCP del agente no sirve acá.
 *
 * Cookie propia, distinta de la del panel admin: quien aprueba es un miembro del
 * workspace con rol, que en general no es admin, y una sesión de aprobación no
 * tiene que abrir el panel. `Path=/approve` la limita a estas páginas.
 */
export const APPROVER_COOKIE = 'sdlc_approver';
export const APPROVER_SESSION_TTL_MS = 30 * 60 * 1000;

/** Formato del token de los links: 32 bytes en base64url. */
export const APPROVAL_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function createApproverSession(secret: string, email: string, now = Date.now()): string {
  return createSession(secret, APPROVER_SESSION_TTL_MS, now, { email, kind: 'approver' });
}

/** Email de la sesión de aprobación válida, o null. Una sesión del panel admin no cuenta. */
export function approverEmail(secret: string, cookieHeader: string | undefined, now = Date.now()): string | null {
  const token = parseCookies(cookieHeader)[APPROVER_COOKIE];
  if (!token) return null;
  const s = readSession(secret, token, now);
  return s && s.kind === 'approver' && typeof s.email === 'string' ? s.email : null;
}

export function serializeApproverCookie(session: string, secure: boolean): string {
  const attrs = ['Path=/approve', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(APPROVER_SESSION_TTL_MS / 1000)}`];
  if (secure) attrs.push('Secure');
  return `${APPROVER_COOKIE}=${session}; ${attrs.join('; ')}`;
}

/** Token CSRF del formulario: atado al link y a la persona, sin estado en el server. */
export function csrfToken(secret: string, tokenHash: string, email: string): string {
  return createHmac('sha256', secret).update(`approve:${tokenHash}:${email}`).digest('base64url');
}

export function csrfOk(secret: string, tokenHash: string, email: string, got: unknown): boolean {
  if (typeof got !== 'string') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(csrfToken(secret, tokenHash, email));
  return a.length === b.length && timingSafeEqual(a, b);
}
