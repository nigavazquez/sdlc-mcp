#!/usr/bin/env node
/**
 * Sella el catálogo: escribe en `catalog.yaml` el digest del contenido actual bajo la
 * `catalog_version` que declara el archivo.
 *
 * La regla que hace enforceable al versionado vive acá: **si el contenido cambió y
 * `catalog_version` sigue siendo la que ya estaba sellada, el script se niega a sellar**.
 * El camino feliz de quien edita el catálogo pasa por este script, así que el bump deja
 * de depender de que alguien se acuerde. El test `catalog-version.test.ts` cierra el
 * círculo del otro lado: sin resellar, la suite no pasa.
 *
 * Uso: pnpm --filter @sdlc/catalog seal
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = join(root, 'dist', 'index.js');
if (!existsSync(distEntry)) {
  console.error('Falta el build de @sdlc/catalog. Corré `pnpm turbo run build` y reintentá.');
  process.exit(1);
}
const { Catalog } = await import(distEntry);

const yamlPath = join(root, 'catalog.yaml');
const catalog = await Catalog.load(root);
const digest = await catalog.contentDigest();
const version = catalog.version;
const sealed = catalog.seal;

if (sealed && sealed.digest === digest && sealed.sealed_version === version) {
  console.log(`Sin cambios: catálogo ${version} ya sellado (${digest}).`);
  process.exit(0);
}

if (sealed && sealed.digest !== digest && sealed.sealed_version === version) {
  console.error(
    `El contenido del catálogo cambió pero catalog_version sigue en ${version}.\n` +
      `  sellado:   ${sealed.digest}\n` +
      `  contenido: ${digest}\n` +
      `Bumpeá catalog_version en catalog.yaml (el cambio es de contenido: los consumidores ` +
      `tienen que poder distinguirlo) y volvé a correr este script.`,
  );
  process.exit(1);
}

const doc = parseDocument(readFileSync(yamlPath, 'utf8'));
doc.setIn(['seal', 'sealed_version'], version);
doc.setIn(['seal', 'digest'], digest);
// `flowCollectionPadding: false` conserva el estilo del archivo (`[a, b]`, no `[ a, b ]`):
// el sello no tiene por qué ensuciar el diff con reformateo.
writeFileSync(yamlPath, doc.toString({ flowCollectionPadding: false, lineWidth: 0 }));
console.log(`Sellado: catálogo ${version} → ${digest}`);
