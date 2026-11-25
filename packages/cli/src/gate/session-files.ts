import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Archivos del gate en la raíz de la sesión (checkout principal o worktree), los dos
 * gitignored y protegidos: `lease.json` (lo escribe el PostToolUse de `claim_story` o
 * `sdlc bypass`) y `cache.json` (sólo acelera edits; el commit no la usa nunca).
 */
export interface LeaseFile {
  lease_id: string;
  kind: 'story' | 'bypass';
  story_id?: string;
  expires_at: string;
}

export interface CacheFile {
  lease_hash: string;
  valid_until: string;
}

export const leasePath = (root: string) => join(root, '.claude', 'sdlc', 'lease.json');
export const cachePath = (root: string) => join(root, '.claude', 'sdlc', 'cache.json');

export function hashLease(leaseId: string): string {
  return createHash('sha256').update(leaseId).digest('hex');
}

/** `undefined` si no hay archivo; si está pero no tiene la forma esperada, tira (→ deny). */
export function readLease(root: string): LeaseFile | undefined {
  const raw = readJson(leasePath(root));
  if (raw === undefined) return undefined;
  const l = raw as Partial<LeaseFile>;
  if (
    typeof l.lease_id !== 'string' ||
    !l.lease_id ||
    (l.kind !== 'story' && l.kind !== 'bypass')
  ) {
    throw new Error('lease.json con un formato inesperado');
  }
  return l as LeaseFile;
}

export function writeLease(root: string, lease: LeaseFile): void {
  writeJsonAtomic(leasePath(root), lease);
}

export function readCache(root: string): CacheFile | undefined {
  try {
    const c = readJson(cachePath(root)) as Partial<CacheFile> | undefined;
    return c && typeof c.lease_hash === 'string' && typeof c.valid_until === 'string'
      ? (c as CacheFile)
      : undefined;
  } catch {
    // Una caché rota sólo hace que se valide online.
    return undefined;
  }
}

export function writeCache(root: string, cache: CacheFile): void {
  writeJsonAtomic(cachePath(root), cache);
}

/** Un lease que el server ya no acepta: se borra junto con la caché. */
export function clearSession(root: string): void {
  rmSync(leasePath(root), { force: true });
  rmSync(cachePath(root), { force: true });
}

function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return JSON.parse(text);
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}
