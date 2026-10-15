import { describe, expect, it } from 'vitest';
import { createSecretResolver } from '../src/secrets/index.js';
import { AwsSecretsManagerResolver } from '../src/secrets/aws.js';
import { EnvSecretResolver } from '../src/secrets/env.js';

describe('createSecretResolver', () => {
  it('returns EnvSecretResolver for backend "env"', () => {
    expect(createSecretResolver('env')).toBeInstanceOf(EnvSecretResolver);
  });

  it('returns AwsSecretsManagerResolver for backend "aws"', () => {
    expect(createSecretResolver('aws')).toBeInstanceOf(AwsSecretsManagerResolver);
  });
});
