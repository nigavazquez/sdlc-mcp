import { extractKey, parseSecretRef, SecretResolutionError, type SecretResolver } from './types.js';

/**
 * Dev/test resolver. Maps a secret-ref name to an env var: the name is
 * uppercased, non-alphanumerics become `_`, and prefixed with `SECRET_`.
 * e.g. `aws-sm://ado-pat#token` → reads `SECRET_ADO_PAT`, then JSON key `token`.
 */
export class EnvSecretResolver implements SecretResolver {
  async resolve(ref: string): Promise<string> {
    const { name, key } = parseSecretRef(ref);
    const envName = `SECRET_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    const raw = process.env[envName];
    if (raw === undefined) {
      throw new SecretResolutionError(`Env var ${envName} not set for secret-ref "${ref}"`);
    }
    return extractKey(raw, key, ref);
  }
}
