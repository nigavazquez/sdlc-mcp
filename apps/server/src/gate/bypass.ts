import { metrics } from '@opentelemetry/api';
import { z } from 'zod';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { assertWorkspaceAccess } from '../mcp/tools/workspace-access.js';
import { hashLeaseId, newLeaseId } from './lease.js';
import type { GateStore } from './types.js';

/**
 * Bypass humano y resumen North Star del gate (historia #9, RFC sdlc-repo-onboarding).
 *
 * El bypass lo pide el CLI `sdlc bypass` (TTY y confirmación tipeada, historia #15).
 * Acá se valida y, sobre todo, se registra: el control real es que quede en el server.
 */

export const MIN_BYPASS_REASON = 10;
export const MAX_BYPASS_TTL_MINUTES = 120;

const shortText = z.string().trim().min(1).max(300);

export const BypassRequest = z
  .object({
    workspace: shortText,
    repo: shortText,
    branch: shortText,
    reason: z.string().trim().min(MIN_BYPASS_REASON).max(500),
    ttl_minutes: z.number().int().min(1).max(MAX_BYPASS_TTL_MINUTES),
  })
  .strict();
export type BypassRequest = z.infer<typeof BypassRequest>;

export const SummaryQuery = z
  .object({ since: z.string().datetime({ offset: true }).optional() })
  .strict();

/** Sin `since`, el resumen mira los últimos 30 días. */
export const DEFAULT_SUMMARY_DAYS = 30;

export interface GateSummary {
  commits_allowed_story: number;
  commits_allowed_bypass: number;
  commits_blocked: number;
  edits_blocked: number;
  bypasses: number;
  /**
   * Commits con historia sobre todos los commits que pasaron. El RFC suma al denominador
   * los bloqueados que después se commitearon por fuera, pero eso el server no lo ve.
   * Sin commits vale 100: ninguno se escapó del flujo.
   */
  north_star_pct: number;
}

export interface GateBypassDeps {
  gateStore: GateStore;
  now?: () => Date;
}

const bypassCounter = metrics.getMeter('sdlc-mcp').createCounter('gate.bypass', {
  description: 'Bypass del gate creados, por workspace',
});

export async function createBypass(
  deps: GateBypassDeps,
  ctx: TenantCtx,
  req: BypassRequest,
): Promise<{ error: string } | { lease_id: string; expires_at: string }> {
  const denied = assertWorkspaceAccess(ctx, req.workspace);
  if (denied) return { error: denied };

  const now = (deps.now ?? (() => new Date()))();
  const leaseId = newLeaseId();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + req.ttl_minutes * 60_000).toISOString();
  await deps.gateStore.issueBypassLease(
    {
      lease_hash: hashLeaseId(leaseId),
      tenant_id: ctx.tenantId,
      workspace_id: req.workspace,
      user_id: ctx.userId,
      repo: req.repo,
      branch: req.branch,
      reason: req.reason,
      created_at: createdAt,
      expires_at: expiresAt,
    },
    {
      tenant_id: ctx.tenantId,
      workspace_id: req.workspace,
      user_id: ctx.userId,
      repo: req.repo,
      branch: req.branch,
      kind: 'bypass.created',
      lease_kind: 'bypass',
      story_id: null,
      reason: req.reason,
      detail: { ttl_minutes: req.ttl_minutes, expires_at: expiresAt },
      created_at: createdAt,
    },
  );
  bypassCounter.add(1, { workspace_id: req.workspace });
  return { lease_id: leaseId, expires_at: expiresAt };
}

export async function workspaceSummary(
  deps: GateBypassDeps,
  ctx: TenantCtx,
  workspace: string,
  since: string | undefined,
): Promise<{ error: string } | { summary: GateSummary }> {
  const denied = assertWorkspaceAccess(ctx, workspace);
  if (denied) return { error: denied };

  const now = (deps.now ?? (() => new Date()))();
  const from = since ?? new Date(now.getTime() - DEFAULT_SUMMARY_DAYS * 86_400_000).toISOString();
  const c = await deps.gateStore.countEvents(ctx.tenantId, workspace, from);
  const passed = c.commits_allowed_story + c.commits_allowed_bypass;
  const pct = passed === 0 ? 100 : Math.round((c.commits_allowed_story / passed) * 1000) / 10;
  return { summary: { ...c, north_star_pct: pct } };
}
