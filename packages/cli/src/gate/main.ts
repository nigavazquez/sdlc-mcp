import { readFileSync } from 'node:fs';
import { readConfig } from './config.js';
import { decidePre, type PreToolUseEvent } from './decide.js';
import { gitTree } from './git.js';
import { resolveLease } from './lease.js';
import { denyOutput } from './output.js';
import { handlePost, type PostToolUseEvent } from './post.js';
import { repoId } from './remote.js';
import { httpGateServer } from './server.js';

/**
 * Punto de entrada del gate (`node sdlc-gate.mjs pre|post`).
 *
 * - `pre`: decisiones locales (protegidos, exclusiones, ubicación) y, si hace falta,
 *   el lease validado contra el server.
 * - `post`: guarda el lease que devolvió `claim_story`.
 *
 * Cualquier error termina en deny.
 */
async function main(): Promise<string> {
  const mode = process.argv[2];
  if (mode !== 'pre' && mode !== 'post') {
    throw new Error(`modo desconocido: ${String(mode)}`);
  }
  const event: unknown = JSON.parse(readFileSync(0, 'utf8'));
  if (typeof event !== 'object' || event === null) {
    throw new Error('el evento del hook no es un objeto');
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (!projectDir) throw new Error('falta CLAUDE_PROJECT_DIR');

  if (mode === 'post') {
    handlePost(event as PostToolUseEvent, projectDir);
    return '';
  }

  const config = readConfig(projectDir);
  const decision = decidePre(event as PreToolUseEvent, projectDir, config);
  if (decision.decision === 'allow') return '';
  if (decision.decision === 'deny') return denyOutput(decision.reason, decision.next);

  const project = gitTree(projectDir);
  if (!project) throw new Error('el proyecto no es un repo git');
  const outcome = await resolveLease(decision, {
    server: httpGateServer(config.server_url),
    config,
    repo: repoId(project.mainRoot),
  });
  return outcome.allow ? '' : denyOutput(outcome.reason, outcome.next);
}

main()
  .catch((err: unknown) => {
    // Un error no pasa en silencio: deny con el motivo, y en debug también a stderr.
    if (process.env.SDLC_GATE_DEBUG === '1') process.stderr.write(`${String(err)}\n`);
    return denyOutput('error interno del gate', 'corré `sdlc doctor`');
  })
  .then((out) => process.stdout.write(out));
