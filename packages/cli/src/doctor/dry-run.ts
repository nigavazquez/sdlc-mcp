import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeServerCredential } from '../credentials.js';
import { CONFIG_PATH } from '../gate/config.js';
import { writeLease } from '../gate/session-files.js';

export interface DryRunCase {
  name: string;
  expected: 'allow' | 'deny';
  got: 'allow' | 'deny' | 'error';
  reason?: string;
  ok: boolean;
}

/** Un puerto donde no escucha nadie: los casos no registran eventos falsos en el server real. */
const UNREACHABLE = 'http://127.0.0.1:9';

/**
 * Dry-run del gate instalado (RFC § CLI doctor) contra un repo temporal, en una branch
 * de trabajo y con el server apuntando a un puerto sin nadie. Así se prueba el archivo
 * que corre de verdad en los hooks, sin tocar el repo ni la métrica del workspace.
 */
export function dryRunGate(gatePath: string): DryRunCase[] {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-doctor-')));
  try {
    const repo = join(base, 'repo');
    const xdg = join(base, 'xdg');
    mkdirSync(join(repo, '.claude', 'sdlc'), { recursive: true });
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git(
      '-c',
      'user.email=doctor@sdlc',
      '-c',
      'user.name=doctor',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'doctor',
    );
    git('switch', '-q', '-c', 'feat/doctor');
    writeFileSync(
      join(repo, CONFIG_PATH),
      JSON.stringify({
        version: 1,
        server_url: UNREACHABLE,
        workspace: 'doctor',
        default_branch: 'main',
        exclude: [],
      }),
    );
    // Credencial falsa: sin ella el caso "server inaccesible" fallaría antes, por falta de login.
    writeServerCredential(
      UNREACHABLE,
      {
        client_id: 'doctor',
        token_endpoint: `${UNREACHABLE}/oauth/token`,
        access_token: 'doctor',
        refresh_token: 'doctor',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
      { XDG_CONFIG_HOME: xdg },
    );

    const run = (event: unknown) => runGate(gatePath, repo, xdg, event);
    const edit = {
      tool_name: 'Edit',
      tool_input: { file_path: join(repo, 'src', 'x.ts') },
      cwd: repo,
    };
    const cases: DryRunCase[] = [];
    cases.push(check('Edit sin lease', 'deny', run(edit)));
    cases.push(
      check(
        'ruta excluida (CLAUDE.md)',
        'allow',
        run({ ...edit, tool_input: { file_path: join(repo, 'CLAUDE.md') } }),
      ),
    );
    cases.push(
      check(
        'commit sin lease',
        'deny',
        run({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: repo }),
      ),
    );
    writeLease(repo, {
      lease_id: 'gl_doctor',
      kind: 'story',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const offline = run(edit);
    cases.push(check('server inaccesible', 'deny', offline, /no disponible/));
    return cases;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function runGate(
  gatePath: string,
  repo: string,
  xdg: string,
  event: unknown,
): { got: 'allow' | 'deny' | 'error'; reason?: string } {
  const r = spawnSync(process.execPath, [gatePath, 'pre'], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo, XDG_CONFIG_HOME: xdg },
  });
  if (r.status !== 0) return { got: 'error', reason: `salió con ${r.status ?? r.signal}` };
  if (r.stdout.trim() === '') return { got: 'allow' };
  try {
    const out = JSON.parse(r.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    const reason = out.hookSpecificOutput?.permissionDecisionReason;
    return out.hookSpecificOutput?.permissionDecision === 'deny'
      ? { got: 'deny', ...(reason ? { reason } : {}) }
      : { got: 'error', reason: 'salida inesperada' };
  } catch {
    return { got: 'error', reason: 'la salida no es JSON' };
  }
}

function check(
  name: string,
  expected: 'allow' | 'deny',
  r: { got: 'allow' | 'deny' | 'error'; reason?: string },
  reasonMatch?: RegExp,
): DryRunCase {
  const ok = r.got === expected && (!reasonMatch || reasonMatch.test(r.reason ?? ''));
  return { name, expected, got: r.got, ...(r.reason ? { reason: r.reason } : {}), ok };
}
