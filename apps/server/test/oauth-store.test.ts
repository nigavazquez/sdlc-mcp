import { describe, expect, it } from 'vitest';
import { InMemoryOAuthStore } from '../src/oauth/oauth-in-memory.js';

const CLAIMS = {
  email: 'a@example.com',
  tenant_id: 't1',
  roles: ['developer'],
  workspaces: { platform: ['developer'] },
};

describe('InMemoryOAuthStore', () => {
  it('registers and fetches clients', async () => {
    const s = new InMemoryOAuthStore();
    const c = await s.registerClient({ client_name: 'Claude Code', redirect_uris: ['http://localhost:1234/cb'] });
    expect(c.client_id).toMatch(/^client_/);
    expect((await s.getClient(c.client_id))?.client_name).toBe('Claude Code');
    expect(await s.getClient('nope')).toBeUndefined();
  });

  it('codes are single-use and expire', async () => {
    const s = new InMemoryOAuthStore();
    const t0 = 1_700_000_000_000;
    const code = await s.issueCode(
      { ...CLAIMS, client_id: 'c1', redirect_uri: 'http://x/cb', code_challenge: 'ch' },
      t0,
    );
    expect(code).toMatch(/^code_/);
    const grant = await s.consumeCode(code, t0 + 1000);
    expect(grant).toMatchObject({ ...CLAIMS, client_id: 'c1', code_challenge: 'ch' });
    expect(await s.consumeCode(code, t0 + 2000)).toBeNull(); // single-use
    const expired = await s.issueCode(
      { ...CLAIMS, client_id: 'c1', redirect_uri: 'http://x/cb', code_challenge: 'ch' },
      t0,
    );
    expect(await s.consumeCode(expired, t0 + 120_000)).toBeNull(); // TTL 60s
  });

  it('refresh tokens rotate: consumed token stops working', async () => {
    const s = new InMemoryOAuthStore();
    const t0 = 1_700_000_000_000;
    const rt = await s.issueRefreshToken({ ...CLAIMS, client_id: 'c1' }, t0);
    const grant = await s.consumeRefreshToken(rt, t0 + 1000);
    expect(grant).toMatchObject(CLAIMS);
    expect(await s.consumeRefreshToken(rt, t0 + 2000)).toBeNull(); // rotado
    const rt2 = await s.issueRefreshToken({ ...CLAIMS, client_id: 'c1' }, t0);
    expect(await s.consumeRefreshToken(rt2, t0 + 31 * 24 * 3600 * 1000)).toBeNull(); // 30 días
  });
});
