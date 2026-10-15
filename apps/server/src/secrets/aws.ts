import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { extractKey, parseSecretRef, SecretResolutionError, type SecretResolver } from './types.js';

export interface AwsSecretsManagerResolverOptions {
  client?: SecretsManagerClient;
  /** Cache TTL for fetched secret strings, in ms. Default 60s. */
  ttlMs?: number;
}

interface CacheEntry {
  value: string;
  expiresAt: number;
}

/**
 * Resolves secret-refs against AWS Secrets Manager. Caches the raw secret
 * string by name with a short TTL so repeated tool calls don't hammer the API.
 * Concurrent callers for the same uncached name share a single in-flight SDK
 * call. Errors are wrapped (never leaking the secret value) and never cached.
 */
export class AwsSecretsManagerResolver implements SecretResolver {
  private readonly client: SecretsManagerClient;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(opts: AwsSecretsManagerResolverOptions = {}) {
    this.client = opts.client ?? new SecretsManagerClient({});
    this.ttlMs = opts.ttlMs ?? 60_000;
  }

  async resolve(ref: string): Promise<string> {
    const { name, key } = parseSecretRef(ref);
    const raw = await this.fetchRaw(name, ref);
    return extractKey(raw, key, ref);
  }

  private fetchRaw(name: string, ref: string): Promise<string> {
    // 1. Fresh resolved entry?
    const cached = this.cache.get(name);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);

    // 2. In-flight promise already exists?
    const existing = this.inflight.get(name);
    if (existing) return existing;

    // 3. Start a new fetch, store it so concurrent callers share it.
    const promise = (async () => {
      let value: string | undefined;
      try {
        const out = await this.client.send(new GetSecretValueCommand({ SecretId: name }));
        value = out.SecretString;
      } catch (err) {
        throw new SecretResolutionError(
          `Failed to fetch secret for "${ref}": ${err instanceof Error ? err.name : String(err)}`,
        );
      }
      if (value === undefined) {
        throw new SecretResolutionError(`Secret "${name}" has no SecretString (binary not supported)`);
      }
      this.cache.set(name, { value, expiresAt: Date.now() + this.ttlMs });
      return value;
    })();

    this.inflight.set(name, promise);
    // Attach the cleanup without creating an unhandled rejection. We suppress
    // the error on the finally-chain copy; callers use `promise` directly.
    promise.finally(() => this.inflight.delete(name)).catch(() => undefined);

    return promise;
  }
}
