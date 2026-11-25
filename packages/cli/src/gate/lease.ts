import type { GateConfig } from './config.js';
import type { PreDecision } from './decide.js';
import {
  LoginRequiredError,
  ServerUnavailableError,
  type GateEvent,
  type GateServer,
} from './server.js';
import { clearSession, hashLease, readCache, readLease, writeCache } from './session-files.js';

/**
 * Pasos 7-9 del gate (historia #11): lease de la sesión, validación online y eventos.
 *
 * - Un edit con caché vigente (60 s) no toca la red.
 * - Un commit o push se valida siempre online y registra `commit.allowed` o
 *   `commit.blocked`. Si no se puede registrar el `commit.allowed`, se deniega: la
 *   métrica no puede perder commits.
 * - Server caído o lento → deny con la salida por `sdlc bypass`.
 */
export const EDIT_CACHE_MS = 60_000;

/** Motivos por los que el lease ya no sirve en ninguna sesión: se borra. */
const DEAD_LEASE = new Set(['expired', 'revoked', 'story_inactive', 'unknown']);

export type LeaseOutcome = { allow: true } | { allow: false; reason: string; next: string };

export interface LeaseDeps {
  server: GateServer;
  config: GateConfig;
  /** Repo normalizado (ver `repoId`). */
  repo: string;
  now?: () => Date;
}

type NeedsLease = Extract<PreDecision, { decision: 'needs_lease' }>;

export async function resolveLease(d: NeedsLease, deps: LeaseDeps): Promise<LeaseOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const lease = readLease(d.root);
  if (!lease) {
    await record(deps, d, now, { kind: blockedKind(d), reason: 'no_lease' });
    return deny('no hay un lease para esta sesión', 'reclamá una historia con claim_story');
  }

  const hash = hashLease(lease.lease_id);
  if (d.action === 'edit') {
    const cache = readCache(d.root);
    if (cache && cache.lease_hash === hash && Date.parse(cache.valid_until) > now.getTime()) {
      return { allow: true };
    }
  }

  let res;
  try {
    res = await deps.server.check({
      workspace: deps.config.workspace,
      lease_id: lease.lease_id,
      repo: deps.repo,
      branch: d.branch,
      worktree: d.root,
    });
  } catch (err) {
    return offline(err);
  }

  if (!res.valid) {
    if (DEAD_LEASE.has(res.reason)) clearSession(d.root);
    await record(deps, d, now, {
      kind: blockedKind(d),
      reason: res.reason,
      lease_id: lease.lease_id,
    });
    return deny(`el lease no es válido (${res.reason})`, res.next_step);
  }

  if (d.action === 'edit') {
    const until = Math.min(now.getTime() + EDIT_CACHE_MS, Date.parse(res.valid_until));
    writeCache(d.root, { lease_hash: hash, valid_until: new Date(until).toISOString() });
    return { allow: true };
  }

  try {
    await deps.server.events({
      workspace: deps.config.workspace,
      repo: deps.repo,
      events: [event(d, now, { kind: 'commit.allowed', lease_id: lease.lease_id })],
    });
  } catch (err) {
    const why = offline(err);
    return why.allow
      ? why
      : deny(`no se pudo registrar el commit en el server (${why.reason})`, why.next);
  }
  return { allow: true };
}

function blockedKind(d: NeedsLease): 'commit.blocked' | 'edit.blocked' {
  return d.action === 'commit' ? 'commit.blocked' : 'edit.blocked';
}

function event(
  d: NeedsLease,
  now: Date,
  e: { kind: GateEvent['kind']; reason?: string; lease_id?: string },
): GateEvent {
  return {
    kind: e.kind,
    branch: d.branch,
    ...(e.lease_id ? { lease_id: e.lease_id } : {}),
    ...(e.reason ? { reason: e.reason } : {}),
    detail: { action: d.action, ...(d.path ? { path: d.path } : {}) },
    at: now.toISOString(),
  };
}

/** Registro de un bloqueo: si no se puede, el deny igual vale. */
async function record(
  deps: LeaseDeps,
  d: NeedsLease,
  now: Date,
  e: { kind: GateEvent['kind']; reason: string; lease_id?: string },
): Promise<void> {
  try {
    await deps.server.events({
      workspace: deps.config.workspace,
      repo: deps.repo,
      events: [event(d, now, e)],
    });
  } catch {
    // Sin server no hay dónde registrar; el deny es lo que importa.
  }
}

function offline(err: unknown): LeaseOutcome {
  if (err instanceof LoginRequiredError)
    return deny('no hay sesión con el server sdlc', err.message);
  if (err instanceof ServerUnavailableError) {
    return deny(
      `server sdlc no disponible (${err.message})`,
      'si es urgente, usá `sdlc bypass` desde una terminal',
    );
  }
  throw err;
}

function deny(reason: string, next: string): LeaseOutcome {
  return { allow: false, reason, next };
}
