import { metrics } from '@opentelemetry/api';
import { z } from 'zod';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { StoryStatus } from '@sdlc/core';
import type { FlowStore } from '../state/store.js';
import { assertWorkspaceAccess } from '../mcp/tools/workspace-access.js';
import { hashLeaseId, STORY_LEASE_TTL_MS } from './lease.js';
import { GATE_EVENT_KINDS, type GateEventRow, type GateLease, type GateStore } from './types.js';

/**
 * Validación de leases y registro de eventos del gate (historia #8, RFC
 * sdlc-repo-onboarding). Las rutas HTTP de `routes.ts` son una capa fina sobre esto.
 *
 * El `lease_id` es un secreto: no se loguea, no va a métricas y no se persiste. Sólo
 * se usa para calcular su hash.
 */

/** Statuses en los que se trabaja sobre la story; fuera de estos el lease no vale. */
const ACTIVE_STORY_STATUSES: ReadonlySet<StoryStatus> = new Set([
  'claimed',
  'in_progress',
  'in_review',
]);

export const MAX_EVENTS_PER_BATCH = 50;

const shortText = z.string().trim().min(1).max(300);

export const CheckRequest = z
  .object({
    workspace: shortText,
    lease_id: z.string().min(1).max(200),
    repo: shortText,
    branch: shortText,
    worktree: z.string().max(1000),
  })
  .strict();
export type CheckRequest = z.infer<typeof CheckRequest>;

export const EventsRequest = z
  .object({
    workspace: shortText,
    repo: shortText,
    events: z
      .array(
        z
          .object({
            kind: z.enum(GATE_EVENT_KINDS),
            branch: shortText.optional(),
            lease_id: z.string().min(1).max(200).optional(),
            reason: z.string().max(500).optional(),
            detail: z.record(z.unknown()).optional(),
            at: z.string().datetime({ offset: true }),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_EVENTS_PER_BATCH),
  })
  .strict();
export type EventsRequest = z.infer<typeof EventsRequest>;

export type CheckReason =
  | 'expired'
  | 'revoked'
  | 'story_inactive'
  | 'branch_mismatch'
  | 'workspace_mismatch'
  | 'unknown';

export type CheckResult =
  | { valid: true; kind: 'story' | 'bypass'; story_id?: string; valid_until: string }
  | { valid: false; reason: CheckReason; next_step: string };

const NEXT_STEP: Record<CheckReason, string> = {
  expired: 'el lease venció: volvé a reclamar la historia con claim_story',
  revoked: 'el lease fue reemplazado por otro claim: volvé a reclamar la historia con claim_story',
  story_inactive:
    'la historia ya no está activa (aprobada, descartada o el flow se abortó): reclamá otra con claim_story',
  branch_mismatch:
    'el lease está atado a otra branch o repo: trabajá en la branch donde reclamaste la historia, o reclamala de nuevo acá',
  workspace_mismatch:
    'el lease es de otro workspace: revisá `workspace` en .claude/sdlc/config.json',
  unknown: 'lease desconocido: reclamá una historia con claim_story',
};

export interface GateCheckDeps {
  gateStore: GateStore;
  flowStore: FlowStore;
  now?: () => Date;
}

const meter = metrics.getMeter('sdlc-mcp');
const checkCounter = meter.createCounter('gate.check', {
  description: 'Checks de lease del gate, por resultado',
});
const eventsCounter = meter.createCounter('gate.events', {
  description: 'Eventos recibidos del gate, por tipo',
});

function deny(reason: CheckReason): CheckResult {
  return { valid: false, reason, next_step: NEXT_STEP[reason] };
}

/**
 * Valida un lease. Devuelve `{ error }` si el pedido no corresponde (sin membresía al
 * workspace): en ese caso no se leyó ni escribió nada.
 */
export async function checkLease(
  deps: GateCheckDeps,
  ctx: TenantCtx,
  req: CheckRequest,
): Promise<{ error: string } | { result: CheckResult }> {
  const denied = assertWorkspaceAccess(ctx, req.workspace);
  if (denied) return { error: denied };

  const result = await evaluate(deps, ctx, req);
  checkCounter.add(1, { valid: result.valid, reason: result.valid ? 'ok' : result.reason });
  return { result };
}

async function evaluate(
  deps: GateCheckDeps,
  ctx: TenantCtx,
  req: CheckRequest,
): Promise<CheckResult> {
  const now = (deps.now ?? (() => new Date()))();
  const hash = hashLeaseId(req.lease_id);
  const lease = await deps.gateStore.getLease(hash);

  // Un lease de otro tenant o de otra persona se trata como desconocido: no se revela que existe.
  if (!lease || lease.tenant_id !== ctx.tenantId || lease.user_id !== ctx.userId)
    return deny('unknown');
  if (lease.workspace_id !== req.workspace) return deny('workspace_mismatch');
  if (lease.revoked_at !== null) return deny('revoked');
  if (Date.parse(lease.expires_at) <= now.getTime()) return deny('expired');
  if (lease.kind === 'story' && !(await storyIsActive(deps.flowStore, lease)))
    return deny('story_inactive');

  // Un bypass no se renueva: su TTL corto es el límite que eligió quien lo pidió.
  const expiresAt =
    lease.kind === 'story'
      ? new Date(now.getTime() + STORY_LEASE_TTL_MS).toISOString()
      : lease.expires_at;
  const bound = await deps.gateStore.bindAndRenew(hash, {
    repo: req.repo,
    branch: req.branch,
    expires_at: expiresAt,
  });
  if (!bound) return deny('branch_mismatch');

  return {
    valid: true,
    kind: bound.kind,
    ...(bound.story_id ? { story_id: bound.story_id } : {}),
    valid_until: bound.expires_at,
  };
}

async function storyIsActive(flowStore: FlowStore, lease: GateLease): Promise<boolean> {
  if (!lease.story_id) return false;
  const story = await flowStore.getStory(lease.story_id);
  if (!story || !ACTIVE_STORY_STATUSES.has(story.status)) return false;
  const flow = await flowStore.getFlow(story.flow_id);
  return !!flow && flow.status !== 'aborted';
}

/**
 * Guarda un batch de eventos. El `lease_id` de cada evento sólo sirve para completar
 * `lease_kind` y `story_id` desde el lease (si es de esta persona y este workspace); no
 * se guarda.
 */
export async function recordEvents(
  deps: GateCheckDeps,
  ctx: TenantCtx,
  req: EventsRequest,
): Promise<{ error: string } | { stored: number }> {
  const denied = assertWorkspaceAccess(ctx, req.workspace);
  if (denied) return { error: denied };

  const now = (deps.now ?? (() => new Date()))().toISOString();
  const rows: GateEventRow[] = [];
  for (const e of req.events) {
    const lease = e.lease_id ? await deps.gateStore.getLease(hashLeaseId(e.lease_id)) : undefined;
    const own =
      lease &&
      lease.tenant_id === ctx.tenantId &&
      lease.user_id === ctx.userId &&
      lease.workspace_id === req.workspace;
    rows.push({
      tenant_id: ctx.tenantId,
      workspace_id: req.workspace,
      user_id: ctx.userId,
      repo: req.repo,
      branch: e.branch ?? null,
      kind: e.kind,
      lease_kind: own ? lease.kind : null,
      story_id: own ? lease.story_id : null,
      reason: e.reason ?? null,
      detail: { ...withoutLeaseId(e.detail ?? {}), at: e.at },
      created_at: now,
    });
  }
  await deps.gateStore.insertEvents(rows);
  for (const r of rows) eventsCounter.add(1, { kind: r.kind });
  return { stored: rows.length };
}

/** Por si el gate mandara el lease dentro de `detail`: el secreto no se persiste. */
function withoutLeaseId(detail: Record<string, unknown>): Record<string, unknown> {
  const { lease_id: _dropped, ...rest } = detail;
  return rest;
}
