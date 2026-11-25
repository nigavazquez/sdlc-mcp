import { describe, expect, it } from 'vitest';
import * as oidcClient from 'openid-client';
import { OidcIdentityProvider } from '../src/oauth/oidc.js';

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** IdP que anuncia el parámetro `iss` en el callback, como Google. Token endpoint simulado. */
async function issAdvertisingIdp() {
  const idp = await OidcIdentityProvider.fromMetadata({
    metadata: {
      issuer: 'https://idp.example',
      authorization_endpoint: 'https://idp.example/authorize',
      token_endpoint: 'https://idp.example/token',
      jwks_uri: 'https://idp.example/jwks',
      authorization_response_iss_parameter_supported: true,
    },
    clientId: 'cid',
    clientSecret: 'sec',
    scopes: ['openid', 'email'],
  });
  const now = Math.floor(Date.now() / 1000);
  // fromMetadata no verifica la firma (ver su comentario): alcanza con claims válidos.
  const idToken = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    iss: 'https://idp.example', aud: 'cid', sub: 's1', iat: now, exp: now + 300,
    email: 'ana@example.com', email_verified: true,
  })}.c2ln`;
  (idp as unknown as { config: oidcClient.Configuration }).config[oidcClient.customFetch] = async () =>
    new Response(JSON.stringify({ access_token: 'at', token_type: 'Bearer', id_token: idToken }), {
      headers: { 'Content-Type': 'application/json' },
    });
  return idp;
}

describe('OidcIdentityProvider', () => {
  it('authUrl incluye client_id, redirect_uri, state y scope openid email', async () => {
    const idp = await OidcIdentityProvider.fromMetadata({
      metadata: {
        issuer: 'https://idp.example',
        authorization_endpoint: 'https://idp.example/authorize',
        token_endpoint: 'https://idp.example/token',
        jwks_uri: 'https://idp.example/jwks',
      },
      clientId: 'cid',
      clientSecret: 'sec',
      scopes: ['openid', 'email'],
    });
    const url = new URL(idp.authUrl({ state: 'st', redirectUri: 'https://app/cb' }));
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app/cb');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('scope')).toContain('email');
  });

  it('authUrl apunta al authorization_endpoint correcto', async () => {
    const idp = await OidcIdentityProvider.fromMetadata({
      metadata: {
        issuer: 'https://idp.example',
        authorization_endpoint: 'https://idp.example/authorize',
        token_endpoint: 'https://idp.example/token',
        jwks_uri: 'https://idp.example/jwks',
      },
      clientId: 'cid',
      clientSecret: 'sec',
      scopes: ['openid', 'email'],
    });
    const url = new URL(idp.authUrl({ state: 'abc', redirectUri: 'https://app/cb' }));
    expect(url.origin + url.pathname).toBe('https://idp.example/authorize');
  });

  it('authUrl incluye response_type=code', async () => {
    const idp = await OidcIdentityProvider.fromMetadata({
      metadata: {
        issuer: 'https://idp.example',
        authorization_endpoint: 'https://idp.example/authorize',
        token_endpoint: 'https://idp.example/token',
        jwks_uri: 'https://idp.example/jwks',
      },
      clientId: 'cid',
      clientSecret: 'sec',
      scopes: ['openid', 'email'],
    });
    const url = new URL(idp.authUrl({ state: 'xyz', redirectUri: 'https://app/cb' }));
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('exchangeCode reenvía el iss del callback: un IdP que lo anuncia (Google) acepta el login', async () => {
    const idp = await issAdvertisingIdp();
    await expect(
      idp.exchangeCode({ code: 'c', redirectUri: 'https://app/cb', iss: 'https://idp.example' }),
    ).resolves.toEqual({ email: 'ana@example.com' });
  });

  it('exchangeCode sin iss contra un IdP que lo anuncia falla (lo que rompía el login con Google)', async () => {
    const idp = await issAdvertisingIdp();
    await expect(idp.exchangeCode({ code: 'c', redirectUri: 'https://app/cb' })).rejects.toMatchObject({
      cause: { message: expect.stringContaining('"iss" (issuer) missing') },
    });
  });

  it('exchangeCode con un iss de otro issuer falla', async () => {
    const idp = await issAdvertisingIdp();
    await expect(
      idp.exchangeCode({ code: 'c', redirectUri: 'https://app/cb', iss: 'https://evil.example' }),
    ).rejects.toMatchObject({ cause: { message: expect.stringContaining('unexpected "iss"') } });
  });
});
