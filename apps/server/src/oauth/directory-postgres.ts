import { and, eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { workspace_members } from '../state/schema.js';
import { normalizeEmail, type DirectoryStore, type Membership } from './directory-store.js';

export interface PostgresDirectoryStoreOptions {
  databaseUrl: string;
  client?: Sql;
}

export class PostgresDirectoryStore implements DirectoryStore {
  private readonly db: PostgresJsDatabase;
  private readonly client: Sql;

  constructor(opts: PostgresDirectoryStoreOptions) {
    this.client = opts.client ?? postgres(opts.databaseUrl, { max: 5 });
    this.db = drizzle(this.client);
  }

  async close(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }

  private map(r: typeof workspace_members.$inferSelect): Membership {
    return {
      email: r.email,
      workspace_id: r.workspace_id,
      roles: r.roles as string[],
      created_at: r.created_at.toISOString(),
    };
  }

  async listMemberships(email: string): Promise<Membership[]> {
    const rows = await this.db
      .select()
      .from(workspace_members)
      .where(eq(workspace_members.email, normalizeEmail(email)));
    return rows.map((r) => this.map(r));
  }

  async listMembers(workspaceId: string): Promise<Membership[]> {
    const rows = await this.db.select().from(workspace_members).where(eq(workspace_members.workspace_id, workspaceId));
    return rows.map((r) => this.map(r));
  }

  async upsertMember(input: { email: string; workspace_id: string; roles: string[] }): Promise<Membership> {
    const values = { email: normalizeEmail(input.email), workspace_id: input.workspace_id, roles: input.roles };
    const [r] = await this.db
      .insert(workspace_members)
      .values(values)
      .onConflictDoUpdate({
        target: [workspace_members.email, workspace_members.workspace_id],
        set: { roles: values.roles },
      })
      .returning();
    return this.map(r!);
  }

  async removeMember(email: string, workspaceId: string): Promise<boolean> {
    const deleted = await this.db
      .delete(workspace_members)
      .where(and(eq(workspace_members.email, normalizeEmail(email)), eq(workspace_members.workspace_id, workspaceId)))
      .returning({ email: workspace_members.email });
    return deleted.length > 0;
  }
}
