import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE, parseCookies } from '../admin/auth.js';

/**
 * Rate limiting del borde HTTP.
 *
 * **El eje es la identidad efectiva del caller, no el tenant ni la IP sola.**
 * El deploy es single-tenant (un `TENANT_ID` fijo), así que limitar por tenant
 * sería limitar a todos juntos: el primer agente en un loop deja sin server al
 * resto. La IP sola tampoco sirve como eje único —una oficina entera sale por
 * una NAT, y detrás de un proxy la IP es un header que el cliente escribe—, pero
 * sí es el mejor fallback cuando todavía no hay credencial (el flujo OAuth
 * empieza sin token).
 *
 * Entonces, en orden: access token Bearer → sesión del panel → IP. El token no se
 * verifica acá (eso es trabajo de `authenticate`, y duplicarlo costaría una
 * verificación de firma por request antes de saber siquiera si el request entra):
 * se usa **hasheado** como proxy de identidad, que es todo lo que el contador
 * necesita —mismo token, mismo balde— y evita que la credencial quede viva en un
 * Map o en un log.
 *
 * El segundo eje es la **familia de rutas**, porque los presupuestos razonables
 * son de órdenes distintos: un agente hace decenas de tool calls por minuto, el
 * panel hace ráfagas cortas al abrir una pantalla, y `/oauth` es donde vive el
 * fuerza-bruta. Un único cupo global obligaría a poner el techo del más ruidoso,
 * y con eso `/oauth` quedaría sin protección real.
 *
 * `/health` queda **exento**: lo pega el healthcheck del compose y el ALB cada
 * pocos segundos desde una sola IP, y un 429 ahí se lee como server caído.
 *
 * Alcance: ventana fija **en memoria y por proceso**. El deploy es una instancia
 * única (un EC2 + docker compose), así que alcanza. Si algún día hay más de una
 * réplica, el contador tiene que mudarse a un store compartido — por eso el seam
 * que testean los tests es el borde HTTP (status + headers) y no el contador.
 */

export type BucketName = 'mcp' | 'admin' | 'oauth' | 'default';

export interface RateLimitConfig {
  enabled: boolean;
  /** Largo de la ventana fija, en ms. */
  windowMs: number;
  /** Máximo de requests por identidad y por familia de rutas dentro de la ventana. */
  buckets: Record<BucketName, number>;
}

/**
 * Defaults pensados para no romper el uso normal: son techos de abuso, no cuotas.
 *
 * - `mcp` 240/min = 4 tool calls por segundo sostenidas por agente. Un flow entero
 *   (PRD → RFC → shaping → QA → review) son ~20 llamadas.
 * - `admin` 300/min: abrir una pantalla del panel dispara una ráfaga corta de
 *   fetches y el operador navega rápido.
 * - `oauth` 60/min por IP: el flujo completo (DCR + authorize + callback + token +
 *   refresh) son ~5 requests; 60 deja lugar a varias personas detrás de una NAT y
 *   sigue cortando un fuerza-bruta.
 * - `default` 120/min: lo que queda (estáticos del SPA, discovery, 404s).
 */
const DEFAULTS: RateLimitConfig = {
  enabled: true,
  windowMs: 60_000,
  buckets: { mcp: 240, admin: 300, oauth: 60, default: 120 },
};

/** Rutas que nunca se limitan: el healthcheck no es tráfico de usuario. */
function isExempt(path: string): boolean {
  return path === '/health' || path.startsWith('/health/');
}

function bucketFor(path: string): BucketName {
  if (path.startsWith('/mcp')) return 'mcp';
  if (path.startsWith('/admin/api')) return 'admin';
  if (path.startsWith('/oauth') || path.startsWith('/.well-known/oauth')) return 'oauth';
  return 'default';
}

function pathOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('base64url').slice(0, 22);
}

/**
 * Identidad efectiva del caller. Nunca devuelve la credencial en claro: lo que
 * entra al Map (y eventualmente a un log) es un hash truncado.
 */
export function identityOf(req: {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}): string {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.trim().length > 0) return `tok:${fingerprint(auth.trim())}`;

  const cookieHeader = req.headers['cookie'];
  if (typeof cookieHeader === 'string') {
    const session = parseCookies(cookieHeader)[SESSION_COOKIE];
    if (session) return `ses:${fingerprint(session)}`;
  }

  return `ip:${req.ip ?? 'unknown'}`;
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} tiene que ser un entero positivo (recibido: ${JSON.stringify(raw)})`);
  }
  return n;
}

/**
 * Lee la config del entorno. Un valor inválido **rompe el arranque** en vez de caer
 * a un default: un typo en `RATE_LIMIT_MCP_MAX` que apague el límite en silencio es
 * peor que no tener el límite, porque nadie se entera.
 */
export function resolveRateLimitConfig(env: Record<string, string | undefined>): RateLimitConfig {
  const rawEnabled = env.RATE_LIMIT_ENABLED?.trim().toLowerCase();
  const enabled = !(rawEnabled === 'false' || rawEnabled === '0');
  return {
    enabled,
    windowMs: parsePositiveInt(env.RATE_LIMIT_WINDOW_MS, DEFAULTS.windowMs, 'RATE_LIMIT_WINDOW_MS'),
    buckets: {
      mcp: parsePositiveInt(env.RATE_LIMIT_MCP_MAX, DEFAULTS.buckets.mcp, 'RATE_LIMIT_MCP_MAX'),
      admin: parsePositiveInt(env.RATE_LIMIT_ADMIN_MAX, DEFAULTS.buckets.admin, 'RATE_LIMIT_ADMIN_MAX'),
      oauth: parsePositiveInt(env.RATE_LIMIT_OAUTH_MAX, DEFAULTS.buckets.oauth, 'RATE_LIMIT_OAUTH_MAX'),
      default: parsePositiveInt(
        env.RATE_LIMIT_DEFAULT_MAX,
        DEFAULTS.buckets.default,
        'RATE_LIMIT_DEFAULT_MAX',
      ),
    },
  };
}

interface Window {
  count: number;
  resetAt: number;
}

/** Cota de memoria: arriba de esto se barren las ventanas vencidas antes de crear otra. */
const MAX_TRACKED = 20_000;

export function registerRateLimit(
  app: FastifyInstance,
  opts: { config: RateLimitConfig; now?: () => number },
): void {
  const { config } = opts;
  if (!config.enabled) return;

  const now = opts.now ?? Date.now;
  const windows = new Map<string, Window>();

  const sweep = (t: number) => {
    for (const [key, win] of windows) {
      if (win.resetAt <= t) windows.delete(key);
    }
  };

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = pathOf(req.url);
    if (isExempt(path)) return;

    const bucket = bucketFor(path);
    const limit = config.buckets[bucket];
    const key = `${bucket}|${identityOf(req)}`;
    const t = now();

    let win = windows.get(key);
    if (!win || win.resetAt <= t) {
      if (windows.size >= MAX_TRACKED) sweep(t);
      win = { count: 0, resetAt: t + config.windowMs };
      windows.set(key, win);
    }
    win.count += 1;

    const remaining = Math.max(0, limit - win.count);
    reply.header('x-ratelimit-limit', String(limit));
    reply.header('x-ratelimit-remaining', String(remaining));
    reply.header('x-ratelimit-reset', String(Math.ceil(win.resetAt / 1000)));

    if (win.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((win.resetAt - t) / 1000));
      reply.header('retry-after', String(retryAfter));
      return reply.code(429).send({
        ok: false,
        error: `Rate limit exceeded (${limit} requests / ${Math.round(config.windowMs / 1000)}s). Retry in ${retryAfter}s.`,
      });
    }
  });
}
