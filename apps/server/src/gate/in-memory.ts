import type { GateLease, GateStore, IssueStoryLeaseInput } from './types.js';

/** GateStore para dev y tests. Sin `await` entre revocar e insertar: es atómico. */
export class InMemoryGateStore implements GateStore {
  private readonly leases = new Map<string, GateLease>();

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

  /** Helper de tests: todas las filas, como quedarían en la tabla. */
  dump(): GateLease[] {
    return [...this.leases.values()].map((l) => ({ ...l }));
  }
}
