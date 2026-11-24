import { asc, eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { groups, workspace_settings_audit, workspaces } from '../state/schema.js';
import type { AdminStore, GroupRecord, WorkspaceRecord, WorkspaceSettingAudit } from './store.js';

export interface PostgresAdminStoreOptions {
  databaseUrl: string;
  client?: Sql;
}

export class PostgresAdminStore implements AdminStore {
  private readonly db: PostgresJsDatabase;
  private readonly client: Sql;

  constructor(opts: PostgresAdminStoreOptions) {
    this.client = opts.client ?? postgres(opts.databaseUrl, { max: 5 });
    this.db = drizzle(this.client);
  }

  async close(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }

  private map(r: typeof workspaces.$inferSelect): WorkspaceRecord {
    return {
      workspace_id: r.workspace_id,
      name: r.name,
      ...(r.group_id ? { group_id: r.group_id } : {}),
      self_signoff: r.self_signoff,
      created_at: r.created_at.toISOString(),
    };
  }

  async setSelfSignoff(workspaceId: string, enabled: boolean, actor: string): Promise<WorkspaceRecord | undefined> {
    // Lectura con FOR UPDATE, update y auditoría en la misma transacción: dos admins que
    // cambian el valor a la vez no pueden dejar una auditoría con un old_value falso.
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.workspace_id, workspaceId))
        .for('update');
      if (!current) return undefined;
      if (current.self_signoff === enabled) return this.map(current);
      const [updated] = await tx
        .update(workspaces)
        .set({ self_signoff: enabled })
        .where(eq(workspaces.workspace_id, workspaceId))
        .returning();
      await tx.insert(workspace_settings_audit).values({
        workspace_id: workspaceId,
        setting: 'self_signoff',
        old_value: current.self_signoff,
        new_value: enabled,
        actor,
      });
      return this.map(updated!);
    });
  }

  async listSettingsAudit(workspaceId: string): Promise<WorkspaceSettingAudit[]> {
    const rows = await this.db
      .select()
      .from(workspace_settings_audit)
      .where(eq(workspace_settings_audit.workspace_id, workspaceId))
      .orderBy(asc(workspace_settings_audit.id));
    return rows.map((r) => ({
      workspace_id: r.workspace_id,
      setting: r.setting as 'self_signoff',
      old_value: r.old_value,
      new_value: r.new_value,
      actor: r.actor,
      created_at: r.created_at.toISOString(),
    }));
  }

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    const rows = await this.db.select().from(workspaces);
    return rows.map((r) => this.map(r));
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceRecord | undefined> {
    const [r] = await this.db.select().from(workspaces).where(eq(workspaces.workspace_id, workspaceId)).limit(1);
    return r ? this.map(r) : undefined;
  }

  async createWorkspace(input: { workspace_id: string; name: string; group_id?: string }): Promise<WorkspaceRecord> {
    if (await this.getWorkspace(input.workspace_id)) {
      throw new Error(`Workspace "${input.workspace_id}" already exists`);
    }
    const [r] = await this.db
      .insert(workspaces)
      .values({
        workspace_id: input.workspace_id,
        name: input.name,
        ...(input.group_id ? { group_id: input.group_id } : {}),
      })
      .returning();
    return this.map(r!);
  }

  private mapGroup(r: typeof groups.$inferSelect): GroupRecord {
    return {
      group_id: r.group_id,
      name: r.name,
      created_at: r.created_at.toISOString(),
    };
  }

  async listGroups(): Promise<GroupRecord[]> {
    const rows = await this.db.select().from(groups);
    return rows.map((r) => this.mapGroup(r));
  }

  async createGroup(input: { group_id: string; name: string }): Promise<GroupRecord> {
    const [r] = await this.db
      .insert(groups)
      .values({ group_id: input.group_id, name: input.name })
      .returning();
    return this.mapGroup(r!);
  }
}
