import { describe, expect, it } from 'vitest';
import { OidcIdentityProvider } from '../src/oauth/oidc.js';

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
});
