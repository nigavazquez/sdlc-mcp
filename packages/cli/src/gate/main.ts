import { readFileSync } from 'node:fs';
import { readConfig } from './config.js';
import { decidePre, type PreToolUseEvent } from './decide.js';
import { denyOutput } from './output.js';

/**
 * Punto de entrada del gate (`node sdlc-gate.mjs pre|post`).
 *
 * `pre` aplica las decisiones locales (protegidos, exclusiones, ubicación de la sesión).
 * La validación del lease contra el server llega en la historia #11: hasta entonces, lo
 * que necesita lease se deniega. Cualquier error termina en deny.
 */
function main(): string {
  const mode = process.argv[2];
  if (mode !== 'pre' && mode !== 'post') {
    throw new Error(`modo desconocido: ${String(mode)}`);
  }
  const event: unknown = JSON.parse(readFileSync(0, 'utf8'));
  if (typeof event !== 'object' || event === null) {
    throw new Error('el evento del hook no es un objeto');
  }
  if (mode === 'post') return '';

  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  if (!projectDir) throw new Error('falta CLAUDE_PROJECT_DIR');
  const decision = decidePre(event as PreToolUseEvent, projectDir, readConfig(projectDir));
  switch (decision.decision) {
    case 'allow':
      return '';
    case 'deny':
      return denyOutput(decision.reason, decision.next);
    case 'needs_lease':
      return denyOutput(
        'no hay un lease válido para esta sesión',
        'reclamá una historia con claim_story',
      );
  }
}

let out: string;
try {
  out = main();
} catch (err) {
  // Un error no pasa en silencio: deny con el motivo, y en debug también a stderr.
  if (process.env.SDLC_GATE_DEBUG === '1') process.stderr.write(`${String(err)}\n`);
  out = denyOutput('error interno del gate', 'corré `sdlc doctor`');
}
process.stdout.write(out);
