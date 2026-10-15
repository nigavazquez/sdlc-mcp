/**
 * Env vars que pueden venir como **referencia** a un secreto en vez del valor.
 *
 * El deploy a prod es una EC2 con docker compose y los secretos en AWS Secrets
 * Manager, resueltos con el instance role. Sin esto, el único modo de que
 * `DATABASE_URL` u `OAUTH_SIGNING_SECRET` lleguen al proceso es un archivo `.env`
 * en la instancia con el valor en claro — exactamente lo que el modelo de secretos
 * del proyecto evita para las credenciales de los adapters (`aws-sm://<name>#<key>`,
 * resueltas on-demand).
 *
 * Así que estas cuatro aceptan la misma forma: si el valor **es** un secret-ref, se
 * resuelve al boot con el `SecretResolver` del deploy; si es un literal, no pasa nada.
 * Es la misma decisión que ya tomaba `auth.oidc.clientSecretRef` en `sdlc.config.yaml`,
 * extendida a lo que sólo existe como env var.
 *
 * Al boot se loguean los **nombres** de los campos resueltos, nunca los valores: un
 * deploy que arranca sin la credencial esperada tiene que ser evidente en el log.
 */
import type { Config } from '../config.js';
import type { SecretResolver } from '../secrets/types.js';

/**
 * Los campos que aceptan un secret-ref. Es una lista cerrada a propósito: que
 * cualquier env var se resuelva contra Secrets Manager convierte un typo en una
 * llamada a la API y hace imposible leer de un vistazo qué es secreto acá.
 */
export const SECRET_REF_FIELDS = [
  'databaseUrl',
  'oauthSigningSecret',
  'adminSessionSecret',
  'googleClientSecret',
  'oidcClientSecret',
] as const satisfies ReadonlyArray<keyof Config>;

export type SecretRefField = (typeof SECRET_REF_FIELDS)[number];

/** Prefijo de los secret-refs. Ver `secrets/types.ts` (`parseSecretRef`). */
const SECRET_REF_PREFIX = 'aws-sm://';

/** ¿Este valor es una referencia y no el secreto mismo? */
export function isSecretRef(value: string | undefined): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_REF_PREFIX);
}

export interface ResolvedConfigSecrets {
  config: Config;
  /** Campos que venían como referencia y se resolvieron. Sólo nombres. */
  resolved: SecretRefField[];
}

/**
 * Devuelve una copia de la config con los secret-refs resueltos a su valor.
 * Un campo ausente, vacío o literal queda intacto. Si la resolución falla, el
 * error sube: arrancar con media credencial es peor que no arrancar.
 */
export async function resolveConfigSecretRefs(
  config: Config,
  resolver: SecretResolver,
): Promise<ResolvedConfigSecrets> {
  const out: Config = { ...config };
  const resolved: SecretRefField[] = [];

  for (const field of SECRET_REF_FIELDS) {
    const value = config[field];
    if (!isSecretRef(value)) continue;
    out[field] = await resolver.resolve(value);
    resolved.push(field);
  }

  return { config: out, resolved };
}
