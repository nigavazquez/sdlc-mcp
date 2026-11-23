/**
 * Salida de deny según el contrato de hooks de Claude Code: JSON por stdout y exit 0.
 * El motivo siempre dice el próximo paso, porque es lo único que el agente lee.
 */
export function denyOutput(reason: string, nextStep: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Gate SDLC: ${reason}. Próximo paso: ${nextStep}. Ver 'Flujo SDLC' en CLAUDE.md.`,
    },
  });
}
