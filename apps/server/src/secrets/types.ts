/** Resolves an opaque secret-ref (e.g. `aws-sm://ado-pat#token`) to a concrete string. */
export interface SecretResolver {
  resolve(ref: string): Promise<string>;
}

export class SecretResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretResolutionError';
  }
}

/**
 * Parses a secret-ref of the form `<scheme>://<name>[#<key>]`.
 * Returns the secret name and optional JSON key. The scheme is informational
 * only — every resolver decides how to fetch by `name`.
 */
export function parseSecretRef(ref: string): { name: string; key?: string } {
  const withoutScheme = ref.includes('://') ? ref.slice(ref.indexOf('://') + 3) : ref;
  const hashIndex = withoutScheme.indexOf('#');
  const name = hashIndex === -1 ? withoutScheme : withoutScheme.slice(0, hashIndex);
  if (!name) throw new SecretResolutionError(`Malformed secret-ref: "${ref}"`);
  if (hashIndex === -1) return { name };
  const key = withoutScheme.slice(hashIndex + 1);
  if (!key) throw new SecretResolutionError(`Empty key in secret-ref: "${ref}"`);
  return { name, key };
}

/** Extracts `key` from a JSON secret string, or returns the raw value when no key. */
export function extractKey(raw: string, key: string | undefined, ref: string): string {
  if (!key) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SecretResolutionError(`Secret for "${ref}" is not JSON but a #key was requested`);
  }
  const value = (parsed as Record<string, unknown>)[key];
  if (typeof value !== 'string') {
    throw new SecretResolutionError(`Key "${key}" missing or non-string in secret for "${ref}"`);
  }
  return value;
}
