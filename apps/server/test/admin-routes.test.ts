import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerAdminRoutes } from '../src/admin/routes.js';
import { InMemoryAdminStore } from '../src/admin/in-memory.js';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import { InMemoryDirectoryStore } from '../src/oauth/directory-in-memory.js';
import { SESSION_COOKIE, createSession } from '../src/admin/auth.js';
import { DEFAULT_LABELS } from '../src/config/labels.js';
import type { Labels } from '../src/config/labels.js';

const SECRET = 'test-secret';
const TENANT = 'default';

async function makeApp(opts: { labels?: Labels } = {}) {
  const app = Fastify();
  const adminStore = new InMemoryAdminStore();
  const flowStore = new InMemoryFlowStore();
  const integrations = new InMemoryIntegrationConfigStore();
  const directory = new InMemoryDirectoryStore();
  const labels = opts.labels ?? DEFAULT_LABELS;
  registerAdminRoutes(app, { adminStore, flowStore, integrations, directory, tenantId: TENANT, sessionSecret: SECRET, labels });
  await app.ready();
  return { app, adminStore, flowStore, integrations, directory };
}

/** El login real es vía Google (/oauth); acá se arma la cookie de sesión directo. */
const cookie = `${SESSION_COOKIE}=${createSession(SECRET, undefined, Date.now(), { email: 'admin@example.com' })}`;

describe('GET /admin/api/meta', () => {
  it('returns configured labels when custom labels are provided', async () => {
    const customLabels: Labels = {
      workspace: { singular: 'squad', plural: 'squads' },
      group: { singular: 'tribe', plural: 'tribes' },
    };
    const { app } = await makeApp({ labels: customLabels });
    const res = await app.inject({ method: 'GET', url: '/admin/api/meta' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.labels).toEqual(customLabels);
    expect(body.labels.workspace.singular).toBe('squad');
    expect(body.labels.workspace.plural).toBe('squads');
    expect(body.labels.group.singular).toBe('tribe');
    expect(body.labels.group.plural).toBe('tribes');
  });

  it('returns default labels when no FileConfig is provided', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/admin/api/meta' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.labels).toEqual({
      workspace: { singular: 'workspace', plural: 'workspaces' },
      group: { singular: 'group', plural: 'groups' },
    });
  });

  it('is public — no session required', async () => {
    const { app } = await makeApp();
    // No cookie header — should still return 200
    const res = await app.inject({ method: 'GET', url: '/admin/api/meta' });
    expect(res.statusCode).toBe(200);
  });
});

describe('admin routes (sesión Google)', () => {
  it('guard rejects without/with-invalid cookie; /me returns session email', async () => {
    const { app } = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/admin/api/workspaces' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/admin/api/workspaces',
          headers: { cookie: `${SESSION_COOKIE}=garbage.token` },
        })
      ).statusCode,
    ).toBe(401);
    const me = await app.inject({ method: 'GET', url: '/admin/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe('admin@example.com');
  });

  it('workspaces: create + list (with member/integration counts) + 409 duplicate', async () => {
    const { app, directory } = await makeApp();
    const created = await app.inject({
      method: 'POST',
      url: '/admin/api/workspaces',
      headers: { cookie },
      payload: { workspace_id: 'platform', name: 'Platform' },
    });
    expect(created.statusCode).toBe(201);
    await directory.upsertMember({ email: 'dev@example.com', workspace_id: 'platform', roles: ['developer'] });
    const dup = await app.inject({
      method: 'POST',
      url: '/admin/api/workspaces',
      headers: { cookie },
      payload: { workspace_id: 'platform', name: 'x' },
    });
    expect(dup.statusCode).toBe(409);
    const list = await app.inject({ method: 'GET', url: '/admin/api/workspaces', headers: { cookie } });
    expect(list.json().workspaces[0]).toMatchObject({ workspace_id: 'platform', members: 1, integrations: 0 });
  });

  it('workspaces: create with group_id persiste el campo (round-trip via store)', async () => {
    const { app, adminStore } = await makeApp();
    const created = await app.inject({
      method: 'POST',
      url: '/admin/api/workspaces',
      headers: { cookie },
      payload: { workspace_id: 'platform', name: 'Platform', group_id: 'tribe-a' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().workspace).toMatchObject({ workspace_id: 'platform', group_id: 'tribe-a' });
    // El body threadea group_id desde CreateWorkspaceBody hasta el store.
    expect((await adminStore.getWorkspace('platform'))?.group_id).toBe('tribe-a');
  });

  it('members: put agrega la membresía puntual (no muda), get lista, delete borra; 404s', async () => {
    const { app, directory } = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/admin/api/workspaces',
      headers: { cookie },
      payload: { workspace_id: 'platform', name: 'Platform' },
    });
    await app.inject({
      method: 'POST',
      url: '/admin/api/workspaces',
      headers: { cookie },
      payload: { workspace_id: 'planning', name: 'Planning' },
    });
    const badRole = await app.inject({
      method: 'PUT',
      url: '/admin/api/workspaces/platform/members/dev%40example.com',
      headers: { cookie },
      payload: { roles: ['sysadmin'] },
    });
    expect(badRole.statusCode).toBe(400);
    const put = await app.inject({
      method: 'PUT',
      url: '/admin/api/workspaces/platform/members/Dev%40Example.com',
      headers: { cookie },
      payload: { roles: ['developer', 'qa'] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().member).toMatchObject({ email: 'dev@example.com', workspace_id: 'platform', roles: ['developer', 'qa'] });

    // La misma persona en otro workspace: es una membresía distinta, no muda a la anterior.
    await app.inject({
      method: 'PUT',
      url: '/admin/api/workspaces/planning/members/dev%40example.com',
      headers: { cookie },
      payload: { roles: ['qa'] },
    });
    expect((await directory.listMemberships('dev@example.com'))).toHaveLength(2);

    const list = await app.inject({ method: 'GET', url: '/admin/api/workspaces/platform/members', headers: { cookie } });
    expect(list.json().members).toHaveLength(1);
    const unknownWorkspace = await app.inject({
      method: 'PUT',
      url: '/admin/api/workspaces/nope/members/x%40example.com',
      headers: { cookie },
      payload: { roles: ['developer'] },
    });
    expect(unknownWorkspace.statusCode).toBe(404);
    const del = await app.inject({
      method: 'DELETE',
      url: '/admin/api/workspaces/platform/members/dev%40example.com',
      headers: { cookie },
    });
    expect(del.statusCode).toBe(200);
    // Borró sólo la membresía de platform; sigue en planning.
    expect((await directory.listMemberships('dev@example.com'))).toHaveLength(1);
    const delAgain = await app.inject({
      method: 'DELETE',
      url: '/admin/api/workspaces/platform/members/dev%40example.com',
      headers: { cookie },
    });
    expect(delAgain.statusCode).toBe(404);
  });

  it('api-keys endpoints are gone', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/admin/api/workspaces/platform/api-keys', headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });

  it('integration: una config por workspace — put valida con zod, get devuelve, delete borra', async () => {
    const { app } = await makeApp();
    await app.inject({
      method: 'POST',
      url: '/admin/api/workspaces',
      headers: { cookie },
      payload: { workspace_id: 'platform', name: 'Platform' },
    });
    const empty = await app.inject({ method: 'GET', url: '/admin/api/workspaces/platform/integration', headers: { cookie } });
    expect(empty.json().integration).toBeNull();

    const bad = await app.inject({
      method: 'PUT',
      url: '/admin/api/workspaces/platform/integration',
      headers: { cookie },
      payload: { task_system: { settings: {} } },
    });
    expect(bad.statusCode).toBe(400);
    const put = await app.inject({
      method: 'PUT',
      url: '/admin/api/workspaces/platform/integration',
      headers: { cookie },
      payload: { task_system: { kind: 'azure-devops', secret_ref: 'aws-sm://pat', settings: { project: 'Demo' } } },
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: '/admin/api/workspaces/platform/integration', headers: { cookie } });
    expect(get.json().integration).toMatchObject({ tenant_id: TENANT, project: 'platform' });
    expect(get.json().integration.config.task_system.kind).toBe('azure-devops');
    const del = await app.inject({
      method: 'DELETE',
      url: '/admin/api/workspaces/platform/integration',
      headers: { cookie },
    });
    expect(del.statusCode).toBe(200);
  });

  it('flows: list por workspace (con initiative_type) y detalle con stories + events; 404 unknown flow', async () => {
    const { app, flowStore } = await makeApp();
    const flow = await flowStore.createFlow({
      tenant_id: TENANT,
      project: 'platform',
      slug: 's',
      title: 'Epic',
      initiative_type: 'feature',
    });
    await flowStore.appendEvent({ flow_id: flow.flow_id, type: 'flow.started', actor: 'pam', payload: {} });
    const list = await app.inject({ method: 'GET', url: '/admin/api/workspaces/platform/flows', headers: { cookie } });
    expect(list.json().flows).toHaveLength(1);
    expect(list.json().flows[0].initiative_type).toBe('feature');
    const detail = await app.inject({ method: 'GET', url: `/admin/api/flows/${flow.flow_id}`, headers: { cookie } });
    expect(detail.json().events).toHaveLength(1);
    const missing = await app.inject({ method: 'GET', url: '/admin/api/flows/nope', headers: { cookie } });
    expect(missing.statusCode).toBe(404);
  });

  it('logout clears the cookie', async () => {
    const { app } = await makeApp();
    const out = await app.inject({ method: 'POST', url: '/admin/api/logout', headers: { cookie } });
    expect(out.headers['set-cookie']).toMatch(/Max-Age=0/);
  });
});
