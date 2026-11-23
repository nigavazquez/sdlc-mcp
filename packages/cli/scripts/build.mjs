// Compila el gate y el CLI a un `.mjs` cada uno, sin dependencias. `init` copia el gate
// al repo destino como `.claude/hooks/sdlc-gate.mjs`: el hook corre en cada edición, así
// que no puede depender de `npx`, de la red ni de un `node_modules` (RFC sdlc-repo-onboarding).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  legalComments: 'none',
  logLevel: 'warning',
};

export async function buildGate(outfile) {
  await build({ ...common, entryPoints: [`${root}src/gate/main.ts`], outfile });
}

export async function buildCli(outfile) {
  await build({
    ...common,
    entryPoints: [`${root}src/cli.ts`],
    outfile,
    banner: { js: '#!/usr/bin/env node' },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildGate(`${root}dist/gate.mjs`);
  await buildCli(`${root}dist/cli.mjs`);
}
