import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AwsSecretsManagerResolver } from '../src/secrets/aws.js';
import { SecretResolutionError } from '../src/secrets/types.js';

const smMock = mockClient(SecretsManagerClient);

describe('AwsSecretsManagerResolver', () => {
  beforeEach(() => smMock.reset());

  it('resolves a plain secret string', async () => {
    smMock.on(GetSecretValueCommand, { SecretId: 'ado-pat' }).resolves({ SecretString: 'pat-123' });
    const r = new AwsSecretsManagerResolver();
    expect(await r.resolve('aws-sm://ado-pat')).toBe('pat-123');
  });

  it('extracts a #key from a JSON secret', async () => {
    smMock.on(GetSecretValueCommand, { SecretId: 'ado-pat' }).resolves({
      SecretString: JSON.stringify({ token: 'tok-9' }),
    });
    const r = new AwsSecretsManagerResolver();
    expect(await r.resolve('aws-sm://ado-pat#token')).toBe('tok-9');
  });

  it('caches by secret name (one SDK call for two resolves)', async () => {
    smMock.on(GetSecretValueCommand, { SecretId: 'ado-pat' }).resolves({ SecretString: 'pat-123' });
    const r = new AwsSecretsManagerResolver({ ttlMs: 60_000 });
    await r.resolve('aws-sm://ado-pat');
    await r.resolve('aws-sm://ado-pat');
    expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
  });

  it('wraps SDK errors in SecretResolutionError and does not cache them', async () => {
    smMock.on(GetSecretValueCommand).rejects(new Error('AccessDenied'));
    const r = new AwsSecretsManagerResolver();
    await expect(r.resolve('aws-sm://ado-pat')).rejects.toBeInstanceOf(SecretResolutionError);
    expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
  });

  it('refetches after the TTL elapses', async () => {
    vi.useFakeTimers();
    try {
      smMock.on(GetSecretValueCommand, { SecretId: 'ado-pat' }).resolves({ SecretString: 'pat-123' });
      const r = new AwsSecretsManagerResolver({ ttlMs: 1000 });
      await r.resolve('aws-sm://ado-pat');
      vi.advanceTimersByTime(1001);
      await r.resolve('aws-sm://ado-pat');
      expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('deduplicates concurrent resolves into a single SDK call', async () => {
    smMock.on(GetSecretValueCommand, { SecretId: 'ado-pat' }).resolves({ SecretString: 'pat-123' });
    const r = new AwsSecretsManagerResolver();
    const [a, b] = await Promise.all([r.resolve('aws-sm://ado-pat'), r.resolve('aws-sm://ado-pat')]);
    expect(a).toBe('pat-123');
    expect(b).toBe('pat-123');
    expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
  });
});
