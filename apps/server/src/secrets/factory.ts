import { AwsSecretsManagerResolver } from './aws.js';
import { EnvSecretResolver } from './env.js';
import type { SecretResolver } from './types.js';

export type SecretsBackend = 'aws' | 'env';

export function createSecretResolver(backend: SecretsBackend): SecretResolver {
  return backend === 'aws' ? new AwsSecretsManagerResolver() : new EnvSecretResolver();
}
