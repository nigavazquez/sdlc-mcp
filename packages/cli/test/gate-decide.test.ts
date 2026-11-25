import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GateConfig } from '../src/gate/config.js';
import { decidePre, type PreDecision } from '../src/gate/decide.js';

// Historia #10 (épica #5). Seam: `decidePre`, los pasos 1-6 del orden de evaluación del
// gate, contra repos git reales: checkout principal, worktrees y un repo ajeno.

let base: string;
let repo: string;
let goodWt: string;
let badWt: string;
let otherRepo: string;
const config: GateConfig = {
  version: 1,
  server_url: 'http://localhost:3100',
  workspace: 'demo',
  default_branch: 'main',
  exclude: ['notes/**'],
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });

function initRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.org');
  git(dir, 'config', 'user.name', 'T');
  writeFileSync(join(dir, 'README.md'), 'x');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-decide-')));
  repo = join(base, 'repo');
  initRepo(repo);
  goodWt = join(repo, '.claude', 'worktrees', 'feat-a');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/a', goodWt);
  badWt = join(base, 'afuera');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/b', badWt);
  otherRepo = join(base, 'otro');
  initRepo(otherRepo);
});

const edit = (file_path: string, cwd = repo): PreDecision =>
  decidePre({ tool_name: 'Edit', tool_input: { file_path }, cwd }, repo, config);
const bash = (command: string, cwd = repo): PreDecision =>
  decidePre({ tool_name: 'Bash', tool_input: { command }, cwd }, repo, config);

function onBranch(branch: string, fn: () => void) {
  git(repo, 'switch', '-q', '-c', branch);
  try {
    fn();
  } finally {
    git(repo, 'switch', '-q', 'main');
    git(repo, 'branch', '-q', '-D', branch);
  }
}

describe('protegidos (deny siempre)', () => {
  it.each([
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.claude/hooks/sdlc-gate.mjs',
    '.claude/sdlc/config.json',
    '.claude/sdlc/lease.json',
    '.mcp.json',
  ])('Edit de %s se deniega, también desde una branch con trabajo', (p) => {
    expect(edit(join(repo, p))).toMatchObject({
      decision: 'deny',
      reason: expect.stringMatching(/protegido/),
    });
    onBranch('feat/z', () => expect(edit(join(repo, p)).decision).toBe('deny'));
  });

  it('la copia de un worktree también está protegida', () => {
    expect(edit(join(goodWt, '.claude/sdlc/lease.json'), goodWt).decision).toBe('deny');
  });

  it('un Bash que nombra un archivo protegido se deniega, aunque no sea un commit', () => {
    expect(bash('echo {} > .claude/sdlc/lease.json').decision).toBe('deny');
    expect(bash('cat .mcp.json').decision).toBe('deny');
    expect(bash('sed -i "" s/x/y/ .claude/settings.json').decision).toBe('deny');
  });
});

describe('lo que pasa sin lease', () => {
  it('rutas excluidas por default y por config', () => {
    for (const p of [
      'CLAUDE.md',
      'docs/a.md',
      'docs/rfc/b.md',
      '.claude/skills/x/SKILL.md',
      'notes/todo.txt',
    ]) {
      expect(edit(join(repo, p))).toEqual({ decision: 'allow' });
    }
    expect(edit(join(repo, 'docs/diagram.png')).decision).not.toBe('allow');
  });

  it('rutas fuera del repo (sin git o de otro repo)', () => {
    expect(edit(join(base, 'suelto.txt'))).toEqual({ decision: 'allow' });
    expect(edit(join(otherRepo, 'src/x.ts'))).toEqual({ decision: 'allow' });
  });

  it('un Bash que no es git commit ni git push', () => {
    expect(bash('pnpm test && git status')).toEqual({ decision: 'allow' });
    expect(bash('git log --oneline -5')).toEqual({ decision: 'allow' });
  });

  it('un commit en otro repo no es asunto de este gate', () => {
    expect(bash('git commit -m x', otherRepo)).toEqual({ decision: 'allow' });
  });
});

describe('ubicación de la sesión', () => {
  it('checkout principal en la branch default: deny con el próximo paso', () => {
    expect(edit(join(repo, 'src/x.ts'))).toMatchObject({
      decision: 'deny',
      reason: expect.stringMatching(/branch default \(main\)/),
      next: expect.stringMatching(/creá una branch/),
    });
    expect(bash('git commit -m x').decision).toBe('deny');
  });

  it('worktree fuera de .claude/worktrees/: deny', () => {
    expect(edit(join(badWt, 'src/x.ts'), badWt)).toMatchObject({
      decision: 'deny',
      next: expect.stringMatching(/\.claude\/worktrees/),
    });
  });

  it('otra branch del checkout principal: sigue a la validación del lease', () => {
    onBranch('feat/c', () => {
      expect(edit(join(repo, 'src/x.ts'))).toEqual({
        decision: 'needs_lease',
        action: 'edit',
        root: repo,
        branch: 'feat/c',
        path: 'src/x.ts',
      });
      expect(bash('git add . && git commit -m x')).toMatchObject({
        decision: 'needs_lease',
        action: 'commit',
      });
      expect(bash('git -C . push origin HEAD')).toMatchObject({
        decision: 'needs_lease',
        action: 'commit',
      });
    });
  });

  it('worktree bajo .claude/worktrees/: sigue a la validación del lease', () => {
    expect(edit('src/nuevo/archivo.ts', goodWt)).toEqual({
      decision: 'needs_lease',
      action: 'edit',
      root: goodWt,
      branch: 'feat/a',
      path: 'src/nuevo/archivo.ts',
    });
  });

  it('editar el checkout principal desde un worktree se evalúa por el árbol del archivo', () => {
    expect(edit(join(repo, 'src/x.ts'), goodWt).decision).toBe('deny');
  });
});

describe('fallar cerrado', () => {
  it('una herramienta no prevista se deniega', () => {
    expect(decidePre({ tool_name: 'Read', tool_input: {} }, repo, config).decision).toBe('deny');
  });

  it('un Edit sin ruta tira (el gate lo convierte en deny)', () => {
    expect(() => decidePre({ tool_name: 'Edit', tool_input: {} }, repo, config)).toThrow();
  });

  it('un proyecto que no es un repo git tira', () => {
    expect(() =>
      decidePre({ tool_name: 'Edit', tool_input: { file_path: '/x' } }, base, config),
    ).toThrow();
  });
});
