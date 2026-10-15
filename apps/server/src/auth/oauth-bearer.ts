import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { RoleId } from '@sdlc/core';
import { verifyJwt } from '../oauth/crypto.js';
import type { SecretResolver } from '../secrets/index.js';

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status = 401,
    /** Valor del header WWW-Authenticate del 401 — dispara el flujo OAuth en clientes MCP. */
    public readonly wwwAuthenticate?: string,
  ) {
    super(message);
  }
}

export interface AuthRequestLike {
  headers: Record<string, string | string[] | undefined>;
}

export interface OAuthBearerOptions {
  signingSecret: string;
  publicUrl: string;
}

/**
 * Auth del endpoint MCP: Bearer = access token JWT emitido por nuestro AS
 * (/oauth/token). tenant/usuario/roles salen de los claims — los headers
 * X-User-* del esquema API key quedaron eliminados.
 */
export function createOAuthBearerAuth(opts: OAuthBearerOptions, secretResolver: SecretResolver) {
  const wwwAuthenticate = `Bearer resource_metadata="${opts.publicUrl}/.well-known/oauth-protected-resource"`;

  return async function authenticate(req: AuthRequestLike): Promise<TenantCtx> {
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new AuthError('Missing or malformed Authorization header', 401, wwwAuthenticate);
    }
    const token = header.slice('Bearer '.length).trim();
    const result = verifyJwt(token, opts.signingSecret, { iss: opts.publicUrl, aud: 'sdlc-mcp' });
    if (!result.ok) throw new AuthError(`Invalid access token: ${result.error}`, 401, wwwAuthenticate);

    const { sub, tenant_id, roles, workspaces } = result.payload;
    if (typeof sub !== 'string' || typeof tenant_id !== 'string' || !Array.isArray(roles)) {
      throw new AuthError('Access token missing required claims', 401, wwwAuthenticate);
    }

    return {
      tenantId: tenant_id,
      userId: sub,
      roles: roles as RoleId[],
      // Presente sólo si el token trae el claim (tokens viejos no lo tienen).
      ...(workspaces && typeof workspaces === 'object'
        ? { workspaces: workspaces as Record<string, RoleId[]> }
        : {}),
      resolveSecret: (ref: string) => secretResolver.resolve(ref),
    };
  };
}
