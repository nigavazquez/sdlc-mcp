import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createSession, serializeSessionCookie } from '../admin/auth.js';
import { signJwt, signState, verifyPkceS256, verifyState } from './crypto.js';
import type { DirectoryStore } from './directory-store.js';
import { normalizeEmail } from './directory-store.js';
import type { IdentityProvider } from './oidc.js';
import type { OAuthStore } from './oauth-store.js';
import type { Labels } from '../config/labels.js';
import { DEFAULT_LABELS } from '../config/labels.js';

export const ACCESS_TOKEN_TTL_S = 3600;
const STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthRoutesConfig {
  /** URL pública del server (issuer y base de los redirect URIs). */
  publicUrl: string;
  /** Tenant fijo del deploy (los workspaces son el eje real del modelo). */
  tenantId: string;
  /** Firma de access tokens y del state del redirect a Google. */
  signingSecret: string;
  /** Dominios de email permitidos. Si no está vacío, el dominio del email debe estar en la lista. Vacío = sin restricción. */
  allowedEmailDomains: string[];
  /** Emails con acceso al panel admin (lowercase). */
  adminEmails: string[];
  adminSessionSecret: string;
  secureCookies: boolean;
  /** Configurable labels for workspace/group entities (defaults to "workspace"/"group"). */
  labels?: Labels;
}

export interface OAuthRoutesDeps {
  oauthStore: OAuthStore;
  directory: DirectoryStore;
  /** Sin broker configurado (falta config OIDC) el flujo responde 503. */
  idp: IdentityProvider | undefined;
  config: OAuthRoutesConfig;
}

const RegisterBody = z.object({
  client_name: z.string().min(1).max(200).default('mcp-client'),
  redirect_uris: z.array(z.string().url()).min(1),
});

const TokenBody = z.object({
  grant_type: z.string(),
  code: z.string().optional(),
  code_verifier: z.string().optional(),
  client_id: z.string().optional(),
  redirect_uri: z.string().optional(),
  refresh_token: z.string().optional(),
});

function errorPage(title: string, detail: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:sans-serif;max-width:480px;margin:15vh auto;color:#1c2733">
<h2>${title}</h2><p>${detail}</p></body></html>`;
}

export function registerOAuthRoutes(app: FastifyInstance, deps: OAuthRoutesDeps): void {
  const { config } = deps;
  const callbackUri = `${config.publicUrl}/oauth/callback`;

  // Los clientes OAuth mandan el token request como form-urlencoded.
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });
  }

  app.get('/.well-known/oauth-protected-resource', async () => ({
    resource: config.publicUrl,
    authorization_servers: [config.publicUrl],
    bearer_methods_supported: ['header'],
  }));

  app.get('/.well-known/oauth-authorization-server', async () => ({
    issuer: config.publicUrl,
    authorization_endpoint: `${config.publicUrl}/oauth/authorize`,
    token_endpoint: `${config.publicUrl}/oauth/token`,
    registration_endpoint: `${config.publicUrl}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['openid', 'email'],
  }));

  app.post('/oauth/register', async (req, reply) => {
    const parsed = RegisterBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_client_metadata', error_description: parsed.error.message });
    }
    const client = await deps.oauthStore.registerClient(parsed.data);
    return reply.code(201).send({
      ...client,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  app.get('/oauth/authorize', async (req, reply) => {
    if (!deps.idp) {
      return reply.code(503).send({ error: 'temporarily_unavailable', error_description: 'OIDC identity provider not configured' });
    }
    const q = req.query as Record<string, string | undefined>;

    // Login del panel admin: mismo broker, state con mode=admin.
    if (q.mode === 'admin') {
      const state = signState({ mode: 'admin' }, config.signingSecret, STATE_TTL_MS);
      return reply.redirect(deps.idp.authUrl({ state, redirectUri: callbackUri }));
    }

    if (q.response_type !== 'code') {
      return reply.code(400).send({ error: 'unsupported_response_type' });
    }
    const client = q.client_id ? await deps.oauthStore.getClient(q.client_id) : undefined;
    if (!client) return reply.code(400).send({ error: 'invalid_request', error_description: 'unknown client_id' });
    if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) {
      return reply.code(400).send({ error: 'invalid_request', error_description: 'redirect_uri not registered' });
    }
    if (!q.code_challenge || q.code_challenge_method !== 'S256') {
      return reply.code(400).send({ error: 'invalid_request', error_description: 'PKCE S256 is required' });
    }

    const state = signState(
      {
        mode: 'mcp',
        client_id: client.client_id,
        redirect_uri: q.redirect_uri,
        code_challenge: q.code_challenge,
        client_state: q.state ?? '',
      },
      config.signingSecret,
      STATE_TTL_MS,
    );
    return reply.redirect(deps.idp.authUrl({ state, redirectUri: callbackUri }));
  });

  app.get('/oauth/callback', async (req, reply) => {
    if (!deps.idp) {
      return reply.code(503).send({ error: 'temporarily_unavailable', error_description: 'OIDC identity provider not configured' });
    }
    const q = req.query as Record<string, string | undefined>;
    const state = q.state ? verifyState(q.state, config.signingSecret) : null;
    if (!q.code || !state) {
      return reply.code(400).type('text/html').send(errorPage('Login inválido', 'El state expiró o fue alterado. Reintentá el login.'));
    }

    let identity;
    try {
      identity = await deps.idp.exchangeCode({ code: q.code, redirectUri: callbackUri });
    } catch {
      return reply.code(400).type('text/html').send(errorPage('Login inválido', 'No se pudo validar la cuenta con el proveedor de identidad. Reintentá.'));
    }
    const email = normalizeEmail(identity.email);

    // Domain allowlist — enforced before the admin/mcp branch split so both paths are protected.
    if (config.allowedEmailDomains.length > 0) {
      const emailDomain = email.split('@')[1]?.toLowerCase() ?? '';
      if (!config.allowedEmailDomains.includes(emailDomain)) {
        return reply.code(403).type('text/html').send(errorPage('Dominio no permitido', `El dominio del email (${emailDomain}) no está habilitado en este servidor.`));
      }
    }

    if (state.mode === 'admin') {
      if (!config.adminEmails.includes(email)) {
        return reply.code(403).type('text/html').send(errorPage('Sin acceso al panel', `${email} no está en la lista de administradores.`));
      }
      const session = createSession(config.adminSessionSecret, undefined, Date.now(), { email });
      return reply
        .header('set-cookie', serializeSessionCookie(session, config.secureCookies))
        .redirect('/admin/');
    }

    // mode=mcp: la cuenta tiene que tener membresía en al menos un workspace.
    const labels = config.labels ?? DEFAULT_LABELS;
    const wLabel = labels.workspace.singular;
    const memberships = await deps.directory.listMemberships(email);
    if (memberships.length === 0) {
      return reply
        .code(403)
        .type('text/html')
        .send(errorPage('Cuenta sin alta', `${email} no pertenece a ningún ${wLabel}. Pedile al admin del panel SDLC que te dé de alta en tu ${wLabel}.`));
    }
    // workspaces = mapa workspace_id → roles; roles = unión (compat con clientes que sólo miran `roles`).
    const workspaces: Record<string, string[]> = {};
    for (const m of memberships) workspaces[m.workspace_id] = m.roles;
    const roles = [...new Set(memberships.flatMap((m) => m.roles))];
    const code = await deps.oauthStore.issueCode({
      email,
      tenant_id: config.tenantId,
      roles,
      workspaces,
      client_id: state.client_id as string,
      redirect_uri: state.redirect_uri as string,
      code_challenge: state.code_challenge as string,
    });
    const target = new URL(state.redirect_uri as string);
    target.searchParams.set('code', code);
    if (state.client_state) target.searchParams.set('state', state.client_state as string);
    return reply.redirect(target.toString());
  });

  app.post('/oauth/token', async (req, reply) => {
    const parsed = TokenBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const body = parsed.data;

    const issueTokens = async (grant: {
      email: string;
      tenant_id: string;
      roles: string[];
      workspaces: Record<string, string[]>;
      client_id: string;
    }) => {
      const nowS = Math.floor(Date.now() / 1000);
      const accessToken = signJwt(
        {
          iss: config.publicUrl,
          aud: 'sdlc-mcp',
          sub: grant.email,
          tenant_id: grant.tenant_id,
          roles: grant.roles,
          workspaces: grant.workspaces,
          iat: nowS,
          exp: nowS + ACCESS_TOKEN_TTL_S,
        },
        config.signingSecret,
      );
      const refreshToken = await deps.oauthStore.issueRefreshToken(grant);
      return {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_S,
        refresh_token: refreshToken,
      };
    };

    if (body.grant_type === 'authorization_code') {
      if (!body.code || !body.code_verifier) return reply.code(400).send({ error: 'invalid_request' });
      const grant = await deps.oauthStore.consumeCode(body.code);
      if (
        !grant ||
        (body.client_id && body.client_id !== grant.client_id) ||
        (body.redirect_uri && body.redirect_uri !== grant.redirect_uri) ||
        !verifyPkceS256(body.code_verifier, grant.code_challenge)
      ) {
        return reply.code(400).send({ error: 'invalid_grant' });
      }
      return issueTokens(grant);
    }

    if (body.grant_type === 'refresh_token') {
      if (!body.refresh_token) return reply.code(400).send({ error: 'invalid_request' });
      const grant = await deps.oauthStore.consumeRefreshToken(body.refresh_token);
      if (!grant) return reply.code(400).send({ error: 'invalid_grant' });
      return issueTokens(grant);
    }

    return reply.code(400).send({ error: 'unsupported_grant_type' });
  });
}
