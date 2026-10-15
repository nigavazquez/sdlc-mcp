import { describe, expect, it } from 'vitest';
import { isSecretRef, resolveConfigSecretRefs } from '../src/config/secret-env.js';
import type { Config } from '../src/config.js';
import type { SecretResolver } from '../src/secrets/types.js';

function envConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 3000,
    host: '0.0.0.0',
    logLevel: 'info',
    secretsBackend: 'aws',
    oauthSigningSecret: '',
    publicUrl: 'https://sdlc.example.com',
    tenantId: 'default',
    adminEmails: '',
    allowedEmailDomains: '',
    sdlcConfigPath: './sdlc.config.yaml',
    allowUnscopedCtx: false,
    ...overrides,
  } as Config;
}

const resolver: SecretResolver = {
  resolve: async (ref) => `valor-de:${ref}`,
};

describe('isSecretRef', () => {
  it('reconoce sólo el esquema aws-sm://', () => {
    expect(isSecretRef('aws-sm://sdlc/prod/db#url')).toBe(true);
    expect(isSecretRef('postgresql://sdlc:sdlc@postgres:5432/sdlc')).toBe(false);
    expect(isSecretRef('')).toBe(false);
    expect(isSecretRef(undefined)).toBe(false);
  });
});

describe('resolveConfigSecretRefs', () => {
  it('resuelve los campos que vienen como referencia', async () => {
    const { config, resolved } = await resolveConfigSecretRefs(
      envConfig({
        databaseUrl: 'aws-sm://sdlc/prod/db#url',
        oauthSigningSecret: 'aws-sm://sdlc/prod/oauth#signing_secret',
      }),
      resolver,
    );

    expect(config.databaseUrl).toBe('valor-de:aws-sm://sdlc/prod/db#url');
    expect(config.oauthSigningSecret).toBe('valor-de:aws-sm://sdlc/prod/oauth#signing_secret');
    expect(resolved).toEqual(['databaseUrl', 'oauthSigningSecret']);
  });

  it('deja los literales intactos y no llama al resolver', async () => {
    let calls = 0;
    const counting: SecretResolver = {
      resolve: async (ref) => {
        calls += 1;
        return ref;
      },
    };

    const { config, resolved } = await resolveConfigSecretRefs(
      envConfig({ databaseUrl: 'postgresql://sdlc:sdlc@postgres:5432/sdlc' }),
      counting,
    );

    expect(config.databaseUrl).toBe('postgresql://sdlc:sdlc@postgres:5432/sdlc');
    expect(resolved).toEqual([]);
    expect(calls).toBe(0);
  });

  it('no toca campos fuera de la lista cerrada', async () => {
    // publicUrl no es secreto: aunque alguien escriba una referencia ahí, se deja como está.
    const { config, resolved } = await resolveConfigSecretRefs(
      envConfig({ publicUrl: 'aws-sm://sdlc/prod/url#public' } as Partial<Config>),
      resolver,
    );

    expect(config.publicUrl).toBe('aws-sm://sdlc/prod/url#public');
    expect(resolved).toEqual([]);
  });

  it('propaga el error del resolver: arrancar con media credencial es peor que no arrancar', async () => {
    const failing: SecretResolver = {
      resolve: async () => {
        throw new Error('AccessDeniedException');
      },
    };

    await expect(
      resolveConfigSecretRefs(envConfig({ databaseUrl: 'aws-sm://sdlc/prod/db#url' }), failing),
    ).rejects.toThrow('AccessDeniedException');
  });
});
