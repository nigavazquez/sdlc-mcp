import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/** El árbol de trabajo de git que contiene un directorio. */
export interface GitTree {
  /** Raíz del árbol (checkout principal o worktree). */
  top: string;
  /** `.git` del repo, compartido por el checkout principal y sus worktrees. */
  commonDir: string;
  /** Raíz del checkout principal: el padre de `commonDir`. */
  mainRoot: string;
  /** Branch actual; `HEAD` si está detached. */
  branch: string;
}

/** `undefined` si `dir` no está dentro de un repo git. */
export function gitTree(dir: string): GitTree | undefined {
  let out: string;
  try {
    out = git(dir, ['rev-parse', '--show-toplevel', '--git-common-dir']);
  } catch (err) {
    // Fuera de un repo git sale con 128. Cualquier otra falla (git ausente) se propaga: deny.
    if ((err as { status?: number }).status === 128) return undefined;
    throw err;
  }
  const [top, common] = out.trim().split('\n');
  if (!top || !common) throw new Error('git rev-parse devolvió una salida inesperada');
  const commonDir = realpathSync(isAbsolute(common) ? common : resolve(dir, common));
  return {
    top: realpathSync(top),
    commonDir,
    mainRoot: dirname(commonDir),
    branch: currentBranch(dir),
  };
}

/** `symbolic-ref` y no `rev-parse --abbrev-ref`: funciona también en una branch sin commits. */
function currentBranch(dir: string): string {
  try {
    return git(dir, ['symbolic-ref', '--short', '-q', 'HEAD']).trim() || 'HEAD';
  } catch (err) {
    // Detached: sale con 1 y sin salida.
    if ((err as { status?: number }).status === 1) return 'HEAD';
    throw err;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** El directorio existente más cercano a `path`: un Write puede crear archivos y carpetas nuevas. */
export function nearestExistingDir(path: string): string {
  let p = path;
  while (!existsSync(p)) {
    const parent = dirname(p);
    if (parent === p) return p;
    p = parent;
  }
  return statSync(p).isDirectory() ? p : dirname(p);
}
