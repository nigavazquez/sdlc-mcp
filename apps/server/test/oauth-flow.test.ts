import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerOAuthRoutes } from '../src/oauth/routes.js';
import { InMemoryOAuthStore } from '../src/oauth/oauth-in-memory.js';
import { InMemoryDirectoryStore } from '../src/oauth/directory-in-memory.js';
import { verifyJwt } from '../src/oauth/crypto.js';
import { FakeGoogleIdentityProvider } from './helpers/fake-google.js';
import type { Labels } from '../src/config/labels.js';

const PUBLIC_URL = 'https://sdlc.test';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

async function makeApp(opts: { idp?: FakeGoogleIdentityProvider | null; allowedEmailDomains?: string[]; labels?: Labels } = {}) {
  const app = Fastify();
  const oauthStore = new InMemoryOAuthStore();
  const directory = new InMemoryDirectoryStore();
  const idp = opts.idp === null ? undefined : (opts.idp ?? new FakeGoogleIdentityProvider());
  registerOAuthRoutes(app, {
    oauthStore,
    directory,
    idp,
    config: {
      publicUrl: PUBLIC_URL,
      tenantId: 't1',
      signingSecret: 'signing-secret',
      allowedEmailDomains: opts.allowedEmailDomains ?? [],
      adminEmails: ['admin@example.com'],
      adminSessionSecret: 'session-secret',
      secureCookies: false,
      ...(opts.labels ? { labels: opts.labels } : {}),
    },
  });
  await app.ready();
  return { app, oauthStore, directory, google: idp as FakeGoogleIdentityProvider | undefined };
}

/** Corre register → authorize → callback y devuelve el code emitido para el cliente. */
async function runAuthFlow(ctx: Awaited<ReturnType<typeof makeApp>>, email = 'dev@example.com') {
  const { app, directory, google } = ctx;
  await directory.upsertMember({ email, workspace_id: 'platform', roles: ['developer'] });

  const reg = await app.inject({
    method: 'POST',
    url: '/oauth/register',
    payload: { client_name: 'Claude Code', redirect_uris: ['http://localhost:5599/callback'] },
  });
  expect(reg.statusCode).toBe(201);
  const { client_id } = reg.json();

  const authorize = await app.inject({
    method: 'GET',
    url:
      `/oauth/authorize?response_type=code&client_id=${client_id}` +
      `&redirect_uri=${encodeURIComponent('http://localhost:5599/callback')}` +
      `&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=client-xyz`,
  });
  expect(authorize.statusCode).toBe(302);
  const idpUrl = new URL(authorize.headers.location as string);
  expect(idpUrl.origin).toBe('https://fake-google.test');
  const state = idpUrl.searchParams.get('state')!;

  google!.seed('gcode-1', { email });
  const callback = await app.inject({ method: 'GET', url: `/oauth/callback?code=gcode-1&state=${encodeURIComponent(state)}` });
  expect(callback.statusCode).toBe(302);
  const clientRedirect = new URL(callback.headers.location as string);
  expect(clientRedirect.origin).toBe('http://localhost:5599');
  expect(clientRedirect.searchParams.get('state')).toBe('client-xyz');
  return { client_id, code: clientRedirect.searchParams.get('code')! };
}

describe('OAuth AS end-to-end (fake Google)', () => {
  it('full happy path: register → authorize → callback → token → refresh; old refresh dies', async () => {
    const ctx = await makeApp();
    const { client_id, code } = await runAuthFlow(ctx);

    const token = await ctx.app.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id },
    });
    expect(token.statusCode).toBe(200);
    const { access_token, refresh_token, token_type, expires_in } = token.json();
    expect(token_type).toBe('Bearer');
    expect(expires_in).toBe(3600);

    const verified = verifyJwt(access_token, 'signing-secret', { iss: PUBLIC_URL, aud: 'sdlc-mcp' });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.sub).toBe('dev@example.com');
      expect(verified.payload.tenant_id).toBe('t1');
      expect(verified.payload.roles).toEqual(['developer']);
      // el claim workspaces lleva el mapa workspace → roles (membresía sembrada en runAuthFlow)
      expect(verified.payload.workspaces).toEqual({ platform: ['developer'] });
    }

    const refreshed = await ctx.app.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: { grant_type: 'refresh_token', refresh_token },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().refresh_token).not.toBe(refresh_token);

    const reuse = await ctx.app.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: { grant_type: 'refresh_token', refresh_token },
    });
    expect(reuse.statusCode).toBe(400);
    expect(reuse.json().error).toBe('invalid_grant');
  });

  it('multi-squad: roles = unión y claim workspaces con ambos', async () => {
    const ctx = await makeApp();
    // membresía extra antes de runAuthFlow (que suma platform/developer para el mismo email)
    await ctx.directory.upsertMember({ email: 'dev@example.com', workspace_id: 'planning', roles: ['qa'] });
    const { client_id, code } = await runAuthFlow(ctx);

    const token = await ctx.app.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id },
    });
    expect(token.statusCode).toBe(200);
    const verified = verifyJwt(token.json().access_token, 'signing-secret', { iss: PUBLIC_URL, aud: 'sdlc-mcp' });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(new Set(verified.payload.roles as string[])).toEqual(new Set(['developer', 'qa']));
      expect(verified.payload.workspaces).toEqual({ planning: ['qa'], platform: ['developer'] });
    }
  });

  it('token endpoint accepts form-urlencoded bodies', async () => {
    const ctx = await makeApp();
    const { client_id, code } = await runAuthFlow(ctx);
    const token = await ctx.app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id }).toString(),
    });
    expect(token.statusCode).toBe(200);
  });

  it('wrong PKCE verifier and reused code → invalid_grant', async () => {
    const ctx = await makeApp();
    const { client_id, code } = await runAuthFlow(ctx);
    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: { grant_type: 'authorization_code', code, code_verifier: 'wrong-verifier-wrong-verifier-wrong-wrong', client_id },
    });
    expect(bad.json().error).toBe('invalid_grant'); // PKCE incorrecto (y el code quedó consumido)
    const reuse = await ctx.app.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id },
    });
    expect(reuse.json().error).toBe('invalid_grant');
  });

  it('authorize rejects unknown client, unregistered redirect_uri, missing PKCE', async () => {
    const { app, oauthStore } = await makeApp();
    const noClient = await app.inject({ method: 'GET', url: '/oauth/authorize?response_type=code&client_id=nope&redirect_uri=http://x/cb&code_challenge=c&code_challenge_method=S256' });
    expect(noClient.statusCode).toBe(400);
    const client = await oauthStore.registerClient({ client_name: 'x', redirect_uris: ['http://ok/cb'] });
    const badUri = await app.inject({ method: 'GET', url: `/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent('http://evil/cb')}&code_challenge=c&code_challenge_method=S256` });
    expect(badUri.statusCode).toBe(400);
    const noPkce = await app.inject({ method: 'GET', url: `/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent('http://ok/cb')}` });
    expect(noPkce.statusCode).toBe(400);
    expect(noPkce.json().error_description).toMatch(/PKCE/);
  });

  it('member not in directory → 403 page with instructions', async () => {
    const ctx = await makeApp();
    const { app, oauthStore, google } = ctx;
    const client = await oauthStore.registerClient({ client_name: 'x', redirect_uris: ['http://ok/cb'] });
    const authorize = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent('http://ok/cb')}&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
    });
    const state = new URL(authorize.headers.location as string).searchParams.get('state')!;
    google!.seed('gcode-2', { email: 'ghost@example.com' });
    const callback = await app.inject({ method: 'GET', url: `/oauth/callback?code=gcode-2&state=${encodeURIComponent(state)}` });
    expect(callback.statusCode).toBe(403);
    expect(callback.body).toContain('ghost@example.com');
    expect(callback.body).toContain('alta');
  });

  it('member not in directory → 403 page uses custom workspace label when configured', async () => {
    const ctx = await makeApp({
      labels: {
        workspace: { singular: 'squad', plural: 'squads' },
        group: { singular: 'tribe', plural: 'tribes' },
      },
    });
    const { app, oauthStore, google } = ctx;
    const client = await oauthStore.registerClient({ client_name: 'x', redirect_uris: ['http://ok/cb'] });
    const authorize = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent('http://ok/cb')}&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
    });
    const state = new URL(authorize.headers.location as string).searchParams.get('state')!;
    google!.seed('gcode-label-1', { email: 'ghost@example.com' });
    const callback = await app.inject({ method: 'GET', url: `/oauth/callback?code=gcode-label-1&state=${encodeURIComponent(state)}` });
    expect(callback.statusCode).toBe(403);
    expect(callback.body).toContain('ghost@example.com');
    expect(callback.body).toContain('squad');
    expect(callback.body).not.toContain('ningún workspace');
  });

  it('allowedEmailDomains: email outside list → 403 in admin-mode (domain check is before branch split)', async () => {
    const ctx = await makeApp({ allowedEmailDomains: ['example.com'] });
    const { app, google } = ctx;
    const authorize = await app.inject({ method: 'GET', url: '/oauth/authorize?mode=admin' });
    const state = new URL(authorize.headers.location as string).searchParams.get('state')!;
    google!.seed('gcode-3', { email: 'evil@gmail.com' });
    const callback = await app.inject({ method: 'GET', url: `/oauth/callback?code=gcode-3&state=${encodeURIComponent(state)}` });
    expect(callback.statusCode).toBe(403);
    expect(callback.body).toContain('dominio');
  });

  it('allowedEmailDomains: email outside list → 403 in mcp-mode (domain check is before branch split)', async () => {
    const ctx = await makeApp({ allowedEmailDomains: ['example.com'] });
    const { app, oauthStore, google } = ctx;
    const client = await oauthStore.registerClient({ client_name: 'x', redirect_uris: ['http://ok/cb'] });
    const authorize = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent('http://ok/cb')}&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
    });
    const state = new URL(authorize.headers.location as string).searchParams.get('state')!;
    google!.seed('gcode-3b', { email: 'evil@gmail.com' });
    const callback = await app.inject({ method: 'GET', url: `/oauth/callback?code=gcode-3b&state=${encodeURIComponent(state)}` });
    expect(callback.statusCode).toBe(403);
    expect(callback.body).toContain('dominio');
  });

  it('allowedEmailDomains: empty list allows any verified email with membership', async () => {
    // Empty allowedEmailDomains → no domain restriction
    const ctx = await makeApp({ allowedEmailDomains: [] });
    await ctx.directory.upsertMember({ email: 'user@anydomain.io', workspace_id: 'platform', roles: ['developer'] });
    const { app, oauthStore, google } = ctx;
    const client = await oauthStore.registerClient({ client_name: 'x', redirect_uris: ['http://ok/cb'] });
    const authorize = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent('http://ok/cb')}&code_challenge=${CHALLENGE}&code_challenge_method=S256`,
    });
    const state = new URL(authorize.headers.location as string).searchParams.get('state')!;
    google!.seed('gcode-3c', { email: 'user@anydomain.io' });
    const callback = await app.inject({ method: 'GET', url: `/oauth/callback?code=gcode-3c&state=${encodeURIComponent(state)}` });
    expect(callback.statusCode).toBe(302);
  });

  it('admin mode: allowlisted email gets session cookie, others 403', async () => {
    const ctx = await makeApp();
    const { app, google } = ctx;
    const authorize = await app.inject({ method: 'GET', url: '/oauth/authorize?mode=admin' });
    expect(authorize.statusCode).toBe(302);
    const state = new URL(authorize.headers.location as string).searchParams.get('state')!;

    google!.seed('gcode-4', { email: 'Admin@Example.com' });
    const ok = await app.inject({ method: 'GET', url: `/oauth/callback?code=gcode-4&state=${encodeURIComponent(state)}` });
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toBe('/admin/');
    expect(ok.headers['set-cookie']).toMatch(/^sdlc_admin=/);

    const authorize2 = await app.inject({ method: 'GET', url: '/oauth/authorize?mode=admin' });
    const state2 = new URL(authorize2.headers.location as string).searchParams.get('state')!;
    google!.seed('gcode-5', { email: 'dev@example.com' });
    const denied = await app.inject({ method: 'GET', url: `/oauth/callback?code=gcode-5&state=${encodeURIComponent(state2)}` });
    expect(denied.statusCode).toBe(403);
  });

  it('tampered/expired state → 400; /oauth/* without Google config → 503; metadata always up', async () => {
    const ctx = await makeApp();
    const bad = await ctx.app.inject({ method: 'GET', url: '/oauth/callback?code=x&state=garbage' });
    expect(bad.statusCode).toBe(400);

    const { app: noGoogle } = await makeApp({ idp: null });
    const authorize = await noGoogle.inject({ method: 'GET', url: '/oauth/authorize?mode=admin' });
    expect(authorize.statusCode).toBe(503);
    const meta = await noGoogle.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
    expect(meta.statusCode).toBe(200);
    expect(meta.json().token_endpoint).toBe(`${PUBLIC_URL}/oauth/token`);
  });
});
