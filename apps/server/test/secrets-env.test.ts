import { afterEach, describe, expect, it } from 'vitest';
import { EnvSecretResolver } from '../src/secrets/env.js';
import { SecretResolutionError } from '../src/secrets/types.js';

describe('EnvSecretResolver', () => {
  afterEach(() => {
    delete process.env.SECRET_ADO_PAT;
  });

  it('maps aws-sm://<name> to SECRET_<NAME> env var', async () => {
    process.env.SECRET_ADO_PAT = 'pat-123';
    const r = new EnvSecretResolver();
    expect(await r.resolve('aws-sm://ado-pat')).toBe('pat-123');
  });

  it('extracts #key from a JSON secret', async () => {
    process.env.SECRET_ADO_PAT = JSON.stringify({ token: 'tok-9', other: 'x' });
    const r = new EnvSecretResolver();
    expect(await r.resolve('aws-sm://ado-pat#token')).toBe('tok-9');
  });

  it('throws SecretResolutionError when the env var is missing', async () => {
    const r = new EnvSecretResolver();
    await expect(r.resolve('aws-sm://ado-pat')).rejects.toBeInstanceOf(SecretResolutionError);
  });

  it('throws SecretResolutionError when env var is not JSON but a key is requested', async () => {
    process.env.SECRET_ADO_PAT = 'plain-not-json';
    const r = new EnvSecretResolver();
    await expect(r.resolve('aws-sm://ado-pat#token')).rejects.toBeInstanceOf(SecretResolutionError);
  });

  it('throws SecretResolutionError when the requested key is missing', async () => {
    process.env.SECRET_ADO_PAT = JSON.stringify({ other: 'x' });
    const r = new EnvSecretResolver();
    await expect(r.resolve('aws-sm://ado-pat#token')).rejects.toBeInstanceOf(SecretResolutionError);
  });

  it('throws SecretResolutionError on a secret-ref with an empty key', async () => {
    process.env.SECRET_ADO_PAT = 'pat-123';
    const r = new EnvSecretResolver();
    await expect(r.resolve('aws-sm://ado-pat#')).rejects.toBeInstanceOf(SecretResolutionError);
  });
});
