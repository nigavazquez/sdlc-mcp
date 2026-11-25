import type { Env } from '../credentials.js';
import { readConfig } from '../gate/config.js';
import { gitTree } from '../gate/git.js';
import { repoId } from '../gate/remote.js';
import { clearSession, writeLease } from '../gate/session-files.js';
import { getAccessToken } from '../token.js';

export const MAX_BYPASS_MINUTES = 120;
export const MIN_REASON = 10;

export interface BypassDeps {
  cwd: string;
  reason: string;
  /** `30m`, `2h` o minutos. Default 30 m. */
  ttl?: string;
  /** Hay una persona del otro lado (TTY). Sin eso, el bypass no corre. */
  isTTY: boolean;
  /** Pide escribir la confirmación; devuelve lo que escribió la persona. */
  askConfirmation: (expected: string) => Promise<string>;
  log: (line: string) => void;
  env?: Env;
}

/**
 * `sdlc bypass` (historia #15): permiso de emergencia para una persona, sin historia.
 * Exige TTY y una confirmación tipeada; el server lo registra con motivo, repo, branch y
 * vencimiento (#9). El gate deniega correrlo desde Bash, así que el agente no puede.
 */
export async function runBypass(deps: BypassDeps): Promise<{ expires_at: string; root: string }> {
  if (!deps.isTTY) {
    throw new Error(
      '`sdlc bypass` necesita una terminal interactiva: lo pide una persona, no un agente',
    );
  }
  const reason = deps.reason.trim();
  if (reason.length < MIN_REASON)
    throw new Error(`el motivo tiene que tener al menos ${MIN_REASON} caracteres`);
  const minutes = parseTtl(deps.ttl ?? '30m');

  const tree = gitTree(deps.cwd);
  if (!tree) throw new Error('no es un repo git');
  const config = readConfig(tree.mainRoot);
  if (
    tree.top === tree.mainRoot &&
    (tree.branch === config.default_branch || tree.branch === 'HEAD')
  ) {
    throw new Error(
      `no se hace bypass sobre ${tree.branch}: creá una branch o un worktree primero`,
    );
  }

  deps.log(`Bypass para ${config.workspace} en la branch ${tree.branch}, por ${minutes} minutos.`);
  deps.log(`Motivo: ${reason}`);
  deps.log('Queda registrado en el server con tu usuario.');
  const typed = await deps.askConfirmation(tree.branch);
  if (typed.trim() !== tree.branch)
    throw new Error('confirmación incorrecta: no se pidió el bypass');

  const token = await getAccessToken(config.server_url, { env: deps.env ?? process.env });
  const res = await fetch(`${config.server_url}/gate/v1/bypass`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      workspace: config.workspace,
      repo: repoId(tree.mainRoot),
      branch: tree.branch,
      reason,
      ttl_minutes: minutes,
    }),
  });
  const body = (await res.json().catch(() => undefined)) as
    | { ok?: boolean; error?: string; data?: { lease_id: string; expires_at: string } }
    | undefined;
  if (!res.ok || !body?.ok || !body.data)
    throw new Error(`el server rechazó el bypass: ${body?.error ?? res.status}`);

  clearSession(tree.top);
  writeLease(tree.top, {
    lease_id: body.data.lease_id,
    kind: 'bypass',
    expires_at: body.data.expires_at,
  });
  deps.log(`Bypass activo hasta ${body.data.expires_at}.`);
  return { expires_at: body.data.expires_at, root: tree.top };
}

export function parseTtl(ttl: string): number {
  const m = /^(\d+)\s*(m|min|h)?$/i.exec(ttl.trim());
  if (!m) throw new Error(`TTL inválido: "${ttl}" (usá 30m o 2h)`);
  const minutes = Number(m[1]) * (m[2]?.toLowerCase() === 'h' ? 60 : 1);
  if (minutes < 1 || minutes > MAX_BYPASS_MINUTES)
    throw new Error(`el TTL tiene que estar entre 1 y ${MAX_BYPASS_MINUTES} minutos`);
  return minutes;
}
