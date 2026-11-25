import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { AuthError, type AuthRequestLike } from '../auth/oauth-bearer.js';
import {
  CheckRequest,
  EventsRequest,
  checkLease,
  recordEvents,
  type GateCheckDeps,
} from './check.js';

export interface GateRoutesDeps extends GateCheckDeps {
  authenticate: (req: AuthRequestLike) => Promise<TenantCtx>;
  logger?: FastifyBaseLogger;
}

/**
 * API del gate (historia #8): `POST /gate/v1/check` y `POST /gate/v1/events`.
 * Bearer del AS propio, membresía al workspace en cada llamada y respuestas
 * `{ ok: true, data } | { ok: false, error }`. Los logs llevan ids y resultados,
 * nunca el `lease_id`.
 */
export function registerGateRoutes(app: FastifyInstance, deps: GateRoutesDeps): void {
  const log = deps.logger ?? app.log;

  app.post('/gate/v1/check', async (req, reply) => {
    const ctx = await authenticateOrReply(deps, req, reply);
    if (!ctx) return reply;
    const parsed = CheckRequest.safeParse(req.body ?? {});
    if (!parsed.success)
      return reply
        .code(400)
        .send({ ok: false, error: 'Invalid input', issues: parsed.error.issues });

    const out = await checkLease(deps, ctx, parsed.data);
    if ('error' in out) return reply.code(403).send({ ok: false, error: out.error });
    log.info(
      {
        evt: 'gate.check',
        workspace_id: parsed.data.workspace,
        valid: out.result.valid,
        ...(out.result.valid ? { kind: out.result.kind } : { reason: out.result.reason }),
      },
      'gate check',
    );
    return { ok: true, data: out.result };
  });

  app.post('/gate/v1/events', async (req, reply) => {
    const ctx = await authenticateOrReply(deps, req, reply);
    if (!ctx) return reply;
    const parsed = EventsRequest.safeParse(req.body ?? {});
    if (!parsed.success)
      return reply
        .code(400)
        .send({ ok: false, error: 'Invalid input', issues: parsed.error.issues });

    const out = await recordEvents(deps, ctx, parsed.data);
    if ('error' in out) return reply.code(403).send({ ok: false, error: out.error });
    log.info(
      { evt: 'gate.events', workspace_id: parsed.data.workspace, stored: out.stored },
      'gate events',
    );
    return { ok: true, data: { stored: out.stored } };
  });
}

async function authenticateOrReply(
  deps: GateRoutesDeps,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<TenantCtx | undefined> {
  try {
    return await deps.authenticate(req);
  } catch (err) {
    if (err instanceof AuthError) {
      reply.code(err.status).send({ ok: false, error: err.message });
      return undefined;
    }
    throw err;
  }
}
