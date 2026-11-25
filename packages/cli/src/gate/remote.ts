import { execFileSync } from 'node:child_process';

/**
 * Repo normalizado para el server: `host/owner/repo` desde el remote `origin`, sin
 * protocolo, credenciales ni `.git`. Así una URL https y una ssh del mismo repo dan lo
 * mismo. Sin `origin`, la ruta local del checkout principal.
 */
export function repoId(mainRoot: string): string {
  let url: string;
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: mainRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return `local:${mainRoot}`;
  }
  return normalizeRemote(url);
}

export function normalizeRemote(url: string): string {
  let u = url.trim();
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(u); // git@github.com:owner/repo.git
  if (scp) u = `${scp[1]}/${scp[2]}`;
  else {
    u = u.replace(/^[a-z+]+:\/\//i, ''); // https://, ssh://, git+ssh://
    u = u.replace(/^[^@/]+@/, ''); // usuario o token
  }
  u = u.replace(/\.git\/?$/, '').replace(/\/+$/, '');
  const slash = u.indexOf('/');
  const host = (slash === -1 ? u : u.slice(0, slash)).replace(/:\d+$/, '').toLowerCase();
  return slash === -1 ? host : `${host}${u.slice(slash)}`;
}
