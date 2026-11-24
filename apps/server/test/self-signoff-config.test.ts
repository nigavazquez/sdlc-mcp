import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';
import { Catalog } from '@sdlc/catalog';
import { registerAdminRoutes } from '../src/admin/routes.js';
import { InMemoryAdminStore } from '../src/admin/in-memory.js';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import { InMemoryDirectoryStore } from '../src/oauth/directory-in-memory.js';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';
import { ConfigBackedTaskSystemProvider } from '../src/adapters/task-system-provider.js';
import { buildToolRegistry } from '../src/mcp/tools/index.js';
import { SESSION_COOKIE, createSession } from '../src/admin/auth.js';
import { DEFAULT_LABELS } from '../src/config/labels.js';
import { testCtx } from './helpers/tenant-ctx.js';

// Historia #21 (épica #20): configuración `self_signoff` por workspace.
// Seams: la migración, la ruta admin y las tools whoami / get_flow_state.

const SECRET = 'test-secret';
const cookie = `${SESSION_COOKIE}=${createSession(SECRET, undefined, Date.now(), { email: 'admin@example.com' })}`;

async function makeApp() {
  const app = Fastify();
  const adminStore = new InMemoryAdminStore();
  registerAdminRoutes(app, {
    adminStore,
    flowStore: new InMemoryFlowStore(),
    integrations: new InMemoryIntegrationConfigStore(),
    directory: new InMemoryDirectoryStore(),
    tenantId: 'default',
    sessionSecret: SECRET,
    labels: DEFAULT_LABELS,
  });
  await app.ready();
  await adminStore.createWorkspace({ workspace_id: 'demo', name: 'Demo' });
  return { app, adminStore };
}

const put = (
  app: Awaited<ReturnType<typeof makeApp>>['app'],
  body: unknown,
  headers = { cookie },
) =>
  app.inject({
    method: 'PUT',
    url: '/admin/api/workspaces/demo/settings',
    headers,
    payload: body as object,
  });

describe('migración 0015 (self_signoff)', () => {
  const sql = readFileSync(join(__dirname, '../migrations/0015_self_signoff.sql'), 'utf8').replace(
    /^--.*$/gm,
    '',
  );

  it('agrega self_signoff con default true, así los workspaces existentes quedan permitidos', () => {
    expect(sql).toMatch(
      /ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "self_signoff" boolean NOT NULL DEFAULT true/,
    );
  });

  it('crea workspace_settings_audit y no borra nada', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "workspace_settings_audit"/);
    expect(sql).not.toMatch(/DROP /);
  });

  it('un workspace nuevo nace con la firma propia permitida', async () => {
    const store = new InMemoryAdminStore();
    expect((await store.createWorkspace({ workspace_id: 'w', name: 'W' })).self_signoff).toBe(true);
  });
});

describe('PUT /admin/api/workspaces/:id/settings', () => {
  it('cambia el valor y audita actor, fecha, valor anterior y nuevo', async () => {
    const { app, adminStore } = await makeApp();
    const res = await put(app, { self_signoff: false });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ workspace_id: 'demo', self_signoff: false });
    expect((await adminStore.getWorkspace('demo'))?.self_signoff).toBe(false);

    const audit = await adminStore.listSettingsAudit('demo');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      workspace_id: 'demo',
      setting: 'self_signoff',
      old_value: true,
      new_value: false,
      actor: 'admin@example.com',
    });
    expect(Date.parse(audit[0]!.created_at)).not.toBeNaN();
  });

  it('repetir el mismo valor no agrega auditoría', async () => {
    const { app, adminStore } = await makeApp();
    await put(app, { self_signoff: false });
    await put(app, { self_signoff: false });
    expect(await adminStore.listSettingsAudit('demo')).toHaveLength(1);
  });

  it('sin sesión de admin responde 401 y no cambia nada', async () => {
    const { app, adminStore } = await makeApp();
    const res = await put(app, { self_signoff: false }, { cookie: '' });

    expect(res.statusCode).toBe(401);
    expect((await adminStore.getWorkspace('demo'))?.self_signoff).toBe(true);
    expect(await adminStore.listSettingsAudit('demo')).toHaveLength(0);
  });

  it('rechaza un body inválido y un workspace inexistente', async () => {
    const { app } = await makeApp();
    expect((await put(app, { self_signoff: 'no' })).statusCode).toBe(400);
    const missing = await app.inject({
      method: 'PUT',
      url: '/admin/api/workspaces/otro/settings',
      headers: { cookie },
      payload: { self_signoff: false },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('la lista de workspaces muestra el valor', async () => {
    const { app } = await makeApp();
    await put(app, { self_signoff: false });
    const list = await app.inject({
      method: 'GET',
      url: '/admin/api/workspaces',
      headers: { cookie },
    });
    expect(list.json().workspaces[0]).toMatchObject({ workspace_id: 'demo', self_signoff: false });
  });
});

describe('whoami y get_flow_state exponen self_signoff', () => {
  async function setup() {
    const catalog = await Catalog.load(resolve(__dirname, '../../../packages/catalog'));
    const store = new InMemoryFlowStore();
    const adminStore = new InMemoryAdminStore();
    await adminStore.createWorkspace({ workspace_id: 'demo', name: 'Demo' });
    await adminStore.createWorkspace({ workspace_id: 'equipo', name: 'Equipo' });
    await adminStore.setSelfSignoff('equipo', false, 'admin@example.com');
    const registry = buildToolRegistry({
      catalog,
      store,
      adminStore,
      taskSystemProvider: new ConfigBackedTaskSystemProvider({
        configStore: new InMemoryIntegrationConfigStore(),
        inMemory: new InMemoryTaskSystemAdapter(),
      }),
    });
    const ctx = testCtx({
      tenantId: 't1',
      userId: 'alice',
      roles: ['developer'],
      workspaces: ['demo', 'equipo', 'sin-registro'],
      resolveSecret: async () => {
        throw new Error('no secrets');
      },
    });
    return { registry, store, ctx };
  }

  it('whoami lista el valor de cada workspace del usuario; sin registro vale el default', async () => {
    const { registry, ctx } = await setup();
    const out = (await registry.get('whoami')!.handler({}, ctx)) as {
      data: { self_signoff: Record<string, boolean> };
    };
    expect(out.data.self_signoff).toEqual({ demo: true, equipo: false, 'sin-registro': true });
  });

  it('get_flow_state trae el valor del workspace del flow', async () => {
    const { registry, store, ctx } = await setup();
    const flow = await store.createFlow({
      tenant_id: 't1',
      project: 'equipo',
      slug: 's',
      title: 'T',
    });
    const out = (await registry.get('get_flow_state')!.handler({ flow_id: flow.flow_id }, ctx)) as {
      ok: boolean;
      data: { workspace: { self_signoff: boolean } };
    };
    expect(out.ok).toBe(true);
    expect(out.data.workspace).toEqual({ workspace_id: 'equipo', self_signoff: false });
  });
});
