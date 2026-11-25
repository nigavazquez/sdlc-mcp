import { extractGateLease } from './claim-response.js';
import { gitTree, nearestExistingDir } from './git.js';
import { clearSession, writeLease } from './session-files.js';

export interface PostToolUseEvent {
  tool_name?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
  cwd?: unknown;
}

/**
 * PostToolUse de `claim_story` (historia #11): si el server aceptó el claim y devolvió
 * un `gate_lease`, se guarda en la raíz de la sesión. Un `ok:false` o una respuesta sin
 * lease no escriben nada. Devuelve dónde quedó, o `undefined`.
 */
export function handlePost(event: PostToolUseEvent, projectDir: string): string | undefined {
  if (typeof event.tool_name !== 'string' || !/(?:^|__)claim_story$/.test(event.tool_name))
    return undefined;
  const lease = extractGateLease(event.tool_response);
  if (!lease) return undefined;

  const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : projectDir;
  const tree = gitTree(nearestExistingDir(cwd));
  const project = gitTree(projectDir);
  if (!tree || !project || tree.commonDir !== project.commonDir) {
    throw new Error(
      'claim_story corrió fuera del repo del proyecto: no hay dónde guardar el lease',
    );
  }
  const input = (event.tool_input ?? {}) as Record<string, unknown>;
  clearSession(tree.top);
  writeLease(tree.top, {
    lease_id: lease.lease_id,
    kind: 'story',
    ...(typeof input.story_id === 'string' ? { story_id: input.story_id } : {}),
    expires_at: lease.expires_at,
  });
  return tree.top;
}
