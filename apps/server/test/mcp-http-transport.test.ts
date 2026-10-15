import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { Catalog } from '@sdlc/catalog';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';
import { ConfigBackedTaskSystemProvider } from '../src/adapters/task-system-provider.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import { buildToolRegistry } from '../src/mcp/tools/index.js';
import { createOAuthBearerAuth } from '../src/auth/oauth-bearer.js';
import { signJwt } from '../src/oauth/crypto.js';
import { registerMcpTransport } from '../src/http/mcp-transport.js';
import { registerRateLimit, resolveRateLimitConfig } from '../src/http/rate-limit.js';

/**
 * El seam es el borde HTTP: entra un request JSON-RPC por `POST /mcp`, sale la respuesta
 * que ve un cliente MCP estándar. No se mira el transport del SDK por dentro ni el
 * `McpServer` —`buildMcpServer` ya lo cubre stdio—. Ver
 * docs/superpowers/specs/2026-09-14-mcp-streamable-http-design.md § Testing.
 */

const CATALOG_ROOT = resolve(__dirname, '../../../packages/catalog');
const PUBLIC_URL = 'https://sdlc.test';
const SIGNING_SECRET = 'sec';

function bearer(sub: string, overrides: Record<string, unknown> = {}) {
  const nowS = Math.floor(Date.now() / 1000);
  const token = signJwt(
    {
      iss: PUBLIC_URL,
      aud: 'sdlc-mcp',
      sub,
      tenant_id: 't1',
      roles: ['developer'],
      workspaces: { demo: ['developer'] },
      iat: nowS,
      exp: nowS + 3600,
      ...overrides,
    },
    SIGNING_SECRET,
  );
  return `Bearer ${token}`;
}

async function makeApp(opts: { rateLimit?: boolean } = {}): Promise<FastifyInstance> {
  const catalog = await Catalog.load(CATALOG_ROOT);
  const registry = buildToolRegistry({
    catalog,
    store: new InMemoryFlowStore(),
    taskSystemProvider: new ConfigBackedTaskSystemProvider({
      configStore: new InMemoryIntegrationConfigStore(),
      inMemory: new InMemoryTaskSystemAdapter(),
    }),
  });
  const authenticate = createOAuthBearerAuth(
    { signingSecret: SIGNING_SECRET, publicUrl: PUBLIC_URL },
    { resolve: async () => 'x' },
  );
  const app = Fastify();
  if (opts.rateLimit) registerRateLimit(app, { config: resolveRateLimitConfig({}) });
  registerMcpTransport(app, { registry, authenticate });
  await app.ready();
  return app;
}

let nextId = 1;
function rpc(app: FastifyInstance, method: string, params: unknown, auth?: string) {
  return app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(auth ? { authorization: auth } : {}),
    },
    payload: { jsonrpc: '2.0', id: nextId++, method, params },
  });
}

function callTool(app: FastifyInstance, name: string, args: unknown, auth: string) {
  return rpc(app, 'tools/call', { name, arguments: args }, auth);
}

/** El texto de la tool viene serializado en `content[0].text`; se parsea de vuelta. */
function toolPayload(body: string) {
  const msg = JSON.parse(body);
  return JSON.parse(msg.result.content[0].text);
}

describe('POST /mcp — Streamable HTTP, stateless', () => {
  // Fija que el ctx sobrevive los awaits del transport: si el SDK corriera la tool fuera
  // del `run` del AsyncLocalStorage, `resolveCtx` no encontraría ctx y esto falla (verificado
  // mutando el `run`). Lo que *no* puede fijar es un ctx compartido entre requests: con
  // `inject()` los requests no se intercalan dentro del handler. Esa garantía la da el ALS
  // por construcción — cada request tiene su propio contexto asíncrono —, no este test.
  it('whoami con dos tokens en paralelo: cada respuesta trae su propia identidad', async () => {
    const app = await makeApp();
    const users = Array.from({ length: 10 }, (_, i) => `user-${i}@example.com`);

    const responses = await Promise.all(
      users.map((u) => callTool(app, 'whoami', {}, bearer(u))),
    );

    responses.forEach((res, i) => {
      expect(res.statusCode).toBe(200);
      expect(toolPayload(res.body).data.user_id).toBe(users[i]);
    });
  });

  it('initialize negocia la versión del protocolo y anuncia tools', async () => {
    const app = await makeApp();
    const res = await rpc(
      app,
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
      bearer('ana@example.com'),
    );

    expect(res.statusCode).toBe(200);
    const msg = JSON.parse(res.body);
    expect(msg.result.protocolVersion).toBe('2025-06-18');
    expect(msg.result.capabilities.tools).toBeDefined();
    expect(msg.result.serverInfo.name).toBe('sdlc-mcp');
  });

  it('tools/list devuelve todo el registry con su JSON Schema', async () => {
    const app = await makeApp();
    const res = await rpc(app, 'tools/list', {}, bearer('ana@example.com'));

    expect(res.statusCode).toBe(200);
    const { tools } = JSON.parse(res.body).result;
    expect(tools.length).toBe(28);
    const startFlow = tools.find((t: { name: string }) => t.name === 'start_flow');
    expect(startFlow.inputSchema.type).toBe('object');
    expect(startFlow.inputSchema.required).toEqual(expect.arrayContaining(['project', 'title']));
  });

  it('tools/call de whoami lleva el ctx del token de punta a punta', async () => {
    const app = await makeApp();
    const res = await callTool(
      app,
      'whoami',
      {},
      bearer('qa@example.com', { roles: ['qa'], workspaces: { demo: ['qa'] } }),
    );

    const data = toolPayload(res.body).data;
    expect(data).toMatchObject({ tenant_id: 't1', user_id: 'qa@example.com', roles: ['qa'] });
  });

  it('sin Authorization: 401 con WWW-Authenticate, antes de tocar el transport', async () => {
    const app = await makeApp();
    const res = await rpc(app, 'tools/list', {});

    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe(
      `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`,
    );
  });

  it('con un token inválido: 401', async () => {
    const app = await makeApp();
    const res = await rpc(app, 'tools/list', {}, 'Bearer no-es-un-jwt');
    expect(res.statusCode).toBe(401);
  });

  it.each(['GET', 'DELETE'] as const)('%s /mcp: 405, el server es stateless', async (method) => {
    const app = await makeApp();
    const res = await app.inject({
      method,
      url: '/mcp',
      headers: { authorization: bearer('ana@example.com') },
    });

    expect(res.statusCode).toBe(405);
    expect(JSON.parse(res.body).error.message).toMatch(/stateless/i);
  });

  it('una tool que rechaza por guarda de negocio contesta por el protocolo, no con 500', async () => {
    const app = await makeApp();
    // `ajeno` no está entre los workspaces del token: la guarda de workspace rechaza.
    const res = await callTool(
      app,
      'start_flow',
      { project: 'ajeno', title: 'Una iniciativa', initiative_type: 'feature' },
      bearer('ana@example.com'),
    );

    expect(res.statusCode).toBe(200);
    const msg = JSON.parse(res.body);
    expect(msg.error).toBeUndefined();
    // La guarda devuelve `{ ok: false }`; por MCP eso tiene que llegar marcado como error
    // de la tool, o el cliente lo lee como éxito.
    expect(msg.result.isError).toBe(true);
    expect(toolPayload(res.body)).toMatchObject({ ok: false, error: expect.stringMatching(/ajeno/) });
  });

  it('un input que no pasa el schema contesta por el protocolo, no con 500', async () => {
    const app = await makeApp();
    const res = await callTool(app, 'start_flow', { project: 'demo' }, bearer('ana@example.com'));

    expect(res.statusCode).toBe(200);
    const msg = JSON.parse(res.body);
    expect(msg.result.isError).toBe(true);
    expect(msg.result.content[0].text).toMatch(/Input validation error/);
  });

  // El transport escribe sobre la respuesta cruda: lo que otros hooks dejaron con
  // `reply.header` no llega solo, y el cliente perdía los x-ratelimit-* del borde.
  it('los headers que pusieron los hooks previos llegan a la respuesta del transport', async () => {
    const app = await makeApp({ rateLimit: true });
    const res = await rpc(app, 'tools/list', {}, bearer('ana@example.com'));

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('240');
    expect(res.headers['x-ratelimit-remaining']).toBe('239');
  });
});
