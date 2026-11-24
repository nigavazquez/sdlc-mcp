import { metrics } from '@opentelemetry/api';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { AdminStore } from '../../admin/store.js';
import { workspaceSelfSignoff } from '../../admin/self-signoff.js';
import { selfSignoffKilled } from '../../config.js';

/**
 * Decisión de firma propia (RFC self-qa-single-member, épica #20).
 *
 * Es el único lugar que decide si quien tiene asignada una story puede firmar su propio
 * QA o su propio review. Reemplaza a la regla fija "assignee ≠ firmante" que vivía en
 * tres tools: ahora depende de `workspaces.self_signoff`, que es true por default (cada
 * persona puede ser un equipo) y un admin apaga en los proyectos con equipo.
 *
 * Falla cerrado en la lectura: si la configuración no se puede leer, no se adivina el
 * default y se rechaza. El kill switch `SELF_SIGNOFF_ENABLED=false` rechaza en toda la
 * instancia sin tocar la base.
 *
 * Sólo decide quién firma. Roles y evidencia siguen siendo de cada tool.
 */
export type SelfSignoffDecision =
  | { self: false }
  | { self: true; allowed: true }
  | { self: true; allowed: false; reason: SelfSignoffRejection; error: string };

export type SelfSignoffRejection = 'disabled' | 'kill_switch' | 'store_error';

/** Contador mínimo: OTel en producción, un array en los tests. */
export interface SignoffRecorder {
  count(
    name: 'signoff.total' | 'signoff.self_rejected',
    attrs: Record<string, string | boolean>,
  ): void;
}

export interface SignoffLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
}

export interface SelfSignoffDeps {
  adminStore?: AdminStore;
  recorder?: SignoffRecorder;
  logger?: SignoffLogger;
}

const meter = metrics.getMeter('sdlc-mcp');
const totalCounter = meter.createCounter('signoff.total', {
  description: 'Decisiones de firma de QA/review, por tool y por si la firma es propia',
});
const rejectedCounter = meter.createCounter('signoff.self_rejected', {
  description: 'Firmas propias rechazadas, por motivo',
});

/** Sin un MeterProvider registrado, la API de OTel es un no-op: no cuesta nada apagada. */
export const otelSignoffRecorder: SignoffRecorder = {
  count: (name, attrs) => (name === 'signoff.total' ? totalCounter : rejectedCounter).add(1, attrs),
};

export async function selfSignoffPolicy(
  deps: SelfSignoffDeps,
  ctx: TenantCtx,
  flow: { project: string },
  story: { story_id: string; assignee?: string | undefined },
  tool: string,
): Promise<SelfSignoffDecision> {
  const decision = await decide(deps.adminStore, ctx, flow, story);
  observe(deps, decision, tool, flow, story);
  return decision;
}

async function decide(
  adminStore: AdminStore | undefined,
  ctx: TenantCtx,
  flow: { project: string },
  story: { story_id: string; assignee?: string | undefined },
): Promise<SelfSignoffDecision> {
  if (!story.assignee || story.assignee !== ctx.userId) return { self: false };

  if (selfSignoffKilled()) {
    return reject(
      'kill_switch',
      `${ctx.userId} tiene asignada la story ${story.story_id} y la firma propia está apagada en toda la ` +
        'instancia (SELF_SIGNOFF_ENABLED=false). Pedile a otra persona con el rol que corresponde que firme.',
    );
  }

  let enabled: boolean;
  try {
    enabled = await workspaceSelfSignoff(adminStore, flow.project);
  } catch {
    return reject(
      'store_error',
      `No se pudo leer si el workspace "${flow.project}" permite la firma propia, así que se rechaza por ` +
        'seguridad. Reintentá en unos minutos o pedile a otra persona que firme.',
    );
  }
  if (!enabled) {
    return reject(
      'disabled',
      `${ctx.userId} tiene asignada la story ${story.story_id} y el workspace "${flow.project}" no permite la ` +
        'firma propia. Pedile a otra persona del proyecto que firme, o a un admin que la active en el panel ' +
        '(Workspaces → "QA y review propios").',
    );
  }
  return { self: true, allowed: true };
}

function reject(reason: SelfSignoffRejection, error: string): SelfSignoffDecision {
  return { self: true, allowed: false, reason, error };
}

function observe(
  deps: SelfSignoffDeps,
  decision: SelfSignoffDecision,
  tool: string,
  flow: { project: string },
  story: { story_id: string },
): void {
  const recorder = deps.recorder ?? otelSignoffRecorder;
  const allowed = !decision.self || decision.allowed;
  recorder.count('signoff.total', { tool, self: decision.self, allowed });
  if (decision.self && !decision.allowed) {
    recorder.count('signoff.self_rejected', { tool, reason: decision.reason });
  }
  // Sólo ids y la decisión: ni el contenido de la firma ni la identidad viajan al log.
  deps.logger?.info({
    evt: 'signoff',
    tool,
    workspace_id: flow.project,
    story_id: story.story_id,
    self: decision.self,
    allowed,
    ...(decision.self && !decision.allowed ? { reason: decision.reason } : {}),
  });
}
