import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { AuthError, type AuthRequestLike } from '../src/auth/oauth-bearer.js';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import {
  InMemoryGateStore,
  hashLeaseId,
  registerGateRoutes,
  type GateEventKind,
} from '../src/gate/index.js';
import { testCtx } from './helpers/tenant-ctx.js';

// Historia #9 (épica #5). Seam: `POST /gate/v1/bypass` y
// `GET /gate/v1/workspaces/:workspace/summary`, más el check de un lease bypass.

const TOKENS: Record<string, TenantCtx> = {
  alice: testCtx({
    tenantId: 't1',
    userId: 'alice',
    roles: ['developer'],
    workspaces: ['demo', 'otro'],
  }),
  ajena: testCtx({ tenantId: 't1', userId: 'alice', roles: ['developer'], workspaces: ['otro'] }),
};
async function authenticate(req: AuthRequestLike): Promise<TenantCtx> {
  const ctx = TOKENS[String(req.headers['authorization'] ?? '').replace(/^Bearer /, '')];
  if (!ctx) throw new AuthError('Invalid access token', 401);
  return ctx;
}

const REPO = 'github.com/acme/app';
let app: FastifyInstance;
let gateStore: InMemoryGateStore;
let now: Date;

beforeEach(async () => {
  now = new Date('2026-11-25T12:00:00Z');
  gateStore = new InMemoryGateStore();
  app = Fastify({ logger: false });
  registerGateRoutes(app, {
    authenticate,
    gateStore,
    flowStore: new InMemoryFlowStore(),
    now: () => now,
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

const post = (url: string, payload: Record<string, unknown>, token = 'alice') =>
  app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload });
const bypass = (body: Record<string, unknown> = {}, token = 'alice') =>
  post(
    '/gate/v1/bypass',
    {
      workspace: 'demo',
      repo: REPO,
      branch: 'hotfix/x',
      reason: 'prod caído, fix urgente',
      ttl_minutes: 30,
      ...body,
    },
    token,
  );
const summary = (workspace = 'demo', since?: string, token = 'alice') =>
  app.inject({
    method: 'GET',
    url: `/gate/v1/workspaces/${workspace}/summary${since ? `?since=${encodeURIComponent(since)}` : ''}`,
    headers: { authorization: `Bearer ${token}` },
  });

describe('POST /gate/v1/bypass', () => {
  it('crea un lease bypass atado a repo y branch, con su evento bypass.created', async () => {
    const res = await bypass();
    expect(res.statusCode).toBe(200);
    const { lease_id, expires_at } = res.json().data;
    expect(lease_id).toMatch(/^gl_/);
    expect(expires_at).toBe('2026-11-25T12:30:00.000Z');

    const lease = await gateStore.getLease(hashLeaseId(lease_id));
    expect(lease).toMatchObject({
      kind: 'bypass',
      workspace_id: 'demo',
      user_id: 'alice',
      repo: REPO,
      branch: 'hotfix/x',
      reason: 'prod caído, fix urgente',
    });
    expect(gateStore.dumpEvents()).toEqual([
      expect.objectContaining({
        kind: 'bypass.created',
        lease_kind: 'bypass',
        reason: 'prod caído, fix urgente',
      }),
    ]);
    expect(JSON.stringify(gateStore.dumpEvents())).not.toContain(lease_id);
  });

  it('el lease bypass vale en el check desde su branch, no se renueva y vence a su hora', async () => {
    const { lease_id } = (await bypass()).json().data;
    const check = (branch: string) =>
      post('/gate/v1/check', { workspace: 'demo', lease_id, repo: REPO, branch, worktree: '/r' });

    expect((await check('hotfix/x')).json().data).toMatchObject({
      valid: true,
      kind: 'bypass',
      valid_until: '2026-11-25T12:30:00.000Z',
    });
    expect((await check('feat/otra')).json().data.reason).toBe('branch_mismatch');
    now = new Date('2026-11-25T12:31:00Z');
    expect((await check('hotfix/x')).json().data.reason).toBe('expired');
  });

  it.each([
    ['motivo de menos de 10 caracteres', { reason: 'urgente' }],
    ['motivo que sólo llega a 10 con espacios', { reason: '   corto   ' }],
    ['TTL de más de 120 minutos', { ttl_minutes: 121 }],
    ['TTL de 0', { ttl_minutes: 0 }],
    ['TTL no entero', { ttl_minutes: 1.5 }],
  ])('se rechaza un %s, sin crear nada', async (_name, body) => {
    const res = await bypass(body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/10 caracteres/);
    expect(gateStore.dump()).toHaveLength(0);
    expect(gateStore.dumpEvents()).toHaveLength(0);
  });

  it('120 minutos y 10 caracteres justos se aceptan', async () => {
    expect((await bypass({ ttl_minutes: 120, reason: 'diez letra' })).statusCode).toBe(200);
  });

  it('sin membresía al workspace no se crea nada', async () => {
    const res = await bypass({}, 'ajena');
    expect(res.statusCode).toBe(403);
    expect(gateStore.dump()).toHaveLength(0);
  });
});

describe('GET /gate/v1/workspaces/:workspace/summary', () => {
  /** Eventos ya registrados, con el lease_kind que el endpoint de eventos completa desde el lease. */
  async function seedEvents(
    workspace: string,
    kinds: Array<[GateEventKind, 'story' | 'bypass' | null]>,
  ) {
    await gateStore.insertEvents(
      kinds.map(([kind, lease_kind]) => ({
        tenant_id: 't1',
        workspace_id: workspace,
        user_id: 'alice',
        repo: REPO,
        branch: 'feat/x',
        kind,
        lease_kind,
        story_id: null,
        reason: null,
        detail: {},
        created_at: now.toISOString(),
      })),
    );
  }

  it('cuenta los eventos y calcula north_star_pct sólo para ese workspace', async () => {
    await seedEvents('demo', [
      ['commit.allowed', 'story'],
      ['commit.allowed', 'story'],
      ['commit.allowed', 'story'],
      ['commit.allowed', 'bypass'],
      ['commit.blocked', null],
      ['edit.blocked', null],
    ]);
    await bypass();
    await seedEvents('otro', [
      ['commit.allowed', 'bypass'],
      ['commit.blocked', null],
    ]);

    const res = await summary('demo');
    expect(res.json()).toEqual({
      ok: true,
      data: {
        commits_allowed_story: 3,
        commits_allowed_bypass: 1,
        commits_blocked: 1,
        edits_blocked: 1,
        bypasses: 1,
        north_star_pct: 75,
      },
    });
  });

  it('`since` deja afuera lo anterior; sin commits la North Star es 100', async () => {
    await seedEvents('demo', [['commit.allowed', 'bypass']]);
    gateStore.backdateEvents('2026-10-01T00:00:00.000Z');

    const res = await summary('demo', '2026-11-01T00:00:00Z');
    expect(res.json().data).toMatchObject({ commits_allowed_bypass: 0, north_star_pct: 100 });
    expect((await summary('demo', '2026-09-01T00:00:00Z')).json().data.north_star_pct).toBe(0);
  });

  it('sin membresía al workspace: 403', async () => {
    expect((await summary('demo', undefined, 'ajena')).statusCode).toBe(403);
  });

  it('`since` mal formado: 400', async () => {
    expect((await summary('demo', 'ayer')).statusCode).toBe(400);
  });
});
