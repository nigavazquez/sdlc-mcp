import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../credentials.js';
import { readConfig, type GateConfig } from '../gate/config.js';
import { gitTree } from '../gate/git.js';
import { hookCommand } from '../hooks.js';
import { PATHS } from '../init/plan.js';
import { getAccessToken } from '../token.js';
import { dryRunGate } from './dry-run.js';
import {
  auditSettings,
  missingDenyRules,
  settingsSources,
  type SettingsSource,
} from './settings-audit.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorDeps {
  cwd: string;
  log: (line: string) => void;
  /** El gate que trae este CLI: el instalado tiene que ser igual. */
  bundledGate: string;
  listWorkspaces: (serverUrl: string, token: string) => Promise<string[]>;
  env?: Env;
  /** Para los tests: los niveles de settings a revisar. */
  sources?: SettingsSource[];
  nodeVersion?: string;
}

/**
 * `sdlc doctor` (historia #14): diagnóstico del repo habilitado y dry-run del gate. Sale
 * con código distinto de 0 si cualquier chequeo falla.
 */
export async function runDoctor(
  deps: DoctorDeps,
): Promise<{ checks: DoctorCheck[]; exitCode: number }> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const major = Number((deps.nodeVersion ?? process.versions.node).split('.')[0]);
  add(
    'node',
    major >= 20,
    `v${deps.nodeVersion ?? process.versions.node}${major >= 20 ? '' : ' (hace falta ≥ 20)'}`,
  );

  const tree = gitTree(deps.cwd);
  if (!tree) {
    add('repo', false, 'no es un repo git');
    return finish(deps, checks);
  }
  const root = tree.mainRoot;

  let config: GateConfig | undefined;
  try {
    config = readConfig(root);
    add('config', true, `workspace ${config.workspace}, server ${config.server_url}`);
  } catch (err) {
    add('config', false, `${(err as Error).message}: corré \`sdlc init\``);
  }

  const gatePath = join(root, PATHS.gate);
  if (!existsSync(gatePath)) {
    add('gate', false, `falta ${PATHS.gate}: corré \`sdlc init\``);
  } else {
    const same = sha(readFileSync(gatePath, 'utf8')) === sha(deps.bundledGate);
    const origin =
      config?.installed_with?.origin ?? 'origen desconocido: reinstalá con `sdlc init`';
    add(
      'versión del gate',
      same,
      `${gateVersion(gatePath)} (${origin})` +
        (same ? '' : ': distinta de la de este CLI, corré `sdlc init` para actualizarla'),
    );
  }

  add(
    'hooks',
    hooksInstalled(join(root, PATHS.settings)),
    'PreToolUse y PostToolUse del gate en .claude/settings.json',
  );
  const missing = missingDenyRules(join(root, PATHS.settings));
  add(
    'permissions.deny',
    missing.length === 0,
    missing.length === 0 ? 'las reglas del gate están' : `faltan: ${missing.join(', ')}`,
  );

  const problems = auditSettings(deps.sources ?? settingsSources(root));
  add(
    'settings que anulan el gate',
    problems.length === 0,
    problems.length === 0 ? 'ninguno en usuario, proyecto, local ni managed' : problems.join('; '),
  );

  if (config) await serverChecks(deps, config, add);

  if (existsSync(gatePath)) {
    for (const c of dryRunGate(gatePath)) {
      add(
        `dry-run: ${c.name}`,
        c.ok,
        `esperado ${c.expected}, dio ${c.got}${c.reason && !c.ok ? ` (${c.reason})` : ''}`,
      );
    }
  }
  return finish(deps, checks);
}

async function serverChecks(
  deps: DoctorDeps,
  config: GateConfig,
  add: (n: string, ok: boolean, d: string) => void,
) {
  try {
    const res = await fetch(`${config.server_url}/.well-known/oauth-authorization-server`, {
      signal: AbortSignal.timeout(3000),
    });
    add(
      'server',
      res.ok,
      res.ok ? `${config.server_url} responde` : `${config.server_url} respondió ${res.status}`,
    );
    if (!res.ok) return;
  } catch {
    add('server', false, `${config.server_url} no responde`);
    return;
  }
  let token: string;
  try {
    token = await getAccessToken(config.server_url, { env: deps.env ?? process.env });
    add('token', true, 'sesión vigente');
  } catch (err) {
    add('token', false, (err as Error).message);
    return;
  }
  try {
    const workspaces = await deps.listWorkspaces(config.server_url, token);
    const member = workspaces.includes(config.workspace);
    add(
      'membresía',
      member,
      member
        ? `sos miembro de ${config.workspace}`
        : `no sos miembro de ${config.workspace} (tus workspaces: ${workspaces.join(', ') || 'ninguno'})`,
    );
  } catch (err) {
    add('membresía', false, (err as Error).message);
  }
}

function hooksInstalled(settingsPath: string): boolean {
  try {
    const s = JSON.parse(readFileSync(settingsPath, 'utf8')) as { hooks?: Record<string, unknown> };
    const has = (event: string, mode: 'pre' | 'post') =>
      JSON.stringify(s.hooks?.[event] ?? []).includes(
        JSON.stringify(hookCommand(mode)).slice(1, -1),
      );
    return has('PreToolUse', 'pre') && has('PostToolUse', 'post');
  } catch {
    return false;
  }
}

function finish(deps: DoctorDeps, checks: DoctorCheck[]) {
  for (const c of checks) deps.log(`${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`);
  const failed = checks.filter((c) => !c.ok).length;
  deps.log(failed === 0 ? '\nTodo en orden.' : `\n${failed} chequeo(s) fallaron.`);
  return { checks, exitCode: failed === 0 ? 0 : 1 };
}

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Lo que responde el gate instalado a `--version`; los gates anteriores a #16 no lo saben. */
function gateVersion(gatePath: string): string {
  const r = spawnSync(process.execPath, [gatePath, '--version'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  const v = r.stdout.trim();
  return r.status === 0 && v && !v.startsWith('{') ? `v${v}` : 'versión desconocida';
}
