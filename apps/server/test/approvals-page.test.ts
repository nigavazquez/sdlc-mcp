import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Flow } from '@sdlc/core';
import { Catalog } from '@sdlc/catalog';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { InMemoryDirectoryStore } from '../src/oauth/directory-in-memory.js';
import { InMemoryAdminStore } from '../src/admin/in-memory.js';
import { registerApprovalRoutes } from '../src/approvals/routes.js';
import { issueApprovalLink } from '../src/approvals/links.js';
import {
  APPROVER_COOKIE,
  createApproverSession,
  csrfToken,
} from '../src/approvals/session.js';
import { hashApprovalToken } from '../src/approvals/links.js';
import { createSession } from '../src/admin/auth.js';
import { registerOAuthRoutes } from '../src/oauth/routes.js';
import { InMemoryOAuthStore } from '../src/oauth/oauth-in-memory.js';
import { verifyState } from '../src/oauth/crypto.js';
import { buildToolRegistry } from '../src/mcp/tools/index.js';
import { InMemoryTaskSystemAdapter, ConfigBackedTaskSystemProvider } from '../src/adapters/index.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import { approvalPolicyFrom } from '../src/approvals/policy.js';
import { seedFlowStatus } from './helpers/flow-status.js';

/**
 * Historia A4 (#69): la página `/approve/{token}`. Seam: las rutas HTTP con
 * `app.inject`, el store en memoria y el directorio de membresías. La sesión de
 * aprobación se arma con `createApproverSession`, que es lo que deja el login OIDC.
 */

const SECRET = 's'.repeat(64);
const PM = 'pm@example.com';
const AUTOR = 'autor@example.com';
const SHA = 'a'.repeat(64);

interface Ctx {
  app: FastifyInstance;
  store: InMemoryFlowStore;
  directory: InMemoryDirectoryStore;
  admin: InMemoryAdminStore;
  flow: Flow;
  token: string;
}

async function setup(opts: { status?: 'prd_in_review' | 'rfc_in_review' } = {}): Promise<Ctx> {
  const store = new InMemoryFlowStore();
  const directory = new InMemoryDirectoryStore();
  const admin = new InMemoryAdminStore();
  await admin.createWorkspace({ workspace_id: 'p1', name: 'P1' });
  await directory.upsertMember({ email: PM, workspace_id: 'p1', roles: ['product-manager'] });
  await directory.upsertMember({ email: AUTOR, workspace_id: 'p1', roles: ['product-manager', 'tech-lead'] });
  await directory.upsertMember({ email: 'dev@example.com', workspace_id: 'p1', roles: ['developer'] });

  let flow = await store.createFlow({ tenant_id: 't1', project: 'p1', slug: 'mi-flow', title: 'Mi flow' });
  flow = await store.updateFlow(flow.flow_id, { prd_ref: { sha256: SHA, url: 'https://docs.example.com/prd' } });
  await store.appendEvent({ flow_id: flow.flow_id, type: 'prd.submitted', actor: AUTOR, payload: { sha256: SHA } });
  flow = await seedFlowStatus(store, flow.flow_id, { status: opts.status ?? 'prd_in_review', current_phase: 'prd' });

  const link = await issueApprovalLink({ store, flow, artifact: 'prd', requestedBy: AUTOR, publicUrl: 'https://sdlc.example.com' });
  const token = link.url.split('/approve/')[1]!;

  const app = Fastify();
  registerApprovalRoutes(app, { flowStore: store, directory, adminStore: admin, sessionSecret: SECRET });
  await app.ready();
  return { app, store, directory, admin, flow, token };
}

const cookieFor = (email: string) => `${APPROVER_COOKIE}=${createApproverSession(SECRET, email)}`;

async function post(c: Ctx, email: string, body: Record<string, string>) {
  return c.app.inject({
    method: 'POST',
    url: `/approve/${c.token}`,
    headers: { cookie: cookieFor(email), 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'test-ua' },
    payload: new URLSearchParams(body).toString(),
  });
}

const csrfFor = (c: Ctx, email: string) => csrfToken(SECRET, hashApprovalToken(c.token), email);

describe('GET /approve/{token}', () => {
  let c: Ctx;
  beforeEach(async () => {
    c = await setup();
  });

  it('GIVEN sin sesión WHEN abre el link THEN lo manda al login OIDC con el token para volver', async () => {
    const r = await c.app.inject({ method: 'GET', url: `/approve/${c.token}` });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(`/oauth/authorize?mode=approve&token=${c.token}`);
  });

  it('una sesión del panel admin no sirve como sesión de aprobación', async () => {
    const adminCookie = `${APPROVER_COOKIE}=${createSession(SECRET, undefined, Date.now(), { email: PM })}`;
    const r = await c.app.inject({ method: 'GET', url: `/approve/${c.token}`, headers: { cookie: adminCookie } });
    expect(r.statusCode).toBe(302);
  });

  it('con sesión y rol dueño muestra el documento, la versión y el formulario con CSRF', async () => {
    const r = await c.app.inject({ method: 'GET', url: `/approve/${c.token}`, headers: { cookie: cookieFor(PM) } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('https://docs.example.com/prd');
    expect(r.body).toContain(SHA.slice(0, 12));
    expect(r.body).toContain(`name="csrf" value="${csrfFor(c, PM)}"`);
    expect(r.body).toContain('name="slug"');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('sin el rol dueño: 403 y sin formulario', async () => {
    const r = await c.app.inject({ method: 'GET', url: `/approve/${c.token}`, headers: { cookie: cookieFor('dev@example.com') } });
    expect(r.statusCode).toBe(403);
    expect(r.body).toContain('product-manager');
    expect(r.body).not.toContain('<form');
  });

  it('a quien envió, sin firma propia en el workspace, no se le ofrece aprobar', async () => {
    await c.admin.setSelfSignoff('p1', false, 'admin@example.com');
    const r = await c.app.inject({ method: 'GET', url: `/approve/${c.token}`, headers: { cookie: cookieFor(AUTOR) } });
    expect(r.statusCode).toBe(403);
    expect(r.body).not.toContain('<form');
  });

  it('a quien envió, con firma propia permitida, se le ofrece aprobar marcado como firma propia', async () => {
    const r = await c.app.inject({ method: 'GET', url: `/approve/${c.token}`, headers: { cookie: cookieFor(AUTOR) } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('firma propia');
  });

  it('si el documento cambió desde el link: 409', async () => {
    await c.store.updateFlow(c.flow.flow_id, { prd_ref: { sha256: 'b'.repeat(64) } });
    const r = await c.app.inject({ method: 'GET', url: `/approve/${c.token}`, headers: { cookie: cookieFor(PM) } });
    expect(r.statusCode).toBe(409);
  });

  it('link vencido: 410; link desconocido o mal formado: 404', async () => {
    vi.useFakeTimers({ now: Date.now() + 8 * 24 * 60 * 60 * 1000 });
    try {
      const r = await c.app.inject({ method: 'GET', url: `/approve/${c.token}`, headers: { cookie: cookieFor(PM) } });
      expect(r.statusCode).toBe(410);
    } finally {
      vi.useRealTimers();
    }
    const otro = await c.app.inject({ method: 'GET', url: `/approve/${'x'.repeat(43)}`, headers: { cookie: cookieFor(PM) } });
    expect(otro.statusCode).toBe(404);
    const malo = await c.app.inject({ method: 'GET', url: '/approve/../../etc', headers: { cookie: cookieFor(PM) } });
    expect(malo.statusCode).toBe(404);
  });
});

describe('POST /approve/{token}', () => {
  let c: Ctx;
  beforeEach(async () => {
    c = await setup();
  });

  it('GIVEN rol dueño WHEN confirma con slug y CSRF THEN registra la aprobación y el flow avanza a prd_ready', async () => {
    const r = await post(c, PM, { csrf: csrfFor(c, PM), slug: 'mi-flow' });
    expect(r.statusCode, r.body).toBe(200);

    const [a] = await c.store.listApprovals(c.flow.flow_id);
    expect(a).toMatchObject({ artifact: 'prd', sha256: SHA, approved_by: PM, approver_roles: ['product-manager'], self_signed: false });
    const flow = await c.store.getFlow(c.flow.flow_id);
    expect(flow?.status).toBe('prd_ready');
    expect(flow?.current_phase).toBe('rfc');
    const ev = (await c.store.listEvents(c.flow.flow_id)).find((e) => e.type === 'approval.granted');
    expect(ev?.payload).toMatchObject({ artifact: 'prd', approved_by: PM, self_signed: false, user_agent: 'test-ua' });
    expect(JSON.stringify(ev)).not.toContain(c.token);
  });

  it('la firma propia queda marcada', async () => {
    const r = await post(c, AUTOR, { csrf: csrfFor(c, AUTOR), slug: 'mi-flow' });
    expect(r.statusCode).toBe(200);
    expect((await c.store.listApprovals(c.flow.flow_id))[0]?.self_signed).toBe(true);
  });

  it('el link sirve una sola vez: el segundo POST responde 410 y no registra otra aprobación', async () => {
    expect((await post(c, PM, { csrf: csrfFor(c, PM), slug: 'mi-flow' })).statusCode).toBe(200);
    const again = await post(c, PM, { csrf: csrfFor(c, PM), slug: 'mi-flow' });
    expect(again.statusCode).toBe(410);
    expect(await c.store.listApprovals(c.flow.flow_id)).toHaveLength(1);
  });

  it('dos POST simultáneos: uno solo aprueba', async () => {
    const [a, b] = await Promise.all([
      post(c, PM, { csrf: csrfFor(c, PM), slug: 'mi-flow' }),
      post(c, PM, { csrf: csrfFor(c, PM), slug: 'mi-flow' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 410]);
    expect(await c.store.listApprovals(c.flow.flow_id)).toHaveLength(1);
  });

  it('sin CSRF, con CSRF de otra persona o con el slug mal: no aprueba y el link sigue sirviendo', async () => {
    expect((await post(c, PM, { slug: 'mi-flow' })).statusCode).toBe(403);
    expect((await post(c, PM, { csrf: csrfFor(c, AUTOR), slug: 'mi-flow' })).statusCode).toBe(403);
    expect((await post(c, PM, { csrf: csrfFor(c, PM), slug: 'otro' })).statusCode).toBe(400);
    expect(await c.store.listApprovals(c.flow.flow_id)).toEqual([]);
    expect((await post(c, PM, { csrf: csrfFor(c, PM), slug: 'mi-flow' })).statusCode).toBe(200);
  });

  it('sin rol dueño: 403; documento cambiado: 409; sin firma propia permitida: 403', async () => {
    expect((await post(c, 'dev@example.com', { csrf: csrfFor(c, 'dev@example.com'), slug: 'mi-flow' })).statusCode).toBe(403);
    await c.admin.setSelfSignoff('p1', false, 'admin@example.com');
    expect((await post(c, AUTOR, { csrf: csrfFor(c, AUTOR), slug: 'mi-flow' })).statusCode).toBe(403);
    await c.store.updateFlow(c.flow.flow_id, { prd_ref: { sha256: 'b'.repeat(64) } });
    expect((await post(c, PM, { csrf: csrfFor(c, PM), slug: 'mi-flow' })).statusCode).toBe(409);
    expect(await c.store.listApprovals(c.flow.flow_id)).toEqual([]);
  });

  it('un flow que ya no está en revisión registra la aprobación pero no retrocede ni salta de estado', async () => {
    await seedFlowStatus(c.store, c.flow.flow_id, { status: 'rfc_ready', current_phase: 'shaping' });
    const r = await post(c, PM, { csrf: csrfFor(c, PM), slug: 'mi-flow' });
    expect(r.statusCode).toBe(200);
    expect((await c.store.getFlow(c.flow.flow_id))?.status).toBe('rfc_ready');
  });

  it('el RFC aprobado lleva el flow a rfc_ready / shaping', async () => {
    const store = c.store;
    await store.updateFlow(c.flow.flow_id, { rfc_ref: { sha256: 'c'.repeat(64) } });
    await store.appendEvent({ flow_id: c.flow.flow_id, type: 'rfc.submitted', actor: AUTOR, payload: {} });
    const flow = await seedFlowStatus(store, c.flow.flow_id, { status: 'rfc_in_review', current_phase: 'rfc' });
    await c.directory.upsertMember({ email: 'tl@example.com', workspace_id: 'p1', roles: ['tech-lead'] });
    const link = await issueApprovalLink({ store, flow, artifact: 'rfc', requestedBy: AUTOR, publicUrl: '' });
    const token = link.url.split('/approve/')[1]!;
    const r = await c.app.inject({
      method: 'POST',
      url: `/approve/${token}`,
      headers: { cookie: cookieFor('tl@example.com'), 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ csrf: csrfToken(SECRET, hashApprovalToken(token), 'tl@example.com'), slug: 'mi-flow' }).toString(),
    });
    expect(r.statusCode, r.body).toBe(200);
    expect((await store.getFlow(c.flow.flow_id))?.status).toBe('rfc_ready');
    expect((await store.getFlow(c.flow.flow_id))?.current_phase).toBe('shaping');
  });
});

describe('login OIDC para aprobar', () => {
  it('/oauth/authorize?mode=approve redirige al IdP con el token en el state, y rechaza tokens mal formados', async () => {
    const app = Fastify();
    let authState = '';
    registerOAuthRoutes(app, {
      oauthStore: new InMemoryOAuthStore(),
      directory: new InMemoryDirectoryStore(),
      idp: {
        authUrl: ({ state }: { state: string }) => {
          authState = state;
          return `https://idp.example.com/auth?state=${state}`;
        },
        exchangeCode: async () => ({ email: PM }),
      } as never,
      config: {
        publicUrl: 'https://sdlc.example.com',
        tenantId: 't1',
        signingSecret: 'k'.repeat(64),
        allowedEmailDomains: [],
        adminEmails: [],
        adminSessionSecret: SECRET,
        secureCookies: true,
      },
    });
    await app.ready();
    const token = 'A'.repeat(43);
    const r = await app.inject({ method: 'GET', url: `/oauth/authorize?mode=approve&token=${token}` });
    expect(r.statusCode).toBe(302);
    expect(verifyState(authState, 'k'.repeat(64))).toMatchObject({ mode: 'approve', token });

    const bad = await app.inject({ method: 'GET', url: '/oauth/authorize?mode=approve&token=https://evil.example.com' });
    expect(bad.statusCode).toBe(400);

    // Vuelta del IdP: deja la sesión de aprobación (Path=/approve) y vuelve al link.
    const cb = await app.inject({ method: 'GET', url: `/oauth/callback?code=c&state=${encodeURIComponent(authState)}` });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe(`/approve/${token}`);
    const setCookie = String(cb.headers['set-cookie']);
    expect(setCookie).toContain(`${APPROVER_COOKIE}=`);
    expect(setCookie).toContain('Path=/approve');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
  });
});

describe('ninguna tool MCP registra una aprobación', () => {
  const TOOLS_DIR = resolve(__dirname, '../src/mcp/tools');

  it('ningún archivo de las tools llama a recordApproval', () => {
    for (const f of readdirSync(TOOLS_DIR).filter((x) => x.endsWith('.ts'))) {
      expect(readFileSync(join(TOOLS_DIR, f), 'utf8'), f).not.toMatch(/recordApproval|consumeApprovalRequest/);
    }
  });

  it('recorriendo todas las tools del registry, con un flow en revisión, ninguna registra una aprobación', async () => {
    const store = new InMemoryFlowStore();
    const record = vi.spyOn(store, 'recordApproval');
    const consume = vi.spyOn(store, 'consumeApprovalRequest');
    const catalog = await Catalog.load(resolve(__dirname, '../../../packages/catalog'));
    const registry = buildToolRegistry({
      catalog,
      store,
      taskSystemProvider: new ConfigBackedTaskSystemProvider({
        configStore: new InMemoryIntegrationConfigStore(),
        inMemory: new InMemoryTaskSystemAdapter(),
      }),
      approvals: approvalPolicyFrom(['*']),
    });
    const flow = await store.createFlow({ tenant_id: 'default', project: 'p1', slug: 'f', title: 'F' });
    await store.updateFlow(flow.flow_id, { prd_ref: { sha256: SHA } });
    await seedFlowStatus(store, flow.flow_id, { status: 'prd_in_review', current_phase: 'prd' });
    const { testCtx } = await import('./helpers/tenant-ctx.js');
    const ctx = testCtx({
      tenantId: 'default',
      userId: PM,
      roles: ['product-manager', 'tech-lead', 'pmo', 'developer', 'qa', 'reviewer'],
      workspaces: ['p1'],
      resolveSecret: async () => 'x',
    });
    const inputs = [
      {},
      { flow_id: flow.flow_id },
      { flow_id: flow.flow_id, artifact: 'prd' },
      { flow_id: flow.flow_id, outcome: 'approved' },
      { story_id: `${flow.flow_id}::1` },
    ];
    let llamadas = 0;
    for (const tool of registry.list()) {
      for (const input of inputs) {
        const parsed = tool.inputSchema.safeParse(input);
        if (!parsed.success) continue;
        llamadas++;
        await tool.handler(parsed.data, ctx).catch(() => undefined);
      }
    }
    expect(llamadas).toBeGreaterThan(5);
    expect(record).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect((await store.getFlow(flow.flow_id))?.status).toBe('prd_in_review');
  });
});
