import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DENY_RULES } from '../init/plan.js';

/** Un nivel de settings de Claude Code que puede anular el gate. */
export interface SettingsSource {
  label: string;
  path: string;
}

/** Usuario, proyecto, local y managed (RFC § CLI doctor). */
export function settingsSources(root: string, home = homedir()): SettingsSource[] {
  const managed =
    process.platform === 'darwin'
      ? '/Library/Application Support/ClaudeCode/managed-settings.json'
      : process.platform === 'win32'
        ? 'C:\\ProgramData\\ClaudeCode\\managed-settings.json'
        : '/etc/claude-code/managed-settings.json';
  return [
    { label: 'usuario (~/.claude/settings.json)', path: join(home, '.claude', 'settings.json') },
    { label: 'proyecto (.claude/settings.json)', path: join(root, '.claude', 'settings.json') },
    {
      label: 'local (.claude/settings.local.json)',
      path: join(root, '.claude', 'settings.local.json'),
    },
    { label: 'managed', path: managed },
  ];
}

/** Rutas que el gate protege: un `allow` que las cubra le gana a la segunda capa. */
const PROTECTED_TARGETS = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/hooks/sdlc-gate.mjs',
  '.claude/sdlc/config.json',
  '.mcp.json',
];

/**
 * Problemas que anulan o contradicen el gate. Devuelve mensajes; vacío = nada que reportar.
 * Un archivo de settings ilegible también se reporta: Claude Code lo ignoraría en silencio.
 */
export function auditSettings(sources: SettingsSource[]): string[] {
  const problems: string[] = [];
  for (const src of sources) {
    if (!existsSync(src.path)) continue;
    let s: Record<string, unknown>;
    try {
      s = JSON.parse(readFileSync(src.path, 'utf8')) as Record<string, unknown>;
    } catch {
      problems.push(`${src.label}: no es JSON válido`);
      continue;
    }
    if (s.disableAllHooks === true)
      problems.push(`${src.label}: disableAllHooks=true apaga el gate`);
    const allow = (s.permissions as { allow?: unknown } | undefined)?.allow;
    if (Array.isArray(allow)) {
      for (const rule of allow) {
        if (typeof rule === 'string' && allowsProtected(rule)) {
          problems.push(
            `${src.label}: permissions.allow "${rule}" habilita editar archivos protegidos del gate`,
          );
        }
      }
    }
  }
  return problems;
}

/** Las deny rules de `init` tienen que estar en el settings del proyecto. */
export function missingDenyRules(projectSettings: string): string[] {
  try {
    const s = JSON.parse(readFileSync(projectSettings, 'utf8')) as {
      permissions?: { deny?: unknown };
    };
    const deny = Array.isArray(s.permissions?.deny) ? (s.permissions!.deny as unknown[]) : [];
    return DENY_RULES.filter((r) => !deny.includes(r));
  } catch {
    return [...DENY_RULES];
  }
}

function allowsProtected(rule: string): boolean {
  const m = /^(Edit|Write|MultiEdit|NotebookEdit)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m) return false;
  const pattern = m[2];
  if (pattern === undefined || pattern === '' || pattern === '*' || pattern === '**') return true;
  const re = new RegExp(
    '^' +
      pattern
        .replace(/^\.\//, '')
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '.*') +
      '$',
  );
  return PROTECTED_TARGETS.some((t) => re.test(t));
}
