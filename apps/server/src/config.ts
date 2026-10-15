import { z } from 'zod';

const ConfigSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  host: z.string().default('0.0.0.0'),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  catalogRoot: z.string().optional(),
  /**
   * If set, PostgresFlowStore is used. If unset, InMemoryFlowStore is used (dev/tests/demos).
   * Migrations must be applied beforehand via `pnpm db:migrate`.
   */
  databaseUrl: z.string().url().optional(),
  /**
   * Secrets backend to use for resolving secret references.
   * 'env' reads from environment variables (dev/tests). 'aws' uses AWS Secrets Manager.
   */
  secretsBackend: z.enum(['aws', 'env']).default('env'),
  /**
   * OIDC provider configuration (generic). If set, the server uses a generic OIDC broker.
   * Backcompat: GOOGLE_CLIENT_ID/SECRET still work as a Google OIDC preset.
   */
  oidcDiscoveryUrl: z.string().url().optional(),
  oidcClientId: z.string().optional(),
  oidcClientSecret: z.string().optional(),
  /** Backcompat: OAuth client de Google ("Web application"); sin esto /oauth/* responde 503. */
  googleClientId: z.string().optional(),
  googleClientSecret: z.string().optional(),
  /** Firma HS256 de los access tokens propios y del state OAuth. Requerido para el MCP. */
  oauthSigningSecret: z.string().default(''),
  /** URL pública del server: issuer OAuth y base de los redirect URIs. */
  publicUrl: z.string().url().default('http://localhost:3000'),
  /** Tenant fijo del deploy. Los workspaces son el eje real del modelo (ver 0009_workspaces). */
  tenantId: z.string().default('default'),
  /** Emails con acceso al panel admin (CSV). */
  adminEmails: z.string().default(''),
  /** Dominios de email permitidos (CSV). Vacío = sin restricción (cualquier email verificado). */
  allowedEmailDomains: z.string().default(''),
  /** Secreto HMAC de la cookie de sesión. Si falta, se genera uno random por proceso (las sesiones caen al reiniciar). */
  adminSessionSecret: z.string().optional(),
  /** Directorio del build del SPA admin. Default: apps/admin/dist relativo al server. */
  adminUiDir: z.string().optional(),
  /** Ruta al archivo de configuración de estructura (sdlc.config.yaml). Default: ./sdlc.config.yaml */
  sdlcConfigPath: z.string().default('./sdlc.config.yaml'),
  /**
   * SÓLO TESTS Y DESARROLLO LOCAL. Deja pasar un ctx sin el claim `workspaces` por las
   * guardas de workspace (`assertWorkspaceAccess`). Apagado por default y así tiene que
   * quedar en cualquier deploy compartido: prendido, un access token válidamente firmado
   * pero sin el claim —uno emitido antes de que el claim existiera, o un refresh token
   * viejo de 30 días— pasa todas las guardas de workspace.
   * Se activa sólo con SDLC_ALLOW_UNSCOPED_CTX="true" o "1" explícitos.
   */
  allowUnscopedCtx: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Booleano de env estricto: sólo "true"/"1" (case-insensitive) prenden el flag. */
function parseBoolEnv(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === 'true' || v === '1';
}

/**
 * Lectura puntual del escape hatch de workspaces, sin parsear toda la config.
 * Las guardas la llaman en cada chequeo (no se cachea) para que un test pueda
 * prenderla y apagarla sin reiniciar el proceso.
 * Ver `allowUnscopedCtx` en ConfigSchema para el porqué de que esté apagado por default.
 */
export function allowsUnscopedCtx(): boolean {
  return parseBoolEnv(process.env.SDLC_ALLOW_UNSCOPED_CTX);
}

export function loadConfig(): Config {
  return ConfigSchema.parse({
    port: process.env.PORT,
    host: process.env.HOST,
    logLevel: process.env.LOG_LEVEL,
    catalogRoot: process.env.CATALOG_ROOT,
    databaseUrl: process.env.DATABASE_URL,
    secretsBackend: process.env.SECRETS_BACKEND,
    oidcDiscoveryUrl: process.env.OIDC_DISCOVERY_URL,
    oidcClientId: process.env.OIDC_CLIENT_ID,
    oidcClientSecret: process.env.OIDC_CLIENT_SECRET,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    oauthSigningSecret: process.env.OAUTH_SIGNING_SECRET,
    publicUrl: process.env.PUBLIC_URL,
    tenantId: process.env.TENANT_ID,
    adminEmails: process.env.ADMIN_EMAILS,
    allowedEmailDomains: process.env.ALLOWED_EMAIL_DOMAINS,
    adminSessionSecret: process.env.ADMIN_SESSION_SECRET,
    adminUiDir: process.env.ADMIN_UI_DIR,
    sdlcConfigPath: process.env.SDLC_CONFIG,
    allowUnscopedCtx: allowsUnscopedCtx(),
  });
}


