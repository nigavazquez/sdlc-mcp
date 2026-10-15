import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function hmac(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

/** JWT HS256 mínimo (node:crypto): suficiente para tokens propios de un solo emisor. */
export function signJwt(payload: object, secret: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.${hmac(secret, `${header}.${body}`)}`;
}

export function verifyJwt(
  token: string,
  secret: string,
  opts: { iss: string; aud: string },
  now = Date.now(),
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, error: 'malformed token' };
  const [header, body, sig] = parts as [string, string, string];
  if (!safeEqual(sig, hmac(secret, `${header}.${body}`))) return { ok: false, error: 'invalid signature' };
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'malformed payload' };
  }
  if (payload.iss !== opts.iss) return { ok: false, error: 'invalid issuer' };
  if (payload.aud !== opts.aud) return { ok: false, error: 'invalid audience' };
  if (typeof payload.exp !== 'number' || now >= payload.exp * 1000) return { ok: false, error: 'token expired' };
  return { ok: true, payload };
}

/** RFC 7636: challenge = base64url(sha256(ascii(verifier))). */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  return safeEqual(createHash('sha256').update(verifier).digest('base64url'), challenge);
}

/**
 * State firmado y stateless para el redirect a Google: empaqueta el authorization
 * request (o el modo admin) con TTL, sin persistencia server-side.
 */
export function signState(data: object, secret: string, ttlMs: number, now = Date.now()): string {
  const payload = b64url(JSON.stringify({ ...data, __exp: now + ttlMs }));
  return `${payload}.${hmac(secret, payload)}`;
}

export function verifyState(state: string, secret: string, now = Date.now()): Record<string, unknown> | null {
  const [payload, mac] = state.split('.');
  if (!payload || !mac || !safeEqual(mac, hmac(secret, payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
    if (typeof data.__exp !== 'number' || now >= data.__exp) return null;
    delete data.__exp;
    return data;
  } catch {
    return null;
  }
}
