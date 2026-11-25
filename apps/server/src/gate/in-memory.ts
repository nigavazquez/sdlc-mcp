import type {
  GateEventCounts,
  GateEventRow,
  GateLease,
  GateStore,
  IssueBypassLeaseInput,
  IssueStoryLeaseInput,
} from './types.js';

/** GateStore para dev y tests. Sin `await` entre revocar e insertar: es atómico. */
export class InMemoryGateStore implements GateStore {
  private readonly leases = new Map<string, GateLease>();
  private readonly events: GateEventRow[] = [];

  async issueStoryLease(input: IssueStoryLeaseInput): Promise<GateLease> {
    for (const [hash, lease] of this.leases) {
      if (
        lease.kind === 'story' &&
        lease.story_id === input.story_id &&
        lease.revoked_at === null
      ) {
        this.leases.set(hash, { ...lease, revoked_at: input.created_at });
      }
    }
    const lease: GateLease = {
      ...input,
      kind: 'story',
      repo: null,
      branch: null,
      reason: null,
      revoked_at: null,
    };
    this.leases.set(input.lease_hash, lease);
    return { ...lease };
  }

  async getLease(leaseHash: string): Promise<GateLease | undefined> {
    const lease = this.leases.get(leaseHash);
    return lease ? { ...lease } : undefined;
  }

  async bindAndRenew(
    leaseHash: string,
    binding: { repo: string; branch: string; expires_at: string },
  ): Promise<GateLease | undefined> {
    const lease = this.leases.get(leaseHash);
    if (!lease || lease.revoked_at !== null) return undefined;
    if (lease.repo !== null && lease.repo !== binding.repo) return undefined;
    if (lease.branch !== null && lease.branch !== binding.branch) return undefined;
    const updated = {
      ...lease,
      repo: binding.repo,
      branch: binding.branch,
      expires_at: binding.expires_at,
    };
    this.leases.set(leaseHash, updated);
    return { ...updated };
  }

  async insertEvents(rows: GateEventRow[]): Promise<void> {
    this.events.push(...rows.map((r) => ({ ...r, detail: { ...r.detail } })));
  }

  async issueBypassLease(input: IssueBypassLeaseInput, event: GateEventRow): Promise<GateLease> {
    const lease: GateLease = {
      ...input,
      kind: 'bypass',
      story_id: null,
      flow_id: null,
      revoked_at: null,
    };
    this.leases.set(input.lease_hash, lease);
    this.events.push({ ...event, detail: { ...event.detail } });
    return { ...lease };
  }

  async countEvents(
    tenantId: string,
    workspaceId: string,
    since: string,
  ): Promise<GateEventCounts> {
    const from = Date.parse(since);
    const rows = this.events.filter(
      (e) =>
        e.tenant_id === tenantId &&
        e.workspace_id === workspaceId &&
        Date.parse(e.created_at) >= from,
    );
    const count = (pred: (e: GateEventRow) => boolean) => rows.filter(pred).length;
    return {
      commits_allowed_story: count((e) => e.kind === 'commit.allowed' && e.lease_kind === 'story'),
      commits_allowed_bypass: count(
        (e) => e.kind === 'commit.allowed' && e.lease_kind === 'bypass',
      ),
      commits_blocked: count((e) => e.kind === 'commit.blocked'),
      edits_blocked: count((e) => e.kind === 'edit.blocked'),
      bypasses: count((e) => e.kind === 'bypass.created'),
    };
  }

  /** Helper de tests: pisa la fecha de los eventos (para probar `since`). */
  backdateEvents(createdAt: string): void {
    for (const e of this.events) e.created_at = createdAt;
  }

  /** Helper de tests: los eventos guardados. */
  dumpEvents(): GateEventRow[] {
    return this.events.map((e) => ({ ...e }));
  }

  /** Helper de tests: pisa campos de un lease (vencerlo, revocarlo). */
  patch(leaseHash: string, fields: Partial<GateLease>): void {
    const lease = this.leases.get(leaseHash);
    if (lease) this.leases.set(leaseHash, { ...lease, ...fields });
  }

  /** Helper de tests: todas las filas, como quedarían en la tabla. */
  dump(): GateLease[] {
    return [...this.leases.values()].map((l) => ({ ...l }));
  }
}
