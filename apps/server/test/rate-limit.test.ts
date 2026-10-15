import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerRateLimit, resolveRateLimitConfig } from '../src/http/rate-limit.js';
import type { RateLimitConfig } from '../src/http/rate-limit.js';
import { SESSION_COOKIE, createSession } from '../src/admin/auth.js';

/**
 * El seam es el borde HTTP: qué status y qué headers ve el cliente. Nada de
 * asomarse al contador por dentro — el contador es implementación y va a cambiar
 * (hoy ventana fija en memoria, mañana quizá Redis si el deploy deja de ser una
 * sola instancia).
 */
async function makeApp(cfg: Partial<RateLimitConfig> = {}, now?: () => number) {
  const app: FastifyInstance = Fastify();
  const base = resolveRateLimitConfig({});
  registerRateLimit(app, { config: { ...base, ...cfg }, now });
  app.get('/health', async () => ({ ok: true }));
  app.post('/mcp/tools/whoami', async () => ({ ok: true }));
  app.get('/admin/api/meta', async () => ({ ok: true }));
  app.post('/oauth/token', async () => ({ ok: true }));
  app.get('/.well-known/mcp', async () => ({ ok: true }));
  await app.ready();
  return app;
}

const TOKEN_A = 'Bearer token-de-ana';
const TOKEN_B = 'Bearer token-de-beto';

function mcpCall(app: FastifyInstance, opts: { auth?: string; ip?: string } = {}) {
  return app.inject({
    method: 'POST',
    url: '/mcp/tools/whoami',
    headers: opts.auth ? { authorization: opts.auth } : {},
    remoteAddress: opts.ip ?? '10.0.0.1',
    payload: {},
  });
}

describe('rate limit — el borde HTTP', () => {
  it('deja pasar mientras no se excede el máximo de la ventana', async () => {
    const app = await makeApp({ buckets: { mcp: 3, admin: 3, oauth: 3, default: 3 } });
    for (let i = 0; i < 3; i++) {
      const res = await mcpCall(app, { auth: TOKEN_A });
      expect(res.statusCode).toBe(200);
    }
  });

  it('responde 429 con Retry-After en segundos cuando se excede', async () => {
    const app = await makeApp({ windowMs: 60_000, buckets: { mcp: 2, admin: 2, oauth: 2, default: 2 } });
    await mcpCall(app, { auth: TOKEN_A });
    await mcpCall(app, { auth: TOKEN_A });
    const res = await mcpCall(app, { auth: TOKEN_A });

    expect(res.statusCode).toBe(429);
    const retryAfter = Number(res.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(res.json()).toMatchObject({ ok: false });
  });

  it('publica el presupuesto en los headers x-ratelimit-*', async () => {
    const app = await makeApp({ buckets: { mcp: 2, admin: 2, oauth: 2, default: 2 } });
    const first = await mcpCall(app, { auth: TOKEN_A });
    expect(first.headers['x-ratelimit-limit']).toBe('2');
    expect(first.headers['x-ratelimit-remaining']).toBe('1');
    const second = await mcpCall(app, { auth: TOKEN_A });
    expect(second.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('/health queda exento: no consume presupuesto ni se corta nunca', async () => {
    const app = await makeApp({ buckets: { mcp: 1, admin: 1, oauth: 1, default: 1 } });
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/health', remoteAddress: '10.0.0.9' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    }
    // Y el presupuesto del bucket default sigue entero para esa misma IP.
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/mcp',
      remoteAddress: '10.0.0.9',
    });
    expect(res.statusCode).toBe(200);
  });

  it('el eje es la identidad: dos tokens distintos no comparten presupuesto', async () => {
    const app = await makeApp({ buckets: { mcp: 1, admin: 1, oauth: 1, default: 1 } });
    expect((await mcpCall(app, { auth: TOKEN_A })).statusCode).toBe(200);
    expect((await mcpCall(app, { auth: TOKEN_A })).statusCode).toBe(429);
    // Mismo IP, otro token: presupuesto propio.
    expect((await mcpCall(app, { auth: TOKEN_B })).statusCode).toBe(200);
  });

  it('el mismo token desde otra IP comparte presupuesto (la identidad manda sobre la IP)', async () => {
    const app = await makeApp({ buckets: { mcp: 1, admin: 1, oauth: 1, default: 1 } });
    expect((await mcpCall(app, { auth: TOKEN_A, ip: '10.0.0.1' })).statusCode).toBe(200);
    expect((await mcpCall(app, { auth: TOKEN_A, ip: '10.0.0.2' })).statusCode).toBe(429);
  });

  it('sin credencial cae a la IP, y dos IPs no se pisan', async () => {
    const app = await makeApp({ buckets: { mcp: 1, admin: 1, oauth: 1, default: 1 } });
    expect((await mcpCall(app, { ip: '10.0.0.1' })).statusCode).toBe(200);
    expect((await mcpCall(app, { ip: '10.0.0.1' })).statusCode).toBe(429);
    expect((await mcpCall(app, { ip: '10.0.0.2' })).statusCode).toBe(200);
  });

  it('la sesión del panel es identidad: dos admins distintos no se pisan', async () => {
    const app = await makeApp({ buckets: { mcp: 1, admin: 1, oauth: 1, default: 1 } });
    const uno = `${SESSION_COOKIE}=${createSession('s', undefined, Date.now(), { email: 'uno@example.com' })}`;
    const dos = `${SESSION_COOKIE}=${createSession('s', undefined, Date.now(), { email: 'dos@example.com' })}`;
    const get = (cookie: string) =>
      app.inject({
        method: 'GET',
        url: '/admin/api/meta',
        headers: { cookie },
        remoteAddress: '10.0.0.5',
      });
    expect((await get(uno)).statusCode).toBe(200);
    expect((await get(uno)).statusCode).toBe(429);
    expect((await get(dos)).statusCode).toBe(200);
  });

  it('cada familia de rutas tiene su presupuesto: agotar /mcp no corta el panel ni /oauth', async () => {
    const app = await makeApp({ buckets: { mcp: 1, admin: 5, oauth: 5, default: 5 } });
    expect((await mcpCall(app, { auth: TOKEN_A })).statusCode).toBe(200);
    expect((await mcpCall(app, { auth: TOKEN_A })).statusCode).toBe(429);

    const admin = await app.inject({
      method: 'GET',
      url: '/admin/api/meta',
      headers: { authorization: TOKEN_A },
      remoteAddress: '10.0.0.1',
    });
    expect(admin.statusCode).toBe(200);

    const oauth = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { authorization: TOKEN_A },
      remoteAddress: '10.0.0.1',
      payload: {},
    });
    expect(oauth.statusCode).toBe(200);
  });

  it('la ventana se renueva: pasado el windowMs el presupuesto vuelve entero', async () => {
    let clock = 1_000_000;
    const app = await makeApp(
      { windowMs: 60_000, buckets: { mcp: 1, admin: 1, oauth: 1, default: 1 } },
      () => clock,
    );
    expect((await mcpCall(app, { auth: TOKEN_A })).statusCode).toBe(200);
    expect((await mcpCall(app, { auth: TOKEN_A })).statusCode).toBe(429);
    clock += 60_001;
    expect((await mcpCall(app, { auth: TOKEN_A })).statusCode).toBe(200);
  });

  it('apagado (enabled:false) no limita ni agrega headers', async () => {
    const app = await makeApp({ enabled: false, buckets: { mcp: 1, admin: 1, oauth: 1, default: 1 } });
    for (let i = 0; i < 5; i++) {
      const res = await mcpCall(app, { auth: TOKEN_A });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });
});

describe('resolveRateLimitConfig', () => {
  it('viene prendido por default y con máximos que no rompen el uso normal', () => {
    const cfg = resolveRateLimitConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.windowMs).toBe(60_000);
    // Un agente haciendo tool calls hace del orden de unidades por segundo.
    expect(cfg.buckets.mcp).toBeGreaterThanOrEqual(120);
    expect(cfg.buckets.admin).toBeGreaterThanOrEqual(120);
    expect(cfg.buckets.oauth).toBeGreaterThan(0);
  });

  it('cada límite es configurable por env var', () => {
    const cfg = resolveRateLimitConfig({
      RATE_LIMIT_WINDOW_MS: '30000',
      RATE_LIMIT_MCP_MAX: '10',
      RATE_LIMIT_ADMIN_MAX: '11',
      RATE_LIMIT_OAUTH_MAX: '12',
      RATE_LIMIT_DEFAULT_MAX: '13',
    });
    expect(cfg.windowMs).toBe(30_000);
    expect(cfg.buckets).toEqual({ mcp: 10, admin: 11, oauth: 12, default: 13 });
  });

  it('RATE_LIMIT_ENABLED=false lo apaga, y sólo "false"/"0" lo apagan', () => {
    expect(resolveRateLimitConfig({ RATE_LIMIT_ENABLED: 'false' }).enabled).toBe(false);
    expect(resolveRateLimitConfig({ RATE_LIMIT_ENABLED: '0' }).enabled).toBe(false);
    expect(resolveRateLimitConfig({ RATE_LIMIT_ENABLED: 'true' }).enabled).toBe(true);
    expect(resolveRateLimitConfig({ RATE_LIMIT_ENABLED: 'sí' }).enabled).toBe(true);
  });

  it('un valor inválido no apaga el límite en silencio: rechaza', () => {
    expect(() => resolveRateLimitConfig({ RATE_LIMIT_MCP_MAX: '0' })).toThrow();
    expect(() => resolveRateLimitConfig({ RATE_LIMIT_MCP_MAX: 'muchas' })).toThrow();
    expect(() => resolveRateLimitConfig({ RATE_LIMIT_WINDOW_MS: '-1' })).toThrow();
  });
});
