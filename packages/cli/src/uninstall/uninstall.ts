import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitTree } from '../gate/git.js';
import { BLOCK_BEGIN, BLOCK_END, DENY_RULES, PATHS } from '../init/plan.js';

export interface UninstallPlan {
  /** Archivos que se reescriben, con su contenido nuevo. */
  rewrite: Array<{ path: string; after: string }>;
  /** Archivos y carpetas que se borran. */
  remove: string[];
}

/**
 * Qué quita `sdlc uninstall` (historia #15, RFC § Rollback): los hooks y deny rules del
 * gate en `.claude/settings.json`, el gate, `.claude/sdlc/` y el bloque de `CLAUDE.md`.
 * El resto de esos archivos, `.mcp.json` y `.gitignore` quedan como están.
 */
export function planUninstall(root: string): UninstallPlan {
  const plan: UninstallPlan = { rewrite: [], remove: [] };

  const settingsPath = join(root, PATHS.settings);
  if (existsSync(settingsPath)) {
    const before = readFileSync(settingsPath, 'utf8');
    const after = stripSettings(before);
    if (after !== before) plan.rewrite.push({ path: PATHS.settings, after });
  }

  const mdPath = join(root, PATHS.claudeMd);
  if (existsSync(mdPath)) {
    const before = readFileSync(mdPath, 'utf8');
    const after = stripBlock(before);
    if (after !== before) plan.rewrite.push({ path: PATHS.claudeMd, after });
  }

  for (const p of [PATHS.gate, '.claude/sdlc']) if (existsSync(join(root, p))) plan.remove.push(p);
  return plan;
}

export function stripSettings(text: string): string {
  const s = JSON.parse(text) as Record<string, unknown>;
  const hooks = s.hooks as Record<string, unknown> | undefined;
  if (hooks && typeof hooks === 'object') {
    for (const [event, list] of Object.entries(hooks)) {
      if (!Array.isArray(list)) continue;
      const kept = list.filter((entry) => !JSON.stringify(entry).includes('sdlc-gate.mjs'));
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
    }
    if (Object.keys(hooks).length === 0) delete s.hooks;
  }
  const permissions = s.permissions as { deny?: unknown } | undefined;
  if (permissions && Array.isArray(permissions.deny)) {
    permissions.deny = permissions.deny.filter((r) => !DENY_RULES.includes(r as string));
    if ((permissions.deny as unknown[]).length === 0) delete permissions.deny;
    if (Object.keys(permissions).length === 0) delete s.permissions;
  }
  return JSON.stringify(s, null, 2) + '\n';
}

export function stripBlock(text: string): string {
  const start = text.indexOf(BLOCK_BEGIN);
  const end = text.indexOf(BLOCK_END);
  if (start === -1 || end < start) return text;
  const before = text.slice(0, start).replace(/\n+$/, '\n');
  const after = text.slice(end + BLOCK_END.length).replace(/^\n+/, '');
  return (before.trim() === '' ? '' : before) + after;
}

export interface UninstallDeps {
  cwd: string;
  confirm: (question: string) => Promise<boolean>;
  log: (line: string) => void;
}

export async function runUninstall(
  deps: UninstallDeps,
): Promise<{ applied: boolean; plan: UninstallPlan }> {
  const tree = gitTree(deps.cwd);
  if (!tree) throw new Error('no es un repo git');
  if (tree.top !== tree.mainRoot)
    throw new Error(`corré \`sdlc uninstall\` desde el checkout principal (${tree.mainRoot})`);
  const plan = planUninstall(tree.mainRoot);
  if (plan.rewrite.length === 0 && plan.remove.length === 0) {
    deps.log('No hay nada de sdlc instalado en este repo.');
    return { applied: true, plan };
  }
  for (const r of plan.rewrite) deps.log(`- se limpia ${r.path}`);
  for (const p of plan.remove) deps.log(`- se borra ${p}`);
  if (!(await deps.confirm('¿Desinstalar el gate de este repo?'))) {
    deps.log('Cancelado: no se tocó nada.');
    return { applied: false, plan };
  }
  for (const r of plan.rewrite) writeFileSync(join(tree.mainRoot, r.path), r.after);
  for (const p of plan.remove) rmSync(join(tree.mainRoot, p), { recursive: true, force: true });
  deps.log('Listo. Reiniciá la sesión de Claude Code para que deje de cargar los hooks.');
  return { applied: true, plan };
}
