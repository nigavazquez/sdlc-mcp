import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Env } from '../credentials.js';
import { DEFAULT_EXCLUDE, readConfig, type GateConfig } from '../gate/config.js';
import { gitTree } from '../gate/git.js';
import { getAccessToken, LoginRequiredError } from '../token.js';
import { lineDiff } from './diff.js';
import { MANAGED_PATHS, PATHS, planInstall, type FileChange } from './plan.js';

export const DEFAULT_SERVER = 'http://localhost:3100';

export interface Prompter {
  ask(question: string, defaultValue?: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
}

export interface InitFlags {
  server?: string;
  workspace?: string;
  exclude?: string[];
  /** Aplica sin pedir confirmación (sólo con todo lo demás por flag). */
  yes?: boolean;
}

export interface InitDeps {
  cwd: string;
  prompter: Prompter;
  log: (line: string) => void;
  gateSource: string;
  login: (serverUrl: string) => Promise<void>;
  /** Workspaces de la persona en ese server (vía `whoami`). */
  listWorkspaces: (serverUrl: string, token: string) => Promise<string[]>;
  flags?: InitFlags;
  env?: Env;
}

export interface InitResult {
  root: string;
  written: string[];
  /** `false` si la persona no confirmó: no se escribió nada. */
  applied: boolean;
}

/**
 * `sdlc init` (historia #13): asistente que habilita el SDLC obligatorio en un repo.
 * Pregunta server, workspace (elección explícita) y exclusiones, muestra el diff de cada
 * archivo y escribe sólo después de confirmar, dejando un `*.bak` de lo que cambia.
 */
export async function runInit(deps: InitDeps): Promise<InitResult> {
  const flags = deps.flags ?? {};
  const env = deps.env ?? process.env;
  const tree = gitTree(deps.cwd);
  if (!tree) throw new Error('no es un repo git: corré `sdlc init` dentro del repo');
  if (tree.top !== tree.mainRoot)
    throw new Error(`corré \`sdlc init\` desde el checkout principal (${tree.mainRoot})`);
  const root = tree.mainRoot;
  const previous = readPrevious(root);

  const server = (
    flags.server ??
    (await deps.prompter.ask('URL del server sdlc', previous?.server_url ?? DEFAULT_SERVER))
  )
    .trim()
    .replace(/\/+$/, '');

  let token: string;
  try {
    token = await getAccessToken(server, { env });
  } catch (err) {
    if (!(err instanceof LoginRequiredError)) throw err;
    deps.log(`No hay sesión con ${server}: abriendo el login.`);
    await deps.login(server);
    token = await getAccessToken(server, { env });
  }

  const workspaces = await deps.listWorkspaces(server, token);
  if (workspaces.length === 0) {
    throw new Error(
      'tu usuario no pertenece a ningún workspace en ese server: pedile a un admin que te agregue',
    );
  }
  const workspace = await chooseWorkspace(deps, workspaces, flags.workspace);

  const exclude =
    flags.exclude ??
    (await askExclude(deps, previous && previous.workspace === workspace ? previous.exclude : []));

  const changes = planInstall({
    serverUrl: server,
    workspace,
    exclude,
    defaultBranch: detectDefaultBranch(root, tree.branch),
    installedFrom: headCommit(root),
    gateSource: deps.gateSource,
    current: Object.fromEntries(MANAGED_PATHS.map((p) => [p, readIfExists(join(root, p))])),
  });

  if (changes.length === 0) {
    deps.log('Nada que cambiar: el repo ya tiene sdlc instalado con esta configuración.');
    warnIgnored(deps, root);
    return { root, written: [], applied: true };
  }

  for (const ch of changes) showDiff(deps, ch);
  if (!flags.yes && !(await deps.prompter.confirm(`¿Escribir estos ${changes.length} archivos?`))) {
    deps.log('Cancelado: no se escribió nada.');
    return { root, written: [], applied: false };
  }

  for (const ch of changes) write(root, ch);
  warnIgnored(deps, root);
  deps.log('');
  deps.log(
    `Listo. Se escribieron ${changes.length} archivos (los que existían quedaron en *.bak).`,
  );
  deps.log(
    'Siguiente: reiniciá la sesión de Claude Code (los hooks se leen al arrancar). Ahora corre `sdlc doctor`.',
  );
  return { root, written: changes.map((c) => c.path), applied: true };
}

async function chooseWorkspace(
  deps: InitDeps,
  workspaces: string[],
  flag: string | undefined,
): Promise<string> {
  if (flag !== undefined) {
    if (!workspaces.includes(flag))
      throw new Error(
        `no pertenecés al workspace "${flag}". Tus workspaces: ${workspaces.join(', ')}`,
      );
    return flag;
  }
  deps.log('Tus workspaces:');
  for (const ws of workspaces) deps.log(`  - ${ws}`);
  // Sin default a propósito: el workspace separa clientes y se elige explícitamente.
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = (
      await deps.prompter.ask('Workspace para este repo (escribilo tal cual)')
    ).trim();
    if (workspaces.includes(answer)) return answer;
    deps.log(`"${answer}" no está en tu lista.`);
  }
  throw new Error('no se eligió un workspace válido');
}

async function askExclude(deps: InitDeps, previous: string[]): Promise<string[]> {
  deps.log(`Exclusiones por defecto (no piden historia): ${DEFAULT_EXCLUDE.join(', ')}`);
  const answer = await deps.prompter.ask(
    'Exclusiones extra, separadas por coma (vacío = ninguna)',
    previous.join(', '),
  );
  return answer
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function showDiff(deps: InitDeps, ch: FileChange): void {
  deps.log('');
  deps.log(`── ${ch.path} ${ch.before === undefined ? '(nuevo)' : '(modificado)'}`);
  if (ch.path === PATHS.gate) {
    deps.log(`  gate del SDLC (${ch.after.length} bytes)`);
    return;
  }
  for (const line of lineDiff(ch.before, ch.after)) deps.log(line);
}

/**
 * Los archivos de init tienen que versionarse: si no, el gate sólo existe en este clon.
 * Git no deja re-incluir un archivo de un directorio ignorado (`.claude/`), así que no se
 * toca el `.gitignore` del usuario: se avisa qué cambiar.
 */
export function ignoredManagedPaths(root: string): string[] {
  try {
    const out = execFileSync('git', ['check-ignore', '--no-index', ...MANAGED_PATHS], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter(Boolean);
  } catch (err) {
    // Sale con 1 cuando ninguno está ignorado.
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
}

function warnIgnored(deps: InitDeps, root: string): void {
  const ignored = ignoredManagedPaths(root);
  if (ignored.length === 0) return;
  deps.log('');
  deps.log(`Atención: .gitignore ignora ${ignored.join(', ')}.`);
  deps.log(
    'Así el gate sólo queda en este clon. Para versionarlo, reemplazá `.claude/` por `.claude/*` y agregá:',
  );
  deps.log('  !.claude/settings.json');
  deps.log('  !.claude/hooks/');
  deps.log('  !.claude/sdlc/');
  deps.log('Después commiteá esos archivos junto con .mcp.json y CLAUDE.md.');
}

function write(root: string, ch: FileChange): void {
  const abs = join(root, ch.path);
  mkdirSync(dirname(abs), { recursive: true });
  if (ch.before !== undefined) writeFileSync(`${abs}.bak`, ch.before);
  writeFileSync(abs, ch.after);
  if (ch.path === PATHS.gate) chmodSync(abs, 0o755);
}

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

function readPrevious(root: string): GateConfig | undefined {
  try {
    return readConfig(root);
  } catch {
    return undefined;
  }
}

/** La branch default sale de `origin/HEAD`; sin remote, la branch actual del checkout principal. */
function detectDefaultBranch(root: string, current: string): string {
  try {
    const ref = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    return ref.replace(/^origin\//, '');
  } catch {
    return current === 'HEAD' ? 'main' : current;
  }
}

function headCommit(root: string): string {
  try {
    return git(root, ['rev-parse', 'HEAD']);
  } catch {
    return 'none';
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}
