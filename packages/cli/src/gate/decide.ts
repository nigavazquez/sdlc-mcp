import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_EXCLUDE, PROTECTED, type GateConfig } from './config.js';
import { gitTree, nearestExistingDir, type GitTree } from './git.js';
import { matchesAny } from './glob.js';

/**
 * Decisiones locales del gate en PreToolUse (historia #10): pasos 1-6 del orden de
 * evaluación del RFC sdlc-repo-onboarding. Lo que no se resuelve acá necesita lease y
 * sigue en `needs_lease` (pasos 7-9, historia #11).
 */
export type PreDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string; next: string }
  | {
      decision: 'needs_lease';
      action: 'edit' | 'commit';
      /** Raíz de la sesión: el checkout principal o el worktree. Ahí vive `lease.json`. */
      root: string;
      branch: string;
      /** Ruta relativa a `root` (sólo en edits). */
      path?: string;
    };

export interface PreToolUseEvent {
  tool_name?: unknown;
  tool_input?: unknown;
  cwd?: unknown;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Lo que un comando de Bash no puede nombrar: las rutas protegidas, sin globs. */
const PROTECTED_IN_COMMANDS = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/hooks/sdlc-gate.mjs',
  '.claude/sdlc',
  '.mcp.json',
];

/**
 * Conservador a propósito: cualquier `git … commit|push` cuenta, aunque la palabra sea
 * un argumento. Pedir lease de más es seguro; pedirlo de menos dejaría commitear sin él.
 */
const COMMIT_OR_PUSH = /\bgit\b[^;&|\n]*\b(?:commit|push)\b/;

export function decidePre(
  event: PreToolUseEvent,
  projectDir: string,
  config: GateConfig,
): PreDecision {
  const tool = event.tool_name;
  const input = (event.tool_input ?? {}) as Record<string, unknown>;
  const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : projectDir;
  const project = gitTree(projectDir);
  if (!project) throw new Error(`el proyecto ${projectDir} no es un repo git`);

  if (tool === 'Bash') return decideBash(String(input.command ?? ''), cwd, project, config);
  if (typeof tool === 'string' && EDIT_TOOLS.has(tool)) {
    const raw = input.file_path ?? input.notebook_path;
    if (typeof raw !== 'string' || !raw) throw new Error(`${tool} sin ruta destino`);
    return decideEdit(raw, cwd, project, config);
  }
  return deny(
    `la herramienta ${String(tool)} no está prevista por el gate`,
    'revisá los hooks con `sdlc doctor`',
  );
}

function decideBash(
  command: string,
  cwd: string,
  project: GitTree,
  config: GateConfig,
): PreDecision {
  // 2. Protegidos, con o sin lease.
  if (PROTECTED_IN_COMMANDS.some((p) => command.includes(p))) {
    return deny(
      'el comando toca archivos protegidos del SDLC',
      'esos archivos sólo los cambia `sdlc init`; pedile a la persona que lo corra',
    );
  }
  // 3. Bash que no es commit ni push.
  if (!COMMIT_OR_PUSH.test(command)) return { decision: 'allow' };

  const tree = gitTree(cwd);
  // 4. Un commit en otro repo no es asunto de este gate.
  if (!tree || tree.commonDir !== project.commonDir) return { decision: 'allow' };
  return location(tree, config, { action: 'commit' });
}

function decideEdit(raw: string, cwd: string, project: GitTree, config: GateConfig): PreDecision {
  const abs = canonical(isAbsolute(raw) ? raw : resolve(cwd, raw));
  const tree = gitTree(nearestExistingDir(abs));

  // 2. Protegidos: relativos al árbol del archivo y al proyecto (un worktree tiene su propia copia).
  const rels = [tree ? relative(tree.top, abs) : undefined, relative(project.top, abs)];
  if (rels.some((r) => r !== undefined && inside(r) && matchesAny(toPosix(r), PROTECTED))) {
    return deny(
      'ese archivo está protegido',
      'los archivos del SDLC (.claude/settings*, hooks, .claude/sdlc, .mcp.json) sólo los cambia `sdlc init`',
    );
  }

  // 4. Fuera del repo: otro repo o ningún repo.
  if (!tree || tree.commonDir !== project.commonDir) return { decision: 'allow' };

  // 5. Exclusiones.
  const rel = toPosix(relative(tree.top, abs));
  if (matchesAny(rel, [...DEFAULT_EXCLUDE, ...config.exclude])) return { decision: 'allow' };

  return location(tree, config, { action: 'edit', path: rel });
}

/** 6. Dónde está trabajando la sesión. */
function location(
  tree: GitTree,
  config: GateConfig,
  what: { action: 'edit' | 'commit'; path?: string },
): PreDecision {
  const needs = (): PreDecision => ({
    decision: 'needs_lease',
    action: what.action,
    root: tree.top,
    branch: tree.branch,
    ...(what.path ? { path: what.path } : {}),
  });

  if (tree.top === tree.mainRoot) {
    if (tree.branch === config.default_branch || tree.branch === 'HEAD') {
      return deny(
        `no se trabaja sobre ${tree.branch === 'HEAD' ? 'un HEAD detached' : `la branch default (${config.default_branch})`} del checkout principal`,
        'creá una branch (`git switch -c feat/…`) o un worktree en .claude/worktrees/',
      );
    }
    return needs();
  }

  const worktrees = join(tree.mainRoot, '.claude', 'worktrees') + sep;
  if (tree.top.startsWith(worktrees)) return needs();
  return deny(
    `el worktree ${tree.top} está fuera de .claude/worktrees/`,
    `creá el worktree en ${worktrees}`,
  );
}

function deny(reason: string, next: string): PreDecision {
  return { decision: 'deny', reason, next };
}

/** Ruta absoluta con los symlinks resueltos (macOS: /tmp → /private/tmp), aunque no exista. */
function canonical(abs: string): string {
  const dir = nearestExistingDir(abs);
  return join(realpathSync(dir), relative(dir, abs));
}

function inside(rel: string): boolean {
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}
