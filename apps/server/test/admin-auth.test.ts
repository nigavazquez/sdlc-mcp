import { describe, expect, it } from 'vitest';
import { createSession, readSession, verifySession, parseCookies } from '../src/admin/auth.js';

describe('admin session primitives', () => {
  it('session roundtrip carries data, expiry, wrong secret, tampering', () => {
    const t0 = 1_000_000;
    const token = createSession('sec', 1000, t0, { email: 'admin@example.com' });
    expect(readSession('sec', token, t0 + 500)).toMatchObject({ email: 'admin@example.com' });
    expect(verifySession('sec', token, t0 + 500)).toBe(true);
    expect(readSession('sec', token, t0 + 1500)).toBeNull(); // expirada
    expect(readSession('other', token, t0 + 500)).toBeNull();
    expect(readSession('sec', token + 'x', t0 + 500)).toBeNull();
    expect(readSession('sec', 'not-a-token', t0 + 500)).toBeNull();
  });

  it('parseCookies handles absent header and multiple cookies', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('a=1; sdlc_admin=tok; b=2')).toEqual({ a: '1', sdlc_admin: 'tok', b: '2' });
  });
});
