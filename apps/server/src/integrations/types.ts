/** A single integration's config: which adapter kind, which secret, and adapter-specific settings. */
export interface IntegrationRef {
  kind: string;
  secret_ref?: string;
  settings: Record<string, unknown>;
}

/** Full per-(tenant, project) integration config. Each field is optional; unset → default. */
export interface IntegrationConfig {
  task_system?: IntegrationRef;
  doc_store?: IntegrationRef;
  pr_provider?: IntegrationRef;
}

export const DEFAULT_TASK_SYSTEM: IntegrationRef = { kind: 'in-memory', settings: {} };

/**
 * Per-(tenant, project) integration config. Resolution always succeeds:
 * exact match → tenant default (project="") → hard-coded default.
 */
export interface IntegrationConfigStore {
  getTaskSystemConfig(tenantId: string, project: string): Promise<IntegrationRef>;
  getDocStoreConfig(tenantId: string, project: string): Promise<IntegrationRef | undefined>;
  getPrProviderConfig(tenantId: string, project: string): Promise<IntegrationRef | undefined>;
}

/** Fila completa de tenant_integrations, como la ve/edita el panel admin. */
export interface IntegrationRow {
  tenant_id: string;
  project: string;
  config: IntegrationConfig;
}

/** Write path del panel admin. Ambas impls (in-memory y Postgres) lo implementan. */
export interface IntegrationConfigAdmin {
  listIntegrations(tenantId: string): Promise<IntegrationRow[]>;
  /** La fila es canónica: providers omitidos quedan NULL (no merge). */
  upsertIntegration(row: IntegrationRow): Promise<void>;
  deleteIntegration(tenantId: string, project: string): Promise<boolean>;
}
