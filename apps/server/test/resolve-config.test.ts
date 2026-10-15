import { describe, expect, it } from 'vitest';
import { resolveEffectiveConfig } from '../src/config/resolve.js';
import { parseFileConfig } from '../src/config/file-config.js';
import type { Config } from '../src/config.js';
import type { SecretResolver } from '../src/secrets/types.js';

/** Env config con todo en su default (lo que da loadConfig() sin env vars). */
function envConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 3000,
    host: '0.0.0.0',
    logLevel: 'info',
    secretsBackend: 'env',
    oauthSigningSecret: '',
    publicUrl: 'http://localhost:3000',
    tenantId: 'default',
    adminEmails: '',
    allowedEmailDomains: '',
    sdlcConfigPath: './sdlc.config.yaml',
    ...overrides,
  } as Config;
}

const fakeResolver: SecretResolver = {
  resolve: async (ref) => `resolved:${ref}`,
};

describe('resolveEffectiveConfig', () => {
  it('sin archivo, usa los valores de env', async () => {
    const eff = await resolveEffectiveConfig({
      env: envConfig({ tenantId: 'acme', adminEmails: 'a@acme.com, b@acme.com' }),
      fileCfg: null,
      secretResolver: fakeResolver,
    });

    expect(eff.tenantId).toBe('acme');
    expect(eff.adminEmails).toEqual(['a@acme.com', 'b@acme.com']);
    expect(eff.sources.tenantId).toBe('env');
  });

  it('el archivo gana sobre env campo por campo', async () => {
    const eff = await resolveEffectiveConfig({
      env: envConfig({ tenantId: 'from-env', allowedEmailDomains: 'acme.com' }),
      fileCfg: parseFileConfig(`
tenantId: from-file
auth:
  allowedEmailDomains: [example.com]
`),
      secretResolver: fakeResolver,
    });

    expect(eff.tenantId).toBe('from-file');
    expect(eff.allowedEmailDomains).toEqual(['example.com']);
    expect(eff.sources.tenantId).toBe('file');
    expect(eff.sources.allowedEmailDomains).toBe('file');
  });

  it('env rellena los campos que el archivo omite', async () => {
    const eff = await resolveEffectiveConfig({
      env: envConfig({ tenantId: 'from-env', adminEmails: 'admin@acme.com' }),
      fileCfg: parseFileConfig('workspaces: [{ id: platform, name: Platform }]'),
      secretResolver: fakeResolver,
    });

    expect(eff.tenantId).toBe('from-env');
    expect(eff.adminEmails).toEqual(['admin@acme.com']);
    expect(eff.sources.adminEmails).toBe('env');
  });

  it('una lista vacía explícita en el archivo vence a la env var (sin restricción de dominio)', async () => {
    const eff = await resolveEffectiveConfig({
      env: envConfig({ allowedEmailDomains: 'acme.com' }),
      fileCfg: parseFileConfig(`
auth:
  allowedEmailDomains: []
`),
      secretResolver: fakeResolver,
    });

    expect(eff.allowedEmailDomains).toEqual([]);
    expect(eff.sources.allowedEmailDomains).toBe('file');
  });

  it('el bloque oidc del archivo gana entero y resuelve clientSecretRef', async () => {
    const eff = await resolveEffectiveConfig({
      env: envConfig({
        oidcDiscoveryUrl: 'https://env-idp.example.com',
        oidcClientId: 'env-client',
        oidcClientSecret: 'env-secret',
      }),
      fileCfg: parseFileConfig(`
auth:
  oidc:
    discoveryUrl: https://file-idp.example.com
    clientId: file-client
    clientSecretRef: aws-sm://sdlc/oidc#client_secret
    scopes: [openid, email, profile]
`),
      secretResolver: fakeResolver,
    });

    expect(eff.oidc).toEqual({
      discoveryUrl: 'https://file-idp.example.com',
      clientId: 'file-client',
      clientSecret: 'resolved:aws-sm://sdlc/oidc#client_secret',
      scopes: ['openid', 'email', 'profile'],
    });
    expect(eff.sources.oidc).toBe('file');
  });

  it('sin bloque oidc en el archivo, arma el provider desde env con scopes por default', async () => {
    const eff = await resolveEffectiveConfig({
      env: envConfig({
        oidcDiscoveryUrl: 'https://env-idp.example.com',
        oidcClientId: 'env-client',
        oidcClientSecret: 'env-secret',
      }),
      fileCfg: parseFileConfig('tenantId: acme'),
      secretResolver: fakeResolver,
    });

    expect(eff.oidc).toEqual({
      discoveryUrl: 'https://env-idp.example.com',
      clientId: 'env-client',
      clientSecret: 'env-secret',
      scopes: ['openid', 'email'],
    });
    expect(eff.sources.oidc).toBe('env');
  });

  it('mantiene el preset Google por backcompat cuando solo hay GOOGLE_CLIENT_ID/SECRET', async () => {
    const eff = await resolveEffectiveConfig({
      env: envConfig({ googleClientId: 'g-client', googleClientSecret: 'g-secret' }),
      fileCfg: null,
      secretResolver: fakeResolver,
    });

    expect(eff.oidc?.discoveryUrl).toBe('https://accounts.google.com');
    expect(eff.oidc?.clientId).toBe('g-client');
    expect(eff.oidc?.clientSecret).toBe('g-secret');
  });

  it('sin proveedor en ninguna fuente, oidc queda undefined', async () => {
    const eff = await resolveEffectiveConfig({
      env: envConfig(),
      fileCfg: null,
      secretResolver: fakeResolver,
    });

    expect(eff.oidc).toBeUndefined();
    expect(eff.sources.oidc).toBe('none');
  });
});
