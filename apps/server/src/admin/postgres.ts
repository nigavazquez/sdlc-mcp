import { eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { groups, workspaces } from '../state/schema.js';
import type { AdminStore, GroupRecord, WorkspaceRecord } from './store.js';

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
      created_at: r.created_at.toISOString(),
    };
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
