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
import { BypassRequest, SummaryQuery, createBypass, workspaceSummary } from './bypass.js';

export interface GateRoutesDeps extends GateCheckDeps {
  authenticate: (req: AuthRequestLike) => Promise<TenantCtx>;
  logger?: FastifyBaseLogger;
}

/**
 * API del gate: `POST /gate/v1/check` y `POST /gate/v1/events` (historia #8),
 * `POST /gate/v1/bypass` y `GET /gate/v1/workspaces/:workspace/summary` (historia #9).
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

  app.post('/gate/v1/bypass', async (req, reply) => {
    const ctx = await authenticateOrReply(deps, req, reply);
    if (!ctx) return reply;
    const parsed = BypassRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error:
          'Bypass inválido: el motivo tiene que tener al menos 10 caracteres y el TTL entre 1 y 120 minutos.',
        issues: parsed.error.issues,
      });
    }

    const out = await createBypass(deps, ctx, parsed.data);
    if ('error' in out) return reply.code(403).send({ ok: false, error: out.error });
    log.info(
      {
        evt: 'gate.bypass',
        workspace_id: parsed.data.workspace,
        user_id: ctx.userId,
        repo: parsed.data.repo,
        branch: parsed.data.branch,
        ttl_minutes: parsed.data.ttl_minutes,
      },
      'gate bypass created',
    );
    return { ok: true, data: out };
  });

  app.get('/gate/v1/workspaces/:workspace/summary', async (req, reply) => {
    const ctx = await authenticateOrReply(deps, req, reply);
    if (!ctx) return reply;
    const parsed = SummaryQuery.safeParse(req.query ?? {});
    if (!parsed.success)
      return reply
        .code(400)
        .send({ ok: false, error: 'Invalid input', issues: parsed.error.issues });

    const { workspace } = req.params as { workspace: string };
    const out = await workspaceSummary(deps, ctx, workspace, parsed.data.since);
    if ('error' in out) return reply.code(403).send({ ok: false, error: out.error });
    return { ok: true, data: out.summary };
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
