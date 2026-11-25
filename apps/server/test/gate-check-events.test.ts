import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { AuthError, type AuthRequestLike } from '../src/auth/oauth-bearer.js';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import {
  InMemoryGateStore,
  hashLeaseId,
  issueStoryLease,
  registerGateRoutes,
} from '../src/gate/index.js';
import { testCtx } from './helpers/tenant-ctx.js';
import { seedFlowStatus } from './helpers/flow-status.js';

// Historia #8 (épica #5). Seam: las rutas HTTP `POST /gate/v1/check` y
// `POST /gate/v1/events`, con un `authenticate` que traduce el bearer a un ctx.

const TOKENS: Record<string, TenantCtx> = {
  alice: testCtx({
    tenantId: 't1',
    userId: 'alice',
    roles: ['developer'],
    workspaces: ['demo', 'otro'],
  }),
  bob: testCtx({ tenantId: 't1', userId: 'bob', roles: ['developer'], workspaces: ['demo'] }),
  ajena: testCtx({ tenantId: 't1', userId: 'alice', roles: ['developer'], workspaces: ['otro'] }),
};

async function authenticate(req: AuthRequestLike): Promise<TenantCtx> {
  const token = String(req.headers['authorization'] ?? '').replace(/^Bearer /, '');
  const ctx = TOKENS[token];
  if (!ctx) throw new AuthError('Invalid access token', 401);
  return ctx;
}

const REPO = 'github.com/acme/app';
let app: FastifyInstance;
let gateStore: InMemoryGateStore;
let flowStore: InMemoryFlowStore;
let now: Date;

async function seedStory(status: 'claimed' | 'in_progress' | 'merged' | 'discarded' = 'claimed') {
  const flow = await flowStore.createFlow({
    tenant_id: 't1',
    project: 'demo',
    slug: `f${Math.random()}`,
    title: 'F',
  });
  await seedFlowStatus(flowStore, flow.flow_id, {
    status: 'backlog_ready',
    current_phase: 'implementation',
  });
  const story = await flowStore.createStory({
    flow_id: flow.flow_id,
    external_id: '1',
    external_url: 'https://example.org/1',
    title: 'S',
    acceptance_criteria: ['a'],
  });
  await flowStore.updateStory(story.story_id, { status, assignee: 'alice' });
  const grant = await issueStoryLease(
    gateStore,
    {
      tenantId: 't1',
      workspaceId: 'demo',
      storyId: story.story_id,
      flowId: flow.flow_id,
      userId: 'alice',
    },
    now,
  );
  return { flow, story, leaseId: grant.lease_id };
}

const check = (body: Record<string, unknown>, token = 'alice') =>
  app.inject({
    method: 'POST',
    url: '/gate/v1/check',
    headers: { authorization: `Bearer ${token}` },
    payload: { workspace: 'demo', repo: REPO, branch: 'feat/x', worktree: '/repo', ...body },
  });

beforeEach(async () => {
  now = new Date('2026-11-25T12:00:00Z');
  gateStore = new InMemoryGateStore();
  flowStore = new InMemoryFlowStore();
  app = Fastify({ logger: false });
  registerGateRoutes(app, { authenticate, gateStore, flowStore, now: () => now });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

describe('POST /gate/v1/check', () => {
  it('el primer check de un lease activo es válido y lo ata a repo y branch; otra branch → branch_mismatch', async () => {
    const { story, leaseId } = await seedStory();

    const first = await check({ lease_id: leaseId });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      ok: true,
      data: { valid: true, kind: 'story', story_id: story.story_id },
    });
    expect(gateStore.dump()[0]).toMatchObject({ repo: REPO, branch: 'feat/x' });

    const again = await check({ lease_id: leaseId });
    expect(again.json().data.valid).toBe(true);

    const other = await check({ lease_id: leaseId, branch: 'feat/otra' });
    expect(other.json()).toMatchObject({
      ok: true,
      data: { valid: false, reason: 'branch_mismatch' },
    });
    expect(other.json().data.next_step).toMatch(/branch/);
    expect(gateStore.dump()[0]!.branch).toBe('feat/x');
  });

  it('un check válido renueva el TTL a 7 días desde ahora', async () => {
    const { leaseId } = await seedStory();
    now = new Date('2026-11-27T12:00:00Z');
    const res = await check({ lease_id: leaseId });
    expect(res.json().data.valid_until).toBe('2026-12-04T12:00:00.000Z');
  });

  it.each(['merged', 'discarded'] as const)('story %s → story_inactive', async (status) => {
    const { leaseId } = await seedStory(status);
    expect((await check({ lease_id: leaseId })).json().data).toMatchObject({
      valid: false,
      reason: 'story_inactive',
    });
  });

  it('flow abortado → story_inactive', async () => {
    const { flow, leaseId } = await seedStory('in_progress');
    await seedFlowStatus(flowStore, flow.flow_id, {
      status: 'aborted',
      current_phase: 'implementation',
    });
    expect((await check({ lease_id: leaseId })).json().data.reason).toBe('story_inactive');
  });

  it('vencido → expired; revocado → revoked; otro workspace → workspace_mismatch; inventado → unknown', async () => {
    const { leaseId } = await seedStory();
    const hash = hashLeaseId(leaseId);

    expect((await check({ lease_id: leaseId, workspace: 'otro' })).json().data.reason).toBe(
      'workspace_mismatch',
    );
    expect((await check({ lease_id: 'gl_inventado' })).json().data.reason).toBe('unknown');

    gateStore.patch(hash, { expires_at: '2026-11-25T11:59:59.000Z' });
    expect((await check({ lease_id: leaseId })).json().data.reason).toBe('expired');

    gateStore.patch(hash, { revoked_at: '2026-11-25T11:00:00.000Z' });
    expect((await check({ lease_id: leaseId })).json().data.reason).toBe('revoked');
  });

  it('el lease de otra persona del mismo workspace no le sirve: unknown', async () => {
    const { leaseId } = await seedStory();
    expect((await check({ lease_id: leaseId }, 'bob')).json().data.reason).toBe('unknown');
    expect(gateStore.dump()[0]!.branch).toBeNull();
  });

  it('sin membresía al workspace: error y no se lee ni se escribe nada', async () => {
    const { leaseId } = await seedStory();
    const getLease = vi.spyOn(gateStore, 'getLease');
    const bind = vi.spyOn(gateStore, 'bindAndRenew');

    const res = await check({ lease_id: leaseId }, 'ajena');
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ ok: false, error: expect.stringMatching(/demo/) });
    expect(getLease).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  });

  it('sin token válido: 401', async () => {
    expect((await check({ lease_id: 'x' }, 'nadie')).statusCode).toBe(401);
  });

  it('pedido mal formado: 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/gate/v1/check',
      headers: { authorization: 'Bearer alice' },
      payload: { workspace: 'demo' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /gate/v1/events', () => {
  const events = (n: number, extra: Record<string, unknown> = {}) =>
    Array.from({ length: n }, (_, i) => ({
      kind: 'commit.allowed',
      branch: 'feat/x',
      at: `2026-11-25T11:00:${String(i % 60).padStart(2, '0')}Z`,
      ...extra,
    }));
  const send = (body: Record<string, unknown>, token = 'alice') =>
    app.inject({
      method: 'POST',
      url: '/gate/v1/events',
      headers: { authorization: `Bearer ${token}` },
      payload: { workspace: 'demo', repo: REPO, ...body },
    });

  it('un batch de 50 queda guardado, con lease_kind y story_id pero sin el lease_id', async () => {
    const { story, leaseId } = await seedStory();
    const res = await send({
      events: events(50, { lease_id: leaseId, detail: { tool: 'Bash', lease_id: leaseId } }),
    });

    expect(res.json()).toEqual({ ok: true, data: { stored: 50 } });
    const stored = gateStore.dumpEvents();
    expect(stored).toHaveLength(50);
    expect(stored[0]).toMatchObject({
      workspace_id: 'demo',
      user_id: 'alice',
      repo: REPO,
      kind: 'commit.allowed',
      lease_kind: 'story',
      story_id: story.story_id,
    });
    expect(JSON.stringify(stored)).not.toContain(leaseId);
  });

  it('más de 50 eventos o un tipo desconocido se rechazan sin guardar', async () => {
    expect((await send({ events: events(51) })).statusCode).toBe(400);
    expect((await send({ events: events(1, { kind: 'otra.cosa' }) })).statusCode).toBe(400);
    expect(gateStore.dumpEvents()).toHaveLength(0);
  });

  it('sin membresía al workspace: error y no se guarda nada', async () => {
    const insert = vi.spyOn(gateStore, 'insertEvents');
    const res = await send({ events: events(1) }, 'ajena');
    expect(res.statusCode).toBe(403);
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('logs del gate', () => {
  it('ni el check ni los eventos loguean el lease_id', async () => {
    const lines: string[] = [];
    await app.close();
    app = Fastify({ logger: { level: 'info', stream: { write: (l: string) => lines.push(l) } } });
    registerGateRoutes(app, { authenticate, gateStore, flowStore, now: () => now });
    await app.ready();

    const { leaseId } = await seedStory();
    await check({ lease_id: leaseId });
    await app.inject({
      method: 'POST',
      url: '/gate/v1/events',
      headers: { authorization: 'Bearer alice' },
      payload: {
        workspace: 'demo',
        repo: REPO,
        events: [{ kind: 'commit.allowed', lease_id: leaseId, at: now.toISOString() }],
      },
    });

    expect(lines.some((l) => l.includes('"evt":"gate.check"'))).toBe(true);
    expect(lines.some((l) => l.includes('"evt":"gate.events"'))).toBe(true);
    expect(lines.join('\n')).not.toContain(leaseId);
  });
});
