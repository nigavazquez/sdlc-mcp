import { afterEach, describe, expect, it } from 'vitest';
import { allowsUnscopedCtx, loadConfig } from '../src/config.js';

describe('loadConfig secretsBackend', () => {
  afterEach(() => {
    delete process.env.SECRETS_BACKEND;
  });

  it('defaults to "env"', () => {
    expect(loadConfig().secretsBackend).toBe('env');
  });

  it('reads SECRETS_BACKEND=aws', () => {
    process.env.SECRETS_BACKEND = 'aws';
    expect(loadConfig().secretsBackend).toBe('aws');
  });
});

describe('loadConfig defaults', () => {
  afterEach(() => {
    delete process.env.TENANT_ID;
    delete process.env.ALLOWED_EMAIL_DOMAINS;
  });

  it('tenantId defaults to "default" with empty env', () => {
    expect(loadConfig().tenantId).toBe('default');
  });

  it('allowedEmailDomains defaults to empty string (no domain restriction)', () => {
    expect(loadConfig().allowedEmailDomains).toBe('');
  });
});

describe('loadConfig allowUnscopedCtx (escape hatch de workspaces)', () => {
  afterEach(() => {
    delete process.env.SDLC_ALLOW_UNSCOPED_CTX;
  });

  it('apagado por default: sin el claim workspaces no se pasa', () => {
    expect(loadConfig().allowUnscopedCtx).toBe(false);
    expect(allowsUnscopedCtx()).toBe(false);
  });

  it('se prende sólo con "true" o "1" explícitos', () => {
    for (const raw of ['true', 'TRUE', ' true ', '1']) {
      process.env.SDLC_ALLOW_UNSCOPED_CTX = raw;
      expect(allowsUnscopedCtx(), `valor "${raw}"`).toBe(true);
      expect(loadConfig().allowUnscopedCtx, `valor "${raw}"`).toBe(true);
    }
  });

  it('cualquier otro valor lo deja apagado (un "false" no puede prenderlo por accidente)', () => {
    for (const raw of ['false', '0', 'yes', 'on', '']) {
      process.env.SDLC_ALLOW_UNSCOPED_CTX = raw;
      expect(allowsUnscopedCtx(), `valor "${raw}"`).toBe(false);
    }
  });
});
