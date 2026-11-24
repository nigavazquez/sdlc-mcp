import { and, eq, isNull } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { gate_leases } from '../state/schema.js';
import type { GateLease, GateLeaseKind, GateStore, IssueStoryLeaseInput } from './types.js';

export interface PostgresGateStoreOptions {
  databaseUrl: string;
  client?: Sql;
}

export class PostgresGateStore implements GateStore {
  private readonly db: PostgresJsDatabase;
  private readonly client: Sql;

  constructor(opts: PostgresGateStoreOptions) {
    this.client = opts.client ?? postgres(opts.databaseUrl, { max: 5 });
    this.db = drizzle(this.client);
  }

  async close(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }

  async issueStoryLease(input: IssueStoryLeaseInput): Promise<GateLease> {
    // Revocar y emitir en la misma transacción: dos claims concurrentes de la misma
    // story no pueden dejar dos leases vigentes.
    const row = await this.db.transaction(async (tx) => {
      await tx
        .update(gate_leases)
        .set({ revoked_at: new Date(input.created_at) })
        .where(
          and(
            eq(gate_leases.story_id, input.story_id),
            eq(gate_leases.kind, 'story'),
            isNull(gate_leases.revoked_at),
          ),
        );
      const inserted = await tx
        .insert(gate_leases)
        .values({
          lease_hash: input.lease_hash,
          tenant_id: input.tenant_id,
          workspace_id: input.workspace_id,
          kind: 'story',
          story_id: input.story_id,
          flow_id: input.flow_id,
          user_id: input.user_id,
          created_at: new Date(input.created_at),
          expires_at: new Date(input.expires_at),
        })
        .returning();
      return inserted[0]!;
    });
    return toLease(row);
  }

  async getLease(leaseHash: string): Promise<GateLease | undefined> {
    const rows = await this.db
      .select()
      .from(gate_leases)
      .where(eq(gate_leases.lease_hash, leaseHash))
      .limit(1);
    return rows[0] ? toLease(rows[0]) : undefined;
  }
}

function toLease(r: typeof gate_leases.$inferSelect): GateLease {
  return {
    lease_hash: r.lease_hash,
    tenant_id: r.tenant_id,
    workspace_id: r.workspace_id,
    kind: r.kind as GateLeaseKind,
    story_id: r.story_id,
    flow_id: r.flow_id,
    user_id: r.user_id,
    repo: r.repo,
    branch: r.branch,
    reason: r.reason,
    created_at: r.created_at.toISOString(),
    expires_at: r.expires_at.toISOString(),
    revoked_at: r.revoked_at ? r.revoked_at.toISOString() : null,
  };
}
