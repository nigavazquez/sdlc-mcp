import { describe, expect, it } from 'vitest';
import { AuthError, createOAuthBearerAuth } from '../src/auth/oauth-bearer.js';
import { signJwt } from '../src/oauth/crypto.js';
import type { SecretResolver } from '../src/secrets/index.js';

const PUBLIC_URL = 'https://sdlc.test';
const secrets: SecretResolver = { resolve: async () => 'x' };
const req = (auth?: string) => ({ headers: auth ? { authorization: auth } : {} });

function makeToken(overrides: Record<string, unknown> = {}, secret = 'sec') {
  const nowS = Math.floor(Date.now() / 1000);
  return signJwt(
    {
      iss: PUBLIC_URL,
      aud: 'sdlc-mcp',
      sub: 'dev@example.com',
      tenant_id: 't1',
      roles: ['developer', 'qa'],
      iat: nowS,
      exp: nowS + 3600,
      ...overrides,
    },
    secret,
  );
}

describe('createOAuthBearerAuth', () => {
  const auth = createOAuthBearerAuth({ signingSecret: 'sec', publicUrl: PUBLIC_URL }, secrets);

  it('builds TenantCtx from JWT claims', async () => {
    const ctx = await auth(req(`Bearer ${makeToken()}`));
    expect(ctx.tenantId).toBe('t1');
    expect(ctx.userId).toBe('dev@example.com');
    expect(ctx.roles).toEqual(['developer', 'qa']);
  });

  it('builds ctx.workspaces from the workspaces claim', async () => {
    const token = makeToken({ workspaces: { platform: ['developer'], planning: ['qa'] } });
    const ctx = await auth(req(`Bearer ${token}`));
    expect(ctx.workspaces).toEqual({ platform: ['developer'], planning: ['qa'] });
  });

  it('omits ctx.workspaces when the claim is absent (compat con tokens viejos)', async () => {
    const ctx = await auth(req(`Bearer ${makeToken()}`));
    expect(ctx.workspaces).toBeUndefined();
  });

  it('rejects missing header, bad signature, expired, missing tenant claim', async () => {
    await expect(auth(req())).rejects.toThrow(AuthError);
    await expect(auth(req(`Bearer ${makeToken({}, 'other-secret')}`))).rejects.toThrow(AuthError);
    const nowS = Math.floor(Date.now() / 1000);
    await expect(auth(req(`Bearer ${makeToken({ exp: nowS - 10 })}`))).rejects.toThrow(/expired/);
    await expect(auth(req(`Bearer ${makeToken({ tenant_id: undefined })}`))).rejects.toThrow(AuthError);
  });

  it('AuthError carries WWW-Authenticate pointing at resource metadata', async () => {
    try {
      await auth(req());
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).wwwAuthenticate).toContain('/.well-known/oauth-protected-resource');
    }
  });
});
