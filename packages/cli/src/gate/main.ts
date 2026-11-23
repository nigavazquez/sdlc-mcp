import { readFileSync } from 'node:fs';
import { denyOutput } from './output.js';

/**
 * Punto de entrada del gate (`node sdlc-gate.mjs pre|post`).
 *
 * Esqueleto: valida el evento y deja pasar. Las decisiones (protegidos, exclusiones,
 * ubicación de la sesión, lease) llegan en las historias siguientes. Lo que sí queda
 * fijo desde ahora es que cualquier error termina en deny.
 */
function main(): void {
  const mode = process.argv[2];
  if (mode !== 'pre' && mode !== 'post') {
    throw new Error(`modo desconocido: ${String(mode)}`);
  }
  const event: unknown = JSON.parse(readFileSync(0, 'utf8'));
  if (typeof event !== 'object' || event === null) {
    throw new Error('el evento del hook no es un objeto');
  }
}

try {
  main();
} catch (err) {
  // Un error no pasa en silencio: deny con el motivo, y en debug también a stderr.
  if (process.env.SDLC_GATE_DEBUG === '1') process.stderr.write(`${String(err)}\n`);
  process.stdout.write(denyOutput('error interno del gate', 'corré `sdlc doctor`'));
}
