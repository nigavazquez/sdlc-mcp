export interface GateLease {
  lease_id: string;
  expires_at: string;
}

/**
 * Saca `data.gate_lease` del `tool_response` que Claude Code le pasa al hook
 * PostToolUse de `claim_story`.
 *
 * Para una tool MCP, `tool_response` es el array `content` del resultado y sdlc-mcp
 * serializa su respuesta en el primer bloque `text` (fixture en
 * `test/fixtures/post-tool-use-claim-story.json`). Cualquier otra forma, un
 * `ok:false` o un lease incompleto devuelven null: el gate sólo se abre con un claim
 * que el server aceptó (fallo 1 del gate de kanso).
 */
export function extractGateLease(toolResponse: unknown): GateLease | null {
  if (!Array.isArray(toolResponse)) return null;
  const block = toolResponse.find(
    (b): b is { type: 'text'; text: string } =>
      typeof b === 'object' && b !== null && b.type === 'text' && typeof b.text === 'string',
  );
  if (!block) return null;

  let body: unknown;
  try {
    body = JSON.parse(block.text);
  } catch {
    return null;
  }
  if (!isRecord(body) || body.ok !== true || !isRecord(body.data)) return null;

  const lease = body.data.gate_lease;
  if (
    !isRecord(lease) ||
    typeof lease.lease_id !== 'string' ||
    typeof lease.expires_at !== 'string'
  ) {
    return null;
  }
  return { lease_id: lease.lease_id, expires_at: lease.expires_at };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
