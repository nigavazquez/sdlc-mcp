import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { Catalog } from '@sdlc/catalog';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';
import { ConfigBackedTaskSystemProvider } from '../src/adapters/task-system-provider.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import { buildToolRegistry } from '../src/mcp/tools/index.js';
import { InMemoryGateStore, hashLeaseId } from '../src/gate/index.js';
import { testCtx } from './helpers/tenant-ctx.js';
import { seedFlowStatus } from './helpers/flow-status.js';

// Historia #7 (épica #5): `claim_story` emite el lease que el gate de los repos
// habilitados valida contra el server. Seam: la respuesta de la tool y el GateStore.

const ctx = (userId = 'alice'): TenantCtx =>
  testCtx({
    tenantId: 't1',
    userId,
    roles: ['developer'],
    workspaces: ['demo'],
    resolveSecret: async () => {
      throw new Error('no secrets');
    },
  });

type ClaimOut = {
  ok: boolean;
  error?: string;
  data?: Record<string, unknown> & { gate_lease?: { lease_id: string; expires_at: string } };
};

async function setup(gate: { enabled: boolean } | null = { enabled: true }) {
  const catalog = await Catalog.load(resolve(__dirname, '../../../packages/catalog'));
  const store = new InMemoryFlowStore();
  const taskSystem = new InMemoryTaskSystemAdapter();
  const taskSystemProvider = new ConfigBackedTaskSystemProvider({
    configStore: new InMemoryIntegrationConfigStore(),
    inMemory: taskSystem,
  });
  const gateStore = new InMemoryGateStore();
  const registry = buildToolRegistry({
    catalog,
    store,
    taskSystemProvider,
    ...(gate ? { gate: { store: gateStore, enabled: gate.enabled } } : {}),
  });

  const flow = await store.createFlow({
    tenant_id: 't1',
    project: 'demo',
    slug: 'gate',
    title: 'Gate',
  });
  await seedFlowStatus(store, flow.flow_id, {
    status: 'backlog_ready',
    current_phase: 'implementation',
  });
  const epic = await taskSystem.createEpic(
    { project_key: 'demo', title: 'E', description: 'x' },
    ctx(),
  );
  const ref = await taskSystem.createStory(
    {
      project_key: 'demo',
      epic_id: epic.external_id,
      title: 'S',
      description: 'd',
      acceptance_criteria: ['a'],
    },
    ctx(),
  );
  const story = await store.createStory({
    flow_id: flow.flow_id,
    external_id: ref.external_id,
    external_url: ref.url,
    title: 'S',
    acceptance_criteria: ['a'],
  });

  const claim = async (userId = 'alice') =>
    (await registry
      .get('claim_story')!
      .handler({ story_id: story.story_id, developer_id: userId }, ctx(userId))) as ClaimOut;

  return { claim, gateStore, flow, story };
}

describe('claim_story emite un gate_lease', () => {
  it('devuelve lease_id y expires_at, y el store guarda sólo el hash', async () => {
    const { claim, gateStore, flow, story } = await setup();
    const out = await claim();

    expect(out.ok).toBe(true);
    const lease = out.data?.gate_lease;
    expect(lease?.lease_id).toMatch(/^gl_[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(lease!.expires_at)).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);

    const row = await gateStore.getLease(hashLeaseId(lease!.lease_id));
    expect(row).toMatchObject({
      kind: 'story',
      tenant_id: 't1',
      workspace_id: 'demo',
      story_id: story.story_id,
      flow_id: flow.flow_id,
      user_id: 'alice',
      revoked_at: null,
      repo: null,
      branch: null,
    });
    // El secreto no se persiste en ninguna columna.
    expect(JSON.stringify(gateStore.dump())).not.toContain(lease!.lease_id);
  });

  it('un re-claim idempotente emite un lease nuevo y revoca el anterior', async () => {
    const { claim, gateStore } = await setup();
    const first = (await claim()).data!.gate_lease!;
    const second = await claim();

    expect(second.ok).toBe(true);
    expect(second.data?.idempotent).toBe(true);
    expect(second.data?.gate_lease?.lease_id).not.toBe(first.lease_id);

    expect((await gateStore.getLease(hashLeaseId(first.lease_id)))?.revoked_at).not.toBeNull();
    expect(
      (await gateStore.getLease(hashLeaseId(second.data!.gate_lease!.lease_id)))?.revoked_at,
    ).toBeNull();
  });

  it('un claim rechazado no emite lease', async () => {
    const { claim, gateStore } = await setup();
    await claim('alice');
    const out = await claim('bob');

    expect(out.ok).toBe(false);
    expect(gateStore.dump()).toHaveLength(1);
  });

  it('con el gate apagado no aparece gate_lease y el resto de la respuesta no cambia', async () => {
    const off = await setup({ enabled: false });
    const none = await setup(null);
    const withOff = await off.claim();
    const without = await none.claim();

    expect(withOff.ok).toBe(true);
    expect(withOff.data).not.toHaveProperty('gate_lease');
    expect(Object.keys(withOff.data!).sort()).toEqual(Object.keys(without.data!).sort());
    expect(off.gateStore.dump()).toHaveLength(0);
  });
});

describe('migración 0014 (gate)', () => {
  // Sin los comentarios: el encabezado documenta el rollback con un DROP.
  const sql = readFileSync(join(__dirname, '../migrations/0014_gate.sql'), 'utf8').replace(
    /^--.*$/gm,
    '',
  );

  it('crea gate_leases y gate_events', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "gate_leases"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "gate_events"/);
  });

  it('es aditiva: no toca tablas existentes', () => {
    expect(sql).not.toMatch(/DROP |ALTER TABLE/);
  });

  it('no tiene una columna para el lease en claro', () => {
    expect(sql).toMatch(/"lease_hash" text PRIMARY KEY/);
    expect(sql).not.toMatch(/"lease_id"/);
  });
});
