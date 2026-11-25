import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** `.claude/sdlc/config.json`: lo escribe `sdlc init`, versionado y protegido. */
export interface GateConfig {
  version: 1;
  server_url: string;
  workspace: string;
  /** En el checkout principal sobre esta branch el agente no trabaja. */
  default_branch: string;
  /** Se suma a DEFAULT_EXCLUDE. */
  exclude: string[];
}

export const CONFIG_PATH = '.claude/sdlc/config.json';

/** No requieren lease (siguen sujetas a protección). RFC § Exclusiones por defecto. */
export const DEFAULT_EXCLUDE: readonly string[] = [
  'CLAUDE.md',
  'docs/**/*.md',
  '.claude/skills/**',
  '.claude/commands/**',
  '.claude/agents/**',
];

/** Sólo los modifica `init`: el agente no, con o sin lease. */
export const PROTECTED: readonly string[] = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/hooks/sdlc-gate.mjs',
  '.claude/sdlc/**',
  '.mcp.json',
];

/** Tira si falta o está mal: un gate sin config no sabe qué proteger, y el error es deny. */
export function readConfig(projectDir: string): GateConfig {
  const raw = JSON.parse(
    readFileSync(join(projectDir, CONFIG_PATH), 'utf8'),
  ) as Partial<GateConfig>;
  if (raw.version !== 1) throw new Error(`${CONFIG_PATH}: version desconocida`);
  for (const k of ['server_url', 'workspace', 'default_branch'] as const) {
    if (typeof raw[k] !== 'string' || !raw[k]) throw new Error(`${CONFIG_PATH}: falta ${k}`);
  }
  const exclude = raw.exclude ?? [];
  if (!Array.isArray(exclude) || exclude.some((e) => typeof e !== 'string')) {
    throw new Error(`${CONFIG_PATH}: exclude tiene que ser una lista de globs`);
  }
  return { ...(raw as GateConfig), exclude };
}
