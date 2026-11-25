import { beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeServerCredential } from '../src/credentials.js';
import { runInit, type InitDeps, type Prompter } from '../src/init/init.js';
import { BLOCK_BEGIN, BLOCK_END, DENY_RULES, planInstall } from '../src/init/plan.js';

// Historia #13 (épica #5). Seams: `runInit` (el asistente, con preguntas y server
// inyectados) contra un repo git real, y `planInstall` (qué se escribe).

const SERVER = 'http://localhost:3100';
let repo: string;
let xdg: string;

const git = (...a: string[]) =>
  execFileSync('git', a, { cwd: repo, stdio: 'pipe', encoding: 'utf8' }).trim();
const read = (p: string) => readFileSync(join(repo, p), 'utf8');
const readJson = (p: string) => JSON.parse(read(p));

function loggedIn() {
  writeServerCredential(
    SERVER,
    {
      client_id: 'c',
      token_endpoint: `${SERVER}/oauth/token`,
      access_token: 'at',
      refresh_token: 'rt',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    },
    { XDG_CONFIG_HOME: xdg },
  );
}

/** Responde en orden; registra las preguntas que se hicieron. */
function scripted(answers: string[], confirm = true) {
  const asked: string[] = [];
  const prompter: Prompter = {
    ask: async (q, def) => {
      asked.push(q);
      const a = answers.shift();
      if (a === undefined) throw new Error(`pregunta sin respuesta: ${q}`);
      return a === '' && def !== undefined ? def : a;
    },
    confirm: async (q) => {
      asked.push(q);
      return confirm;
    },
  };
  return { prompter, asked };
}

function deps(prompter: Prompter, extra: Partial<InitDeps> = {}): InitDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    cwd: repo,
    prompter,
    log: (l) => lines.push(l),
    gateSource: '// gate\n',
    login: async () => loggedIn(),
    listWorkspaces: async () => ['cliente-a', 'sdlc-mcp'],
    env: { XDG_CONFIG_HOME: xdg },
    lines,
    ...extra,
  };
}

beforeEach(() => {
  repo = join(realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-init-'))), 'repo');
  mkdirSync(join(repo, '.claude'), { recursive: true });
  xdg = mkdtempSync(join(tmpdir(), 'sdlc-xdg-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.org');
  git('config', 'user.name', 'T');
  // Archivos del usuario que init tiene que respetar.
  writeFileSync(
    join(repo, '.claude', 'settings.json'),
    JSON.stringify({
      model: 'opus',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo propio' }] }],
      },
      permissions: { allow: ['Bash(pnpm test)'], deny: ['Read(.env)'] },
    }),
  );
  writeFileSync(
    join(repo, '.mcp.json'),
    JSON.stringify({ mcpServers: { otro: { type: 'stdio', command: 'x' } } }),
  );
  writeFileSync(join(repo, 'CLAUDE.md'), '# Proyecto\n\nReglas propias.\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
});

describe('sdlc init', () => {
  it('pregunta server, workspace y exclusiones, muestra el diff y escribe todo tras confirmar', async () => {
    loggedIn();
    const { prompter, asked } = scripted(['', 'sdlc-mcp', 'docs/backlog/**']);
    const d = deps(prompter);
    const out = await runInit(d);

    expect(asked).toEqual([
      'URL del server sdlc',
      'Workspace para este repo (escribilo tal cual)',
      'Exclusiones extra, separadas por coma (vacío = ninguna)',
      '¿Escribir estos 6 archivos?',
    ]);
    expect(d.lines.join('\n')).toMatch(/── \.claude\/settings\.json \(modificado\)/);
    expect(d.lines.join('\n')).toMatch(/\+ .*sdlc-gate\.mjs/);
    expect(out.written.sort()).toEqual(
      [
        '.claude/hooks/sdlc-gate.mjs',
        '.claude/sdlc/config.json',
        '.claude/settings.json',
        '.gitignore',
        '.mcp.json',
        'CLAUDE.md',
      ].sort(),
    );

    expect(readJson('.mcp.json').mcpServers).toEqual({
      otro: { type: 'stdio', command: 'x' },
      sdlc: { type: 'http', url: `${SERVER}/mcp` },
    });
    const settings = readJson('.claude/settings.json');
    expect(settings.model).toBe('opus');
    expect(settings.permissions.allow).toEqual(['Bash(pnpm test)']);
    expect(settings.permissions.deny).toEqual(['Read(.env)', ...DENY_RULES]);
    expect(JSON.stringify(settings.hooks.PreToolUse)).toContain('echo propio');
    expect(JSON.stringify(settings.hooks.PreToolUse)).toContain('sdlc-gate.mjs\\" pre || exit 2');
    expect(settings.hooks.PostToolUse[0].matcher).toBe('mcp__sdlc__claim_story');

    expect(read('.claude/hooks/sdlc-gate.mjs')).toBe('// gate\n');
    expect(statSync(join(repo, '.claude/hooks/sdlc-gate.mjs')).mode & 0o111).not.toBe(0);
    expect(readJson('.claude/sdlc/config.json')).toEqual({
      version: 1,
      server_url: SERVER,
      workspace: 'sdlc-mcp',
      default_branch: 'main',
      exclude: ['docs/backlog/**'],
      installed_from: git('rev-parse', 'HEAD'),
    });
    expect(read('.gitignore')).toMatch(
      /node_modules\/\n\n# sdlc \(gate\)\n\.claude\/sdlc\/lease\.json\n\.claude\/sdlc\/cache\.json\n\.claude\/worktrees\/\n/,
    );
    expect(read('CLAUDE.md')).toMatch(
      /^# Proyecto\n\nReglas propias\.\n\n<!-- sdlc:begin -->\n## Flujo SDLC/,
    );
  });

  it('la segunda corrida no genera cambios', async () => {
    loggedIn();
    await runInit(deps(scripted(['', 'sdlc-mcp', '']).prompter));

    git('add', '.');
    git('commit', '-q', '-m', 'instalado');
    const before = Object.fromEntries(
      [
        '.mcp.json',
        '.claude/settings.json',
        '.claude/sdlc/config.json',
        '.gitignore',
        'CLAUDE.md',
      ].map((p) => [p, read(p)]),
    );

    const { prompter, asked } = scripted(['', 'sdlc-mcp', '']);
    const d = deps(prompter);
    const again = await runInit(d);
    expect(again.written).toEqual([]);
    expect(asked).not.toContain('¿Escribir estos 6 archivos?');
    expect(d.lines.join('\n')).toMatch(/Nada que cambiar/);
    for (const [p, content] of Object.entries(before)) expect(read(p)).toBe(content);
  });

  it('no deja .bak de lo que git ya respalda (trackeado y sin cambios)', async () => {
    loggedIn();
    const d = deps(scripted(['', 'sdlc-mcp', '']).prompter);
    await runInit(d);
    expect(git('status', '--porcelain', '--untracked-files=all')).not.toMatch(/\.bak$/m);
    expect(d.lines.join('\n')).not.toMatch(/\.bak/);
  });

  it('deja .bak sólo de lo trackeado con cambios sin commitear y lo lista', async () => {
    loggedIn();
    writeFileSync(join(repo, 'CLAUDE.md'), '# Proyecto\n\nCambio sin commitear.\n');
    const d = deps(scripted(['', 'sdlc-mcp', '']).prompter);
    await runInit(d);
    expect(read('CLAUDE.md.bak')).toBe('# Proyecto\n\nCambio sin commitear.\n');
    expect(existsSync(join(repo, '.gitignore.bak'))).toBe(false);
    expect(existsSync(join(repo, '.claude/settings.json.bak'))).toBe(false);
    expect(d.lines.join('\n')).toMatch(/Backup de lo que git no respalda: CLAUDE\.md\.bak\./);
  });

  it('deja .bak de un archivo existente que git no trackea', async () => {
    loggedIn();
    git('rm', '-q', '--cached', '.mcp.json');
    git('commit', '-q', '-m', 'sin mcp');
    await runInit(deps(scripted(['', 'sdlc-mcp', '']).prompter));
    expect(readJson('.mcp.json.bak')).toEqual({
      mcpServers: { otro: { type: 'stdio', command: 'x' } },
    });
    expect(existsSync(join(repo, 'CLAUDE.md.bak'))).toBe(false);
  });

  it('el workspace se elige escribiéndolo: uno que no está en la lista se vuelve a preguntar', async () => {
    loggedIn();
    const { prompter, asked } = scripted(['', 'otro-cliente', 'cliente-a', '']);
    await runInit(deps(prompter));
    expect(asked.filter((q) => q.startsWith('Workspace'))).toHaveLength(2);
    expect(readJson('.claude/sdlc/config.json').workspace).toBe('cliente-a');
  });

  it('sin confirmar no escribe nada', async () => {
    loggedIn();
    const out = await runInit(deps(scripted(['', 'sdlc-mcp', ''], false).prompter));
    expect(out.applied).toBe(false);
    expect(existsSync(join(repo, '.claude/sdlc/config.json'))).toBe(false);
    expect(read('CLAUDE.md')).toBe('# Proyecto\n\nReglas propias.\n');
  });

  it('sin sesión con el server dispara el login antes de listar workspaces', async () => {
    let logins = 0;
    const d = deps(scripted(['', 'sdlc-mcp', '']).prompter, {
      login: async () => {
        logins++;
        loggedIn();
      },
    });
    await runInit(d);
    expect(logins).toBe(1);
  });

  it('con un workspace por flag que no es tuyo falla sin escribir', async () => {
    loggedIn();
    await expect(
      runInit(
        deps(scripted([]).prompter, {
          flags: { server: SERVER, workspace: 'ajeno', exclude: [], yes: true },
        }),
      ),
    ).rejects.toThrow(/no pertenecés/);
    expect(existsSync(join(repo, '.claude/sdlc'))).toBe(false);
  });

  it('desde un worktree pide correrlo en el checkout principal', async () => {
    const wt = join(repo, '.claude', 'worktrees', 'x');
    git('worktree', 'add', '-q', '-b', 'feat/x', wt);
    await expect(runInit(deps(scripted([]).prompter, { cwd: wt }))).rejects.toThrow(
      /checkout principal/,
    );
  });
  it('si .gitignore ignora .claude/, avisa que el gate no se va a versionar', async () => {
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.claude/\n');
    loggedIn();
    const d = deps(scripted(['', 'sdlc-mcp', '']).prompter);
    await runInit(d);
    const out = d.lines.join('\n');
    expect(out).toMatch(/Atención: \.gitignore ignora .*\.claude\/settings\.json/);
    expect(out).toMatch(/reemplazá `\.claude\/` por `\.claude\/\*`/);
  });

  it('sin nada ignorado no avisa', async () => {
    loggedIn();
    const d = deps(scripted(['', 'sdlc-mcp', '']).prompter);
    await runInit(d);
    expect(d.lines.join('\n')).not.toMatch(/Atención/);
  });
});

describe('planInstall', () => {
  const base = {
    serverUrl: SERVER,
    workspace: 'ws',
    exclude: [],
    defaultBranch: 'main',
    installedFrom: 'abc',
    gateSource: 'g',
  };

  it('aplicado sobre su propia salida no cambia nada (idempotente)', () => {
    const first = planInstall({ ...base, current: {} });
    const current = Object.fromEntries(first.map((c) => [c.path, c.after]));
    expect(planInstall({ ...base, current })).toEqual([]);
  });

  it('reemplaza el bloque marcado de CLAUDE.md sin tocar lo de afuera', () => {
    const md = `antes\n${BLOCK_BEGIN}\nviejo\n${BLOCK_END}\ndespués\n`;
    const out = planInstall({ ...base, current: { 'CLAUDE.md': md } }).find(
      (c) => c.path === 'CLAUDE.md',
    )!.after;
    expect(out.startsWith('antes\n<!-- sdlc:begin -->\n## Flujo SDLC')).toBe(true);
    expect(out.endsWith(`${BLOCK_END}\ndespués\n`)).toBe(true);
    expect(out).not.toContain('viejo');
  });

  it('una entrada vieja del gate en los hooks se reemplaza, no se duplica', () => {
    const old = JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit',
            hooks: [{ type: 'command', command: 'node .claude/hooks/sdlc-gate.mjs pre' }],
          },
        ],
      },
    });
    const s = JSON.parse(
      planInstall({ ...base, current: { '.claude/settings.json': old } }).find(
        (c) => c.path === '.claude/settings.json',
      )!.after,
    );
    expect(s.hooks.PreToolUse).toHaveLength(1);
    expect(s.hooks.PreToolUse[0].matcher).toBe('Edit|Write|MultiEdit|NotebookEdit|Bash');
  });

  it('un settings.json que no es JSON se rechaza en vez de pisarlo', () => {
    expect(() => planInstall({ ...base, current: { '.claude/settings.json': '{ roto' } })).toThrow(
      /no es JSON válido/,
    );
  });

  it('reinstalar conserva el installed_from de la primera vez', () => {
    const first = planInstall({ ...base, current: {} });
    const current = Object.fromEntries(first.map((c) => [c.path, c.after]));
    expect(planInstall({ ...base, installedFrom: 'otro', current })).toEqual([]);
  });
});
