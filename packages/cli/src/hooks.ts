export type GateMode = 'pre' | 'post';

/**
 * Comando que `init` registra en `.claude/settings.json` para cada hook.
 *
 * El deny normal sale por stdout (`permissionDecision: "deny"`) con exit 0. El
 * `|| exit 2` cubre lo que el gate no puede reportar: que falte `node` o que el script
 * no llegue a cargarse. En PreToolUse, Claude Code sólo bloquea con exit 2; cualquier
 * otro código distinto de cero deja pasar la acción.
 */
export function hookCommand(mode: GateMode): string {
  return `node "$CLAUDE_PROJECT_DIR/.claude/hooks/sdlc-gate.mjs" ${mode} || exit 2`;
}
