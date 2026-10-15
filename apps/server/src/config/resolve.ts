import type { Config } from '../config.js';
import type { SecretResolver } from '../secrets/types.js';
import type { FileConfig } from './file-config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** De dónde salió el valor efectivo de un campo. */
export type ConfigSource = 'file' | 'env' | 'none';

export interface EffectiveOidc {
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

export interface EffectiveConfig {
  tenantId: string;
  adminEmails: string[];
  allowedEmailDomains: string[];
  /** undefined => no hay proveedor configurado: /oauth/* responde 503. */
  oidc: EffectiveOidc | undefined;
  /** Qué fuente ganó cada campo. Se loguea al boot. */
  sources: {
    tenantId: ConfigSource;
    adminEmails: ConfigSource;
    allowedEmailDomains: ConfigSource;
    oidc: ConfigSource;
  };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Discovery del preset Google, para backcompat con GOOGLE_CLIENT_ID/SECRET. */
const GOOGLE_DISCOVERY_URL = 'https://accounts.google.com';

const DEFAULT_SCOPES = ['openid', 'email'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** CSV de env var → lista normalizada. */
function fromCsv(csv: string): string[] {
  return csv
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeList(values: string[]): string[] {
  return values.map((v) => v.trim().toLowerCase()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resuelve la configuración efectiva combinando el archivo (sdlc.config.yaml) y
 * las env vars.
 *
 * **Precedencia: el archivo gana campo por campo**; env rellena lo que el
 * archivo omite. Un campo presente pero vacío en el archivo (p. ej.
 * `allowedEmailDomains: []`) es una decisión explícita y también gana — por eso
 * esos campos son `optional` y no `.default()` en el schema.
 *
 * El bloque `auth.oidc` gana **entero**: mezclar mitades de dos fuentes es
 * imposible de debuggear. Su `clientSecretRef` se resuelve con el
 * `SecretResolver` del deploy, así que soporta `aws-sm://<name>#<key>`.
 */
export async function resolveEffectiveConfig(opts: {
  env: Config;
  fileCfg: FileConfig | null;
  secretResolver: SecretResolver;
}): Promise<EffectiveConfig> {
  const { env, fileCfg, secretResolver } = opts;

  const tenantIdFromFile = fileCfg?.tenantId;
  const adminEmailsFromFile = fileCfg?.adminEmails;
  const domainsFromFile = fileCfg?.auth?.allowedEmailDomains;

  const oidc = await resolveOidc(env, fileCfg, secretResolver);

  return {
    tenantId: tenantIdFromFile ?? env.tenantId,
    adminEmails: adminEmailsFromFile
      ? normalizeList(adminEmailsFromFile)
      : fromCsv(env.adminEmails),
    allowedEmailDomains: domainsFromFile
      ? normalizeList(domainsFromFile)
      : fromCsv(env.allowedEmailDomains),
    oidc: oidc.value,
    sources: {
      tenantId: tenantIdFromFile !== undefined ? 'file' : 'env',
      adminEmails: adminEmailsFromFile !== undefined ? 'file' : 'env',
      allowedEmailDomains: domainsFromFile !== undefined ? 'file' : 'env',
      oidc: oidc.source,
    },
  };
}

async function resolveOidc(
  env: Config,
  fileCfg: FileConfig | null,
  secretResolver: SecretResolver,
): Promise<{ value: EffectiveOidc | undefined; source: ConfigSource }> {
  const fromFile = fileCfg?.auth?.oidc;
  if (fromFile) {
    return {
      value: {
        discoveryUrl: fromFile.discoveryUrl,
        clientId: fromFile.clientId,
        clientSecret: await secretResolver.resolve(fromFile.clientSecretRef),
        scopes: fromFile.scopes.length > 0 ? fromFile.scopes : DEFAULT_SCOPES,
      },
      source: 'file',
    };
  }

  // Env: OIDC_* es la forma genérica; GOOGLE_* queda como preset por backcompat.
  const discoveryUrl =
    env.oidcDiscoveryUrl ?? (env.googleClientId ? GOOGLE_DISCOVERY_URL : undefined);
  const clientId = env.oidcClientId ?? env.googleClientId;
  const clientSecret = env.oidcClientSecret ?? env.googleClientSecret;

  if (discoveryUrl && clientId && clientSecret) {
    return {
      value: { discoveryUrl, clientId, clientSecret, scopes: DEFAULT_SCOPES },
      source: 'env',
    };
  }

  return { value: undefined, source: 'none' };
}
