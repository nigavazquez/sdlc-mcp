import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { AuthError, type AuthRequestLike } from '../auth/oauth-bearer.js';
import { buildMcpServer } from '../mcp/server.js';
import type { ToolRegistry } from '../mcp/tools/index.js';

export interface McpTransportDeps {
  registry: ToolRegistry;
  authenticate: (req: AuthRequestLike) => Promise<TenantCtx>;
}

/**
 * El ctx de cada request, leído por `resolveCtx` dentro del handler de la tool.
 *
 * Todo el diseño depende de que sobreviva los awaits internos del transport: si no,
 * bajo concurrencia un request toma el ctx de otro. El test de tokens en paralelo de
 * test/mcp-http-transport.test.ts es el que lo fija.
 */
const ctxStorage = new AsyncLocalStorage<TenantCtx>();

/**
 * `POST /mcp` hablando MCP de verdad (Streamable HTTP), en modo **stateless**: un
 * transport y un `McpServer` efímeros por request, sin `Mcp-Session-Id` ni stream
 * server→cliente. Lo que cede y por qué, en
 * docs/superpowers/specs/2026-09-14-mcp-streamable-http-design.md § 2.
 *
 * Convive con `POST /mcp/tools/:name`, que queda como superficie de debug curl-eable.
 */
export function registerMcpTransport(app: FastifyInstance, deps: McpTransportDeps) {
  const resolveCtx = () => {
    const ctx = ctxStorage.getStore();
    if (!ctx) throw new Error('MCP tool call sin TenantCtx: el request no pasó por authenticate');
    return ctx;
  };

  app.post('/mcp', async (req, reply) => {
    // Autenticar antes de instanciar nada: sin token no se construye transport ni server.
    const ctx = await authenticateOrReply(deps, req, reply);
    if (!ctx) return reply;

    // Sin `sessionIdGenerator` el transport es stateless. Se omite en vez de pasarlo
    // `undefined` porque `exactOptionalPropertyTypes` no acepta lo segundo.
    const transport = new StreamableHTTPServerTransport({
      // Ninguna tool streamea: JSON plano es más simple de leer y de debuggear que SSE.
      enableJsonResponse: true,
    });
    const server = buildMcpServer({ registry: deps.registry, resolveCtx });
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });

    // El transport escribe directo sobre la respuesta de node: Fastify no la toca. Lo que
    // los hooks previos dejaron con `reply.header` (los x-ratelimit-*) se pasa a mano,
    // porque después del hijack Fastify ya no lo escribe.
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value);
    }
    reply.hijack();
    // El SDK declara `onclose?: () => void` en la clase y `onclose?: (() => void) | undefined`
    // en la interfaz: bajo `exactOptionalPropertyTypes` no calzan, aunque en runtime sí.
    await server.connect(transport as Transport);
    await ctxStorage.run(ctx, () => transport.handleRequest(req.raw, reply.raw, req.body));
  });

  // En stateless no hay stream que abrir (GET) ni sesión que borrar (DELETE). Un 404
  // haría pensar que el endpoint no existe; el 405 dice que existe y cómo es.
  const methodNotAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply
      .code(405)
      .header('allow', 'POST')
      .send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed: this MCP server is stateless (POST only)' },
        id: null,
      });
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);
}

async function authenticateOrReply(
  deps: McpTransportDeps,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<TenantCtx | undefined> {
  try {
    return await deps.authenticate(req);
  } catch (err) {
    if (!(err instanceof AuthError)) throw err;
    if (err.wwwAuthenticate) reply.header('www-authenticate', err.wwwAuthenticate);
    reply.code(err.status).send({ ok: false, error: err.message });
    return undefined;
  }
}
