export interface OAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}

export interface GrantClaims {
  email: string;
  tenant_id: string;
  roles: string[];
  /** Mapa workspace_id → roles de la persona en ese workspace. Va como claim `workspaces` del JWT. */
  workspaces: Record<string, string[]>;
}

export const CODE_TTL_MS = 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Estado persistente del Authorization Server: clients DCR, codes y refresh tokens. */
export interface OAuthStore {
  registerClient(input: { client_name: string; redirect_uris: string[] }): Promise<OAuthClient>;
  getClient(clientId: string): Promise<OAuthClient | undefined>;
  /** Persiste el code hasheado con TTL 60s. Devuelve el plaintext (única vez). */
  issueCode(
    input: GrantClaims & { client_id: string; redirect_uri: string; code_challenge: string },
    now?: number,
  ): Promise<string>;
  /** Single-use: marca used_at. Null si no existe, expiró o ya se usó. */
  consumeCode(
    code: string,
    now?: number,
  ): Promise<(GrantClaims & { client_id: string; redirect_uri: string; code_challenge: string }) | null>;
  issueRefreshToken(input: GrantClaims & { client_id: string }, now?: number): Promise<string>;
  /** Rota: revoca el usado y devuelve los claims. Null si inválido/expirado/revocado. */
  consumeRefreshToken(token: string, now?: number): Promise<(GrantClaims & { client_id: string }) | null>;
}
