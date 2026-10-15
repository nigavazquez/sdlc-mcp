import { describe, expect, it } from 'vitest';
import {
  signJwt,
  verifyJwt,
  verifyPkceS256,
  signState,
  verifyState,
  sha256hex,
  randomToken,
} from '../src/oauth/crypto.js';

const OPTS = { iss: 'https://sdlc.example.com', aud: 'sdlc-mcp' };

describe('JWT HS256', () => {
  it('sign/verify roundtrip preserves claims', () => {
    const t0 = 1_700_000_000_000;
    const token = signJwt(
      { ...OPTS, sub: 'a@example.com', tenant_id: 't1', roles: ['developer'], iat: t0 / 1000, exp: t0 / 1000 + 3600 },
      'secret',
    );
    const result = verifyJwt(token, 'secret', OPTS, t0 + 1000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sub).toBe('a@example.com');
      expect(result.payload.tenant_id).toBe('t1');
      expect(result.payload.roles).toEqual(['developer']);
    }
  });

  it('rejects expired, wrong iss/aud, tampered signature, garbage', () => {
    const t0 = 1_700_000_000_000;
    const token = signJwt({ ...OPTS, sub: 'a@x.com', iat: t0 / 1000, exp: t0 / 1000 + 10 }, 'secret');
    expect(verifyJwt(token, 'secret', OPTS, t0 + 60_000).ok).toBe(false); // expirado
    expect(verifyJwt(token, 'other', OPTS, t0).ok).toBe(false); // firma
    expect(verifyJwt(token, 'secret', { ...OPTS, iss: 'https://evil' }, t0).ok).toBe(false);
    expect(verifyJwt(token, 'secret', { ...OPTS, aud: 'other' }, t0).ok).toBe(false);
    expect(verifyJwt(token + 'x', 'secret', OPTS, t0).ok).toBe(false);
    expect(verifyJwt('not.a.jwt', 'secret', OPTS, t0).ok).toBe(false);
  });
});

describe('PKCE S256', () => {
  it('matches the RFC 7636 appendix B vector', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
    expect(verifyPkceS256(verifier + 'x', challenge)).toBe(false);
  });
});

describe('signed state', () => {
  it('roundtrip, TTL y tamper', () => {
    const t0 = 1_700_000_000_000;
    const state = signState({ mode: 'admin', redirect_uri: 'https://x/cb' }, 'sec', 600_000, t0);
    expect(verifyState(state, 'sec', t0 + 1000)).toMatchObject({ mode: 'admin' });
    expect(verifyState(state, 'sec', t0 + 700_000)).toBeNull(); // vencido
    expect(verifyState(state, 'otro', t0 + 1000)).toBeNull();
    expect(verifyState(state + 'x', 'sec', t0 + 1000)).toBeNull();
    expect(verifyState('garbage', 'sec', t0)).toBeNull();
  });
});

describe('helpers', () => {
  it('sha256hex + randomToken', () => {
    expect(sha256hex('abc')).toMatch(/^[0-9a-f]{64}$/);
    const tok = randomToken('rt_');
    expect(tok).toMatch(/^rt_[A-Za-z0-9_-]{40,}$/);
    expect(randomToken('rt_')).not.toBe(tok);
  });
});
