import { and, eq, gte, isNull, or, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { gate_events, gate_leases } from '../state/schema.js';
import type {
  GateEventCounts,
  GateEventRow,
  GateLease,
  GateLeaseKind,
  GateStore,
  IssueBypassLeaseInput,
  IssueStoryLeaseInput,
} from './types.js';

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

  async bindAndRenew(
    leaseHash: string,
    binding: { repo: string; branch: string; expires_at: string },
  ): Promise<GateLease | undefined> {
    // Un solo UPDATE condicional: dos checks concurrentes desde branches distintas no
    // pueden atar el mismo lease a las dos.
    const rows = await this.db
      .update(gate_leases)
      .set({ repo: binding.repo, branch: binding.branch, expires_at: new Date(binding.expires_at) })
      .where(
        and(
          eq(gate_leases.lease_hash, leaseHash),
          isNull(gate_leases.revoked_at),
          or(isNull(gate_leases.repo), eq(gate_leases.repo, binding.repo)),
          or(isNull(gate_leases.branch), eq(gate_leases.branch, binding.branch)),
        ),
      )
      .returning();
    return rows[0] ? toLease(rows[0]) : undefined;
  }

  async insertEvents(rows: GateEventRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(gate_events).values(rows.map(toEventValues));
  }

  async issueBypassLease(input: IssueBypassLeaseInput, event: GateEventRow): Promise<GateLease> {
    // Lease y evento juntos: un bypass sin registro sería justo lo que el gate no permite.
    const row = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(gate_leases)
        .values({
          lease_hash: input.lease_hash,
          tenant_id: input.tenant_id,
          workspace_id: input.workspace_id,
          kind: 'bypass',
          user_id: input.user_id,
          repo: input.repo,
          branch: input.branch,
          reason: input.reason,
          created_at: new Date(input.created_at),
          expires_at: new Date(input.expires_at),
        })
        .returning();
      await tx.insert(gate_events).values(toEventValues(event));
      return inserted[0]!;
    });
    return toLease(row);
  }

  async countEvents(
    tenantId: string,
    workspaceId: string,
    since: string,
  ): Promise<GateEventCounts> {
    const n = (cond: ReturnType<typeof sql>) => sql<number>`count(*) filter (where ${cond})::int`;
    const rows = await this.db
      .select({
        commits_allowed_story: n(
          sql`${gate_events.kind} = 'commit.allowed' and ${gate_events.lease_kind} = 'story'`,
        ),
        commits_allowed_bypass: n(
          sql`${gate_events.kind} = 'commit.allowed' and ${gate_events.lease_kind} = 'bypass'`,
        ),
        commits_blocked: n(sql`${gate_events.kind} = 'commit.blocked'`),
        edits_blocked: n(sql`${gate_events.kind} = 'edit.blocked'`),
        bypasses: n(sql`${gate_events.kind} = 'bypass.created'`),
      })
      .from(gate_events)
      .where(
        and(
          eq(gate_events.tenant_id, tenantId),
          eq(gate_events.workspace_id, workspaceId),
          gte(gate_events.created_at, new Date(since)),
        ),
      );
    return rows[0]!;
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

function toEventValues(r: GateEventRow): typeof gate_events.$inferInsert {
  return {
    tenant_id: r.tenant_id,
    workspace_id: r.workspace_id,
    user_id: r.user_id,
    repo: r.repo,
    branch: r.branch,
    kind: r.kind,
    lease_kind: r.lease_kind,
    story_id: r.story_id,
    reason: r.reason,
    detail: r.detail,
    created_at: new Date(r.created_at),
  };
}
