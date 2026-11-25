/**
 * Glob mínimo para las exclusiones del gate, sobre rutas relativas con `/`:
 * `**` es cualquier cantidad de directorios (cero incluido) y `*` cualquier cosa dentro
 * de un segmento. Sin dependencias: el gate es un único archivo que corre con `node`.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(relPath: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(relPath));
}
