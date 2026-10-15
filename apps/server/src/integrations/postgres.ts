import { and, eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { tenant_integrations } from '../state/schema.js';
import {
  DEFAULT_TASK_SYSTEM,
  type IntegrationConfigAdmin,
  type IntegrationConfigStore,
  type IntegrationRef,
  type IntegrationRow,
} from './types.js';

export interface PostgresIntegrationConfigStoreOptions {
  databaseUrl: string;
  client?: Sql;
}

export class PostgresIntegrationConfigStore implements IntegrationConfigStore, IntegrationConfigAdmin {
  private readonly db: PostgresJsDatabase;
  private readonly client: Sql;

  constructor(opts: PostgresIntegrationConfigStoreOptions) {
    this.client = opts.client ?? postgres(opts.databaseUrl, { max: 5 });
    this.db = drizzle(this.client);
  }

  async close(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }

  private async row(tenantId: string, project: string) {
    const exact = await this.db
      .select()
      .from(tenant_integrations)
      .where(and(eq(tenant_integrations.tenant_id, tenantId), eq(tenant_integrations.project, project)))
      .limit(1);
    if (exact[0]) return exact[0];
    const fallback = await this.db
      .select()
      .from(tenant_integrations)
      .where(and(eq(tenant_integrations.tenant_id, tenantId), eq(tenant_integrations.project, '')))
      .limit(1);
    return fallback[0];
  }

  async getTaskSystemConfig(tenantId: string, project: string): Promise<IntegrationRef> {
    const r = await this.row(tenantId, project);
    return (r?.task_system as IntegrationRef | null) ?? DEFAULT_TASK_SYSTEM;
  }

  async getDocStoreConfig(tenantId: string, project: string): Promise<IntegrationRef | undefined> {
    const r = await this.row(tenantId, project);
    return (r?.doc_store as IntegrationRef | null) ?? undefined;
  }

  async getPrProviderConfig(tenantId: string, project: string): Promise<IntegrationRef | undefined> {
    const r = await this.row(tenantId, project);
    return (r?.pr_provider as IntegrationRef | null) ?? undefined;
  }

  async listIntegrations(tenantId: string): Promise<IntegrationRow[]> {
    const rows = await this.db
      .select()
      .from(tenant_integrations)
      .where(eq(tenant_integrations.tenant_id, tenantId));
    return rows.map((r) => ({
      tenant_id: r.tenant_id,
      project: r.project,
      config: {
        ...(r.task_system ? { task_system: r.task_system as IntegrationRef } : {}),
        ...(r.doc_store ? { doc_store: r.doc_store as IntegrationRef } : {}),
        ...(r.pr_provider ? { pr_provider: r.pr_provider as IntegrationRef } : {}),
      },
    }));
  }

  async upsertIntegration(row: IntegrationRow): Promise<void> {
    const values = {
      tenant_id: row.tenant_id,
      project: row.project,
      task_system: row.config.task_system ?? null,
      doc_store: row.config.doc_store ?? null,
      pr_provider: row.config.pr_provider ?? null,
      updated_at: new Date(),
    };
    await this.db
      .insert(tenant_integrations)
      .values(values)
      .onConflictDoUpdate({ target: [tenant_integrations.tenant_id, tenant_integrations.project], set: values });
  }

  async deleteIntegration(tenantId: string, project: string): Promise<boolean> {
    const deleted = await this.db
      .delete(tenant_integrations)
      .where(and(eq(tenant_integrations.tenant_id, tenantId), eq(tenant_integrations.project, project)))
      .returning({ p: tenant_integrations.project });
    return deleted.length > 0;
  }
}
