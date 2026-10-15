import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { PostgresFlowStore } from '../src/state/postgres.js';
import { seedFlowStatus } from './helpers/flow-status.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Skip the whole suite when no test DB is provided. CI / dev without Postgres
// keeps passing; bring a Postgres up with `docker compose -f infra/compose.yml up postgres`
// and set TEST_DATABASE_URL=postgres://sdlc:sdlc@localhost:5432/sdlc_test to exercise it.
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '../migrations');

describeIfDb('PostgresFlowStore (integration)', () => {
  let store: PostgresFlowStore;
  let adminSql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    adminSql = postgres(TEST_DATABASE_URL!, { max: 1 });
    const entries = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of entries) {
      const ddl = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await adminSql.unsafe(ddl);
    }
    store = new PostgresFlowStore({ databaseUrl: TEST_DATABASE_URL! });
  });

  afterAll(async () => {
    if (store) await store.close();
    if (adminSql) await adminSql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await adminSql`TRUNCATE TABLE flow_events, flows, stories CASCADE`;
  });

  it('round-trips a flow through PRD → RFC', async () => {
    const flow = await store.createFlow({
      tenant_id: 'acme',
      project: 'checkout',
      slug: 'pago-en-cuotas',
      title: 'Pago en cuotas',
    });
    expect(flow.status).toBe('draft');
    expect(flow.current_phase).toBe('prd');

    await store.appendEvent({
      flow_id: flow.flow_id,
      type: 'flow.started',
      actor: 'camila',
      payload: { title: flow.title },
    });

    const afterPrd = await seedFlowStatus(store, flow.flow_id, {
      status: 'prd_ready',
      current_phase: 'rfc',
      prd_ref: { sha256: 'abc', repo_path: '/docs/prd/cuotas.md' },
    });
    expect(afterPrd.status).toBe('prd_ready');
    expect(afterPrd.prd_ref?.sha256).toBe('abc');

    await store.appendEvent({
      flow_id: flow.flow_id,
      type: 'prd.submitted',
      actor: 'camila',
      payload: { sha256: 'abc' },
    });
    await store.appendEvent({
      flow_id: flow.flow_id,
      type: 'rfc.submitted',
      actor: 'lucas',
      payload: { sha256: 'def' },
    });

    const events = await store.listEvents(flow.flow_id);
    expect(events.map((e) => e.type)).toEqual(['flow.started', 'prd.submitted', 'rfc.submitted']);

    const refetched = await store.getFlow(flow.flow_id);
    expect(refetched?.title).toBe('Pago en cuotas');
  });

  it('rejects events on unknown flows', async () => {
    await expect(
      store.appendEvent({
        flow_id: 'nope:nope:nope',
        type: 'flow.started',
        actor: 'mallory',
        payload: {},
      }),
    ).rejects.toThrow(/unknown flow/i);
  });

  it('listFlows scopes by tenant + project', async () => {
    await store.createFlow({ tenant_id: 'a', project: 'p1', slug: 's1', title: 'A1' });
    await store.createFlow({ tenant_id: 'a', project: 'p2', slug: 's2', title: 'A2' });
    await store.createFlow({ tenant_id: 'b', project: 'p1', slug: 's3', title: 'B1' });

    const aAll = await store.listFlows('a');
    expect(aAll.map((f) => f.title).sort()).toEqual(['A1', 'A2']);

    const aP1 = await store.listFlows('a', 'p1');
    expect(aP1.map((f) => f.title)).toEqual(['A1']);
  });

  it('assigns monotonic per-flow seq', async () => {
    const flow = await store.createFlow({
      tenant_id: 'acme',
      project: 'p',
      slug: 'seq',
      title: 'seq',
    });
    for (let i = 0; i < 5; i++) {
      await store.appendEvent({
        flow_id: flow.flow_id,
        type: 'progress.reported',
        actor: 'dev',
        payload: { i },
      });
    }
    const events = await store.listEvents(flow.flow_id);
    expect(events).toHaveLength(5);
    expect(events.every((e) => e.type === 'progress.reported')).toBe(true);
    expect(events.map((e) => (e.payload as { i: number }).i)).toEqual([0, 1, 2, 3, 4]);
  });

  it('persists architecture_mode, codebase_status, existing_repo across reads', async () => {
    const flow = await store.createFlow({
      tenant_id: 'demo-tenant',
      project: 'arch-test',
      slug: 'a',
      title: 'a',
    });
    await store.updateFlow(flow.flow_id, {
      architecture_mode: 'hybrid',
      codebase_status: 'existing',
      existing_repo: 'https://github.com/acme/x',
    });
    const fresh = await store.getFlow(flow.flow_id);
    expect(fresh?.architecture_mode).toBe('hybrid');
    expect(fresh?.codebase_status).toBe('existing');
    expect(fresh?.existing_repo).toBe('https://github.com/acme/x');
  });
});
