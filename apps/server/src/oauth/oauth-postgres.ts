import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { oauth_clients, oauth_codes, oauth_refresh_tokens } from '../state/schema.js';
import { randomToken, sha256hex } from './crypto.js';
import {
  CODE_TTL_MS,
  REFRESH_TTL_MS,
  type GrantClaims,
  type OAuthClient,
  type OAuthStore,
} from './oauth-store.js';

export interface PostgresOAuthStoreOptions {
  databaseUrl: string;
  client?: Sql;
}

export class PostgresOAuthStore implements OAuthStore {
  private readonly db: PostgresJsDatabase;
  private readonly client: Sql;

  constructor(opts: PostgresOAuthStoreOptions) {
    this.client = opts.client ?? postgres(opts.databaseUrl, { max: 5 });
    this.db = drizzle(this.client);
  }

  async close(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }

  async registerClient(input: { client_name: string; redirect_uris: string[] }): Promise<OAuthClient> {
    const client = {
      client_id: `client_${randomUUID()}`,
      client_name: input.client_name,
      redirect_uris: input.redirect_uris,
    };
    await this.db.insert(oauth_clients).values(client);
    return client;
  }

  async getClient(clientId: string): Promise<OAuthClient | undefined> {
    const [r] = await this.db.select().from(oauth_clients).where(eq(oauth_clients.client_id, clientId)).limit(1);
    return r
      ? { client_id: r.client_id, client_name: r.client_name, redirect_uris: r.redirect_uris as string[] }
      : undefined;
  }

  async issueCode(
    input: GrantClaims & { client_id: string; redirect_uri: string; code_challenge: string },
    now = Date.now(),
  ): Promise<string> {
    const code = randomToken('code_');
    await this.db.insert(oauth_codes).values({
      code_hash: sha256hex(code),
      client_id: input.client_id,
      redirect_uri: input.redirect_uri,
      code_challenge: input.code_challenge,
      email: input.email,
      tenant_id: input.tenant_id,
      roles: input.roles,
      workspaces: input.workspaces,
      expires_at: new Date(now + CODE_TTL_MS),
    });
    return code;
  }

  async consumeCode(code: string, now = Date.now()) {
    // UPDATE ... WHERE used_at IS NULL es atómico: dos canjes concurrentes no pueden ganar ambos.
    const [r] = await this.db
      .update(oauth_codes)
      .set({ used_at: new Date(now) })
      .where(and(eq(oauth_codes.code_hash, sha256hex(code)), isNull(oauth_codes.used_at)))
      .returning();
    if (!r || now >= r.expires_at.getTime()) return null;
    return {
      email: r.email,
      tenant_id: r.tenant_id,
      roles: r.roles as string[],
      workspaces: r.workspaces as Record<string, string[]>,
      client_id: r.client_id,
      redirect_uri: r.redirect_uri,
      code_challenge: r.code_challenge,
    };
  }

  async issueRefreshToken(input: GrantClaims & { client_id: string }, now = Date.now()): Promise<string> {
    const token = randomToken('rt_');
    await this.db.insert(oauth_refresh_tokens).values({
      id: randomUUID(),
      token_hash: sha256hex(token),
      email: input.email,
      tenant_id: input.tenant_id,
      roles: input.roles,
      workspaces: input.workspaces,
      client_id: input.client_id,
      expires_at: new Date(now + REFRESH_TTL_MS),
    });
    return token;
  }

  async consumeRefreshToken(token: string, now = Date.now()) {
    const [r] = await this.db
      .update(oauth_refresh_tokens)
      .set({ revoked_at: new Date(now) })
      .where(and(eq(oauth_refresh_tokens.token_hash, sha256hex(token)), isNull(oauth_refresh_tokens.revoked_at)))
      .returning();
    if (!r || now >= r.expires_at.getTime()) return null;
    return {
      email: r.email,
      tenant_id: r.tenant_id,
      roles: r.roles as string[],
      workspaces: r.workspaces as Record<string, string[]>,
      client_id: r.client_id,
    };
  }
}
