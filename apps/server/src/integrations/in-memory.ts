import {
  DEFAULT_TASK_SYSTEM,
  type IntegrationConfig,
  type IntegrationConfigAdmin,
  type IntegrationConfigStore,
  type IntegrationRef,
  type IntegrationRow,
} from './types.js';

/** In-memory config store for dev/tests. Empty by default → everything resolves to defaults. */
export class InMemoryIntegrationConfigStore implements IntegrationConfigStore, IntegrationConfigAdmin {
  private readonly rows = new Map<string, IntegrationConfig>();

  private key(tenantId: string, project: string): string {
    return `${tenantId}::${project}`;
  }

  /** Test/seed helper: set the config for a (tenant, project). project="" is the tenant default. */
  seed(tenantId: string, project: string, config: IntegrationConfig): void {
    this.rows.set(this.key(tenantId, project), config);
  }

  private lookup(tenantId: string, project: string): IntegrationConfig | undefined {
    return this.rows.get(this.key(tenantId, project)) ?? this.rows.get(this.key(tenantId, ''));
  }

  async getTaskSystemConfig(tenantId: string, project: string): Promise<IntegrationRef> {
    return this.lookup(tenantId, project)?.task_system ?? DEFAULT_TASK_SYSTEM;
  }

  async getDocStoreConfig(tenantId: string, project: string): Promise<IntegrationRef | undefined> {
    return this.lookup(tenantId, project)?.doc_store;
  }

  async getPrProviderConfig(tenantId: string, project: string): Promise<IntegrationRef | undefined> {
    return this.lookup(tenantId, project)?.pr_provider;
  }

  async listIntegrations(tenantId: string): Promise<IntegrationRow[]> {
    return [...this.rows.entries()]
      .filter(([k]) => k.startsWith(`${tenantId}::`))
      .map(([k, config]) => ({ tenant_id: tenantId, project: k.split('::')[1] ?? '', config }));
  }

  async upsertIntegration(row: IntegrationRow): Promise<void> {
    this.rows.set(this.key(row.tenant_id, row.project), row.config);
  }

  async deleteIntegration(tenantId: string, project: string): Promise<boolean> {
    return this.rows.delete(this.key(tenantId, project));
  }
}
