import { CONFIG_PATH, DEFAULT_EXCLUDE } from '../gate/config.js';
import { hookCommand } from '../hooks.js';

/**
 * Qué escribe `sdlc init` en el repo (historia #13, RFC sdlc-repo-onboarding § CLI init).
 *
 * Es una función pura: recibe el contenido actual de cada archivo y devuelve el nuevo.
 * Todo es merge: se respetan las claves del usuario y se reemplazan sólo las entradas y
 * bloques de sdlc, así que correrlo dos veces no cambia nada la segunda.
 */
export interface InstallInput {
  serverUrl: string;
  workspace: string;
  exclude: string[];
  defaultBranch: string;
  /** Commit desde el que se instaló: el Rollback del RFC lo usa para volver atrás. */
  installedFrom: string;
  /** Contenido de `sdlc-gate.mjs` (el bundle). */
  gateSource: string;
  /** Versión del CLI que instala y de dónde corre (npm o monorepo). */
  installedWith?: { version: string; origin: 'npm' | 'monorepo' };
  /** Contenido actual de cada archivo, o `undefined` si no existe. */
  current: Record<string, string | undefined>;
}

export interface FileChange {
  path: string;
  before: string | undefined;
  after: string;
}

export const PATHS = {
  mcp: '.mcp.json',
  settings: '.claude/settings.json',
  gate: '.claude/hooks/sdlc-gate.mjs',
  config: CONFIG_PATH,
  gitignore: '.gitignore',
  claudeMd: 'CLAUDE.md',
} as const;

export const MANAGED_PATHS: readonly string[] = Object.values(PATHS);

const PRE_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit|Bash';
const POST_MATCHER = 'mcp__sdlc__claim_story';

/** Segunda capa de protección, independiente del gate (RFC § Security). */
export const DENY_RULES = [
  'Edit(.claude/settings*.json)',
  'Edit(.claude/hooks/**)',
  'Edit(.claude/sdlc/**)',
  'Edit(.mcp.json)',
];

export const GITIGNORE_LINES = [
  '.claude/sdlc/lease.json',
  '.claude/sdlc/cache.json',
  '.claude/worktrees/',
];

export const BLOCK_BEGIN = '<!-- sdlc:begin -->';
export const BLOCK_END = '<!-- sdlc:end -->';

/** Sólo los archivos que cambian. */
export function planInstall(input: InstallInput): FileChange[] {
  const c = input.current;
  const changes: FileChange[] = [
    { path: PATHS.mcp, before: c[PATHS.mcp], after: mergeMcp(c[PATHS.mcp], input.serverUrl) },
    { path: PATHS.settings, before: c[PATHS.settings], after: mergeSettings(c[PATHS.settings]) },
    { path: PATHS.gate, before: c[PATHS.gate], after: input.gateSource },
    { path: PATHS.config, before: c[PATHS.config], after: configJson(input, c[PATHS.config]) },
    {
      path: PATHS.gitignore,
      before: c[PATHS.gitignore],
      after: mergeGitignore(c[PATHS.gitignore]),
    },
    {
      path: PATHS.claudeMd,
      before: c[PATHS.claudeMd],
      after: mergeClaudeMd(c[PATHS.claudeMd], input),
    },
  ];
  return changes.filter((ch) => ch.before !== ch.after);
}

export function mergeMcp(before: string | undefined, serverUrl: string): string {
  const obj = parseObject(before, PATHS.mcp);
  const servers = asObject(obj.mcpServers);
  servers.sdlc = { type: 'http', url: `${serverUrl.replace(/\/+$/, '')}/mcp` };
  obj.mcpServers = servers;
  return json(obj);
}

export function mergeSettings(before: string | undefined): string {
  const obj = parseObject(before, PATHS.settings);
  const hooks = asObject(obj.hooks);
  hooks.PreToolUse = [...withoutGate(hooks.PreToolUse), hookEntry(PRE_MATCHER, 'pre')];
  hooks.PostToolUse = [...withoutGate(hooks.PostToolUse), hookEntry(POST_MATCHER, 'post')];
  obj.hooks = hooks;

  const permissions = asObject(obj.permissions);
  const deny = Array.isArray(permissions.deny) ? (permissions.deny as unknown[]) : [];
  permissions.deny = [...deny, ...DENY_RULES.filter((r) => !deny.includes(r))];
  obj.permissions = permissions;
  return json(obj);
}

function hookEntry(matcher: string, mode: 'pre' | 'post') {
  return { matcher, hooks: [{ type: 'command', command: hookCommand(mode) }] };
}

/** Las entradas de hooks que no son del gate quedan tal cual; las del gate se reemplazan. */
function withoutGate(list: unknown): unknown[] {
  if (!Array.isArray(list)) return [];
  return list.filter((entry) => !JSON.stringify(entry).includes('sdlc-gate.mjs'));
}

function configJson(input: InstallInput, before: string | undefined): string {
  let installedFrom = input.installedFrom;
  if (before !== undefined) {
    const prev = parseObject(before, PATHS.config);
    // Se conserva el de la primera instalación: es el punto al que vuelve el rollback.
    if (typeof prev.installed_from === 'string') installedFrom = prev.installed_from;
  }
  return json({
    version: 1,
    server_url: input.serverUrl.replace(/\/+$/, ''),
    workspace: input.workspace,
    default_branch: input.defaultBranch,
    exclude: input.exclude,
    installed_from: installedFrom,
    ...(input.installedWith ? { installed_with: input.installedWith } : {}),
  });
}

export function mergeGitignore(before: string | undefined): string {
  const text = before ?? '';
  const have = new Set(text.split('\n').map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length === 0) return text;
  const sep = text === '' || text.endsWith('\n') ? '' : '\n';
  const header = text === '' ? '' : '\n';
  return `${text}${sep}${header}# sdlc (gate)\n${missing.join('\n')}\n`;
}

export function mergeClaudeMd(
  before: string | undefined,
  input: Pick<InstallInput, 'workspace' | 'exclude'>,
): string {
  const block = claudeMdBlock(input);
  const text = before ?? '';
  const start = text.indexOf(BLOCK_BEGIN);
  const end = text.indexOf(BLOCK_END);
  if (start !== -1 && end > start) {
    return text.slice(0, start) + block + text.slice(end + BLOCK_END.length);
  }
  const sep = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return `${text}${sep}${block}\n`;
}

function claudeMdBlock(input: Pick<InstallInput, 'workspace' | 'exclude'>): string {
  const exclude = [...DEFAULT_EXCLUDE, ...input.exclude].map((e) => `\`${e}\``).join(', ');
  return [
    BLOCK_BEGIN,
    '## Flujo SDLC',
    '',
    `Este repo tiene el SDLC obligatorio activado (workspace \`${input.workspace}\`). Un gate en los hooks de Claude Code`,
    'deniega ediciones y commits que no pertenezcan a una historia reclamada.',
    '',
    '1. Al empezar la sesión corré `sdlc doctor`.',
    '2. No se trabaja en la branch default: creá una branch, o un worktree en `.claude/worktrees/{slug}` para trabajo en paralelo.',
    '3. Antes de editar, reclamá la historia con `claim_story`: el gate guarda el lease de la sesión.',
    '4. Cada `git commit`/`git push` se valida contra el server y queda registrado.',
    '5. Si el gate deniega, el mensaje dice el próximo paso. `sdlc bypass` es sólo para personas, desde una terminal.',
    '',
    `No requieren historia: ${exclude}.`,
    'No se editan (sólo los cambia `sdlc init`): `.claude/settings*.json`, `.claude/hooks/sdlc-gate.mjs`, `.claude/sdlc/`, `.mcp.json`.',
    BLOCK_END,
  ].join('\n');
}

function parseObject(text: string | undefined, path: string): Record<string, unknown> {
  if (text === undefined || text.trim() === '') return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error(`${path} no es JSON válido: arreglalo a mano antes de correr init`);
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw new Error(`${path} no es un objeto JSON`);
  return v as Record<string, unknown>;
}

function asObject(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function json(v: unknown): string {
  return JSON.stringify(v, null, 2) + '\n';
}
