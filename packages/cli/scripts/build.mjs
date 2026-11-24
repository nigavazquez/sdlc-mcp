// Compila el gate a un único `.mjs` sin dependencias. `init` lo copia al repo destino
// como `.claude/hooks/sdlc-gate.mjs`: el hook corre en cada edición, así que no puede
// depender de `npx`, de la red ni de un `node_modules` (RFC sdlc-repo-onboarding).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export async function buildGate(outfile) {
  await build({
    entryPoints: [`${root}src/gate/main.ts`],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    legalComments: 'none',
    logLevel: 'warning',
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildGate(`${root}dist/gate.mjs`);
}
