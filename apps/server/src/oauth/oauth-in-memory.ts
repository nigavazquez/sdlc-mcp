import { randomUUID } from 'node:crypto';
import { randomToken, sha256hex } from './crypto.js';
import {
  CODE_TTL_MS,
  REFRESH_TTL_MS,
  type GrantClaims,
  type OAuthClient,
  type OAuthStore,
} from './oauth-store.js';

interface StoredCode extends GrantClaims {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  expires_at: number;
  used: boolean;
}

interface StoredRefresh extends GrantClaims {
  client_id: string;
  expires_at: number;
  revoked: boolean;
}

export class InMemoryOAuthStore implements OAuthStore {
  private readonly clients = new Map<string, OAuthClient>();
  private readonly codes = new Map<string, StoredCode>();
  private readonly refreshTokens = new Map<string, StoredRefresh>();

  async registerClient(input: { client_name: string; redirect_uris: string[] }): Promise<OAuthClient> {
    const client: OAuthClient = {
      client_id: `client_${randomUUID()}`,
      client_name: input.client_name,
      redirect_uris: [...input.redirect_uris],
    };
    this.clients.set(client.client_id, client);
    return client;
  }

  async getClient(clientId: string): Promise<OAuthClient | undefined> {
    return this.clients.get(clientId);
  }

  async issueCode(
    input: GrantClaims & { client_id: string; redirect_uri: string; code_challenge: string },
    now = Date.now(),
  ): Promise<string> {
    const code = randomToken('code_');
    this.codes.set(sha256hex(code), { ...input, expires_at: now + CODE_TTL_MS, used: false });
    return code;
  }

  async consumeCode(code: string, now = Date.now()) {
    const stored = this.codes.get(sha256hex(code));
    if (!stored || stored.used || now >= stored.expires_at) return null;
    stored.used = true;
    const { expires_at: _e, used: _u, ...grant } = stored;
    return grant;
  }

  async issueRefreshToken(input: GrantClaims & { client_id: string }, now = Date.now()): Promise<string> {
    const token = randomToken('rt_');
    this.refreshTokens.set(sha256hex(token), { ...input, expires_at: now + REFRESH_TTL_MS, revoked: false });
    return token;
  }

  async consumeRefreshToken(token: string, now = Date.now()) {
    const stored = this.refreshTokens.get(sha256hex(token));
    if (!stored || stored.revoked || now >= stored.expires_at) return null;
    stored.revoked = true; // rotación: un refresh solo se usa una vez
    const { expires_at: _e, revoked: _r, ...grant } = stored;
    return grant;
  }
}
