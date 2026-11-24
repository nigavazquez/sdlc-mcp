import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * Authorization server de mentira con el mismo contrato que el de sdlc-mcp
 * (apps/server/src/oauth/routes.ts): registro dinámico, authorize con PKCE S256 y
 * redirect_uri exacto, token con authorization_code y refresh_token rotativo.
 * `/oauth/authorize` no pasa por un IdP: redirige directo al loopback del CLI.
 */
export interface FakeAs {
  url: string;
  refreshCalls: number;
  /** Refresh tokens que el server todavía acepta (se consumen al usarse). */
  liveRefresh: Set<string>;
  close: () => Promise<void>;
}

export async function startFakeAs(): Promise<FakeAs> {
  const clients = new Map<string, string[]>();
  const codes = new Map<string, { challenge: string; redirect: string; client: string }>();
  let seq = 0;
  const state: FakeAs = { url: '', refreshCalls: 0, liveRefresh: new Set(), close: async () => {} };

  const issue = () => {
    seq += 1;
    const refresh = `rt_${seq}`;
    state.liveRefresh.add(refresh);
    return {
      access_token: `at_${seq}`,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refresh,
    };
  };

  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url!, state.url);
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    let raw = '';
    for await (const chunk of req) raw += chunk;

    if (u.pathname === '/.well-known/oauth-authorization-server') {
      return send(200, {
        issuer: state.url,
        authorization_endpoint: `${state.url}/oauth/authorize`,
        token_endpoint: `${state.url}/oauth/token`,
        registration_endpoint: `${state.url}/oauth/register`,
      });
    }
    if (u.pathname === '/oauth/register' && req.method === 'POST') {
      const body = JSON.parse(raw) as { redirect_uris: string[] };
      const id = `client_${clients.size + 1}`;
      clients.set(id, body.redirect_uris);
      return send(201, { client_id: id, redirect_uris: body.redirect_uris });
    }
    if (u.pathname === '/oauth/authorize') {
      const q = u.searchParams;
      const redirect = q.get('redirect_uri')!;
      if (!clients.get(q.get('client_id')!)?.includes(redirect))
        return send(400, { error: 'invalid_request' });
      if (q.get('code_challenge_method') !== 'S256') return send(400, { error: 'invalid_request' });
      const code = `code_${codes.size + 1}`;
      codes.set(code, {
        challenge: q.get('code_challenge')!,
        redirect,
        client: q.get('client_id')!,
      });
      const target = new URL(redirect);
      target.searchParams.set('code', code);
      target.searchParams.set('state', q.get('state') ?? '');
      res.writeHead(302, { location: target.toString() }).end();
      return;
    }
    if (u.pathname === '/oauth/token' && req.method === 'POST') {
      const body = Object.fromEntries(new URLSearchParams(raw));
      if (body.grant_type === 'authorization_code') {
        const grant = codes.get(body.code ?? '');
        codes.delete(body.code ?? '');
        const challenge = createHash('sha256')
          .update(body.code_verifier ?? '')
          .digest('base64url');
        if (!grant || grant.challenge !== challenge || grant.redirect !== body.redirect_uri) {
          return send(400, { error: 'invalid_grant' });
        }
        return send(200, issue());
      }
      if (body.grant_type === 'refresh_token') {
        state.refreshCalls += 1;
        if (!state.liveRefresh.delete(body.refresh_token ?? ''))
          return send(400, { error: 'invalid_grant' });
        return send(200, issue());
      }
      return send(400, { error: 'unsupported_grant_type' });
    }
    send(404, { error: 'not_found' });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((r) => server.close(() => r()));
  return state;
}
