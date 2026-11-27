/**
 * Respuesta de `GET /health` (RFC `cli-sdlc-server`).
 *
 * El endpoint es público: lo leen el healthcheck de compose, `sdlc server doctor`
 * y `upgrade` para esperar healthy. Por eso `setup` lleva **sólo booleanos**: le
 * dice al operador qué falta configurar sin exponer ningún valor, id ni secreto.
 */

export interface HealthSetup {
  /** El login OIDC tiene client id y secret. */
  oidc: boolean;
  /** Algún proyecto del tenant tiene doc store configurado. */
  docstore: boolean;
  /** Algún proyecto del tenant tiene PR provider configurado. */
  pr_provider: boolean;
  /** `PUBLIC_URL` es https. */
  https: boolean;
}

export interface Health {
  ok: true;
  catalog_version: string;
  store: string;
  /** Versión de la imagen (`SDLC_VERSION`, inyectada en el build); `dev` fuera de la imagen. */
  version: string;
  setup: HealthSetup;
}

/** Lo que el server sabe de su configuración, sin valores. */
export interface HealthInput {
  catalogVersion: string;
  storeKind: string;
  version?: string | undefined;
  publicUrl?: string | undefined;
  oidc?: { clientId?: string | undefined; clientSecret?: string | undefined } | null | undefined;
  /** Integraciones del tenant; sólo se mira si existe cada una. */
  integrations: ReadonlyArray<{ doc_store?: unknown; pr_provider?: unknown }>;
}

export function buildHealth(input: HealthInput): Health {
  return {
    ok: true,
    catalog_version: input.catalogVersion,
    store: input.storeKind,
    version: input.version?.trim() || 'dev',
    setup: {
      oidc: Boolean(input.oidc?.clientId && input.oidc?.clientSecret),
      docstore: input.integrations.some((i) => i.doc_store !== undefined && i.doc_store !== null),
      pr_provider: input.integrations.some((i) => i.pr_provider !== undefined && i.pr_provider !== null),
      https: (input.publicUrl ?? '').toLowerCase().startsWith('https://'),
    },
  };
}
