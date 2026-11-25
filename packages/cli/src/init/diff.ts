/**
 * Diff de líneas para mostrar en `init` qué cambia en cada archivo. Los archivos que toca
 * son chicos (configs, un bloque de CLAUDE.md), así que alcanza con LCS cuadrático.
 */
export function lineDiff(before: string | undefined, after: string): string[] {
  const a = before === undefined ? [] : before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return compact(out);
}

/** Deja 2 líneas de contexto alrededor de cada cambio y colapsa el resto. */
function compact(lines: string[], context = 2): string[] {
  const keep = new Set<number>();
  lines.forEach((l, idx) => {
    if (!l.startsWith('  ')) for (let k = idx - context; k <= idx + context; k++) keep.add(k);
  });
  const out: string[] = [];
  let skipped = false;
  lines.forEach((l, idx) => {
    if (keep.has(idx)) {
      out.push(l);
      skipped = false;
    } else if (!skipped) {
      out.push('  …');
      skipped = true;
    }
  });
  return out;
}
