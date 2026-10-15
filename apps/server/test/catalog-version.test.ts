import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Catalog } from '@sdlc/catalog';
import { makeWhoamiTool } from '../src/mcp/tools/whoami.js';
import { testCtx } from './helpers/tenant-ctx.js';

/**
 * Seam: la API pública de `@sdlc/catalog` (`version`, `contentDigest`, `verifySeal`).
 * Los tests no miran cómo se calcula el digest ni cómo se serializa el sello —eso es
 * implementación—, sino el contrato: qué versión corre, y si el contenido que hay en
 * disco es el que esa versión declara.
 */

const CATALOG_ROOT = resolve(__dirname, '../../../packages/catalog');

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

/** Catálogo mínimo y válido, sin sello. Devuelve el directorio raíz. */
function makeFixture(opts: { version?: string; skill?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-catalog-'));
  temps.push(root);
  write(
    root,
    'catalog.yaml',
    [
      'schema: 1',
      `catalog_version: ${opts.version ?? '1.0.0'}`,
      'roles:',
      '  product-manager:',
      '    role_prompt: roles/pm/role.md',
      '    version: 1.0.0',
      '    phases:',
      '      prd-draft:',
      '        path: roles/pm/phases/prd-draft.md',
      '        version: 1.0.0',
      '        skills:',
      '          - skill-x',
      '        templates:',
      '          - tpl-x',
      'skills:',
      '  skill-x:',
      '    path: skills/x.md',
      '    version: 1.0.0',
      'templates:',
      '  tpl-x:',
      '    path: templates/x.md',
      '    version: 1.0.0',
      '',
    ].join('\n'),
  );
  // El frontmatter tiene que coincidir con el índice o el catálogo no carga
  // (ver catalog-frontmatter.test.ts).
  write(root, 'roles/pm/role.md', '---\nid: roles.product-manager\nversion: 1.0.0\n---\n\nRol.\n');
  write(
    root,
    'roles/pm/phases/prd-draft.md',
    '---\nid: roles.product-manager.phases.prd-draft\nversion: 1.0.0\n---\n\nFase.\n',
  );
  write(
    root,
    'skills/x.md',
    `---\nid: skill-x\nversion: 1.0.0\ndescription: Una skill de prueba.\n---\n\n${opts.skill ?? 'Skill original.'}\n`,
  );
  write(root, 'templates/x.md', '# Template\n');
  return root;
}

/** Escribe el sello en el catalog.yaml del fixture. */
function seal(root: string, sealedVersion: string, digest: string) {
  const path = join(root, 'catalog.yaml');
  const raw = readFileSync(path, 'utf8');
  writeFileSync(path, `${raw}\nseal:\n  sealed_version: ${sealedVersion}\n  digest: ${digest}\n`);
}

describe('sello del catálogo (contenido ↔ versión)', () => {
  it('el catálogo bundleado está sellado y el sello corresponde al contenido en disco', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const check = await catalog.verifySeal();
    expect(check.status, check.message).toBe('ok');
    expect(check.version).toBe(catalog.version);
    expect(check.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('detecta contenido cambiado sin bump: status drift y un mensaje accionable', async () => {
    const root = makeFixture();
    const antes = await Catalog.load(root);
    seal(root, '1.0.0', await antes.contentDigest());

    // Alguien edita una skill y se olvida de mover catalog_version.
    write(
      root,
      'skills/x.md',
      '---\nid: skill-x\nversion: 1.0.0\ndescription: Una skill de prueba.\n---\n\nSkill editada.\n',
    );

    const check = await (await Catalog.load(root)).verifySeal();
    expect(check.status).toBe('drift');
    expect(check.message).toMatch(/catalog_version/);
    expect(check.message).toMatch(/seal/);
  });

  it('con el bump hecho pero sin resellar, avisa que el sello quedó viejo', async () => {
    const root = makeFixture();
    const antes = await Catalog.load(root);
    const digest = await antes.contentDigest();
    seal(root, '1.0.0', digest);

    // Se bumpea la versión sin correr el script de sellado.
    const path = join(root, 'catalog.yaml');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace('catalog_version: 1.0.0', 'catalog_version: 1.1.0'),
    );

    const recargado = await Catalog.load(root);
    // El digest es del contenido: mover la versión no lo cambia.
    expect(await recargado.contentDigest()).toBe(digest);
    const check = await recargado.verifySeal();
    expect(check.status).toBe('stale-version');
    expect(check.version).toBe('1.1.0');
  });

  it('un catálogo propio sin sello carga igual y se reporta como unsealed', async () => {
    const root = makeFixture();
    const catalog = await Catalog.load(root);
    const check = await catalog.verifySeal();
    expect(check.status).toBe('unsealed');
    // Y sigue sirviendo prompts: CATALOG_ROOT apuntando afuera no exige sellar.
    const bundle = await catalog.getRolePrompt('product-manager' as never, 'prd-draft' as never);
    expect(bundle.system_prompt).toContain('Fase.');
  });

  it('el digest cubre el contenido de los archivos referenciados, no sólo el índice', async () => {
    const a = await (await Catalog.load(makeFixture({ skill: 'Una cosa.' }))).contentDigest();
    const b = await (await Catalog.load(makeFixture({ skill: 'Otra cosa.' }))).contentDigest();
    expect(a).not.toBe(b);
  });

  it('el digest cubre también el índice: cambiar la versión de una entrada lo mueve', async () => {
    const root = makeFixture();
    const antes = await (await Catalog.load(root)).contentDigest();
    const path = join(root, 'catalog.yaml');
    // El template, porque es la única entrada sin frontmatter: mover la versión de una
    // skill sólo en el índice ya no carga (catalog-frontmatter.test.ts).
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(
        '    path: templates/x.md\n    version: 1.0.0',
        '    path: templates/x.md\n    version: 1.1.0',
      ),
    );
    expect(await (await Catalog.load(root)).contentDigest()).not.toBe(antes);
  });

  it('el digest es estable entre cargas del mismo contenido', async () => {
    const root = makeFixture();
    expect(await (await Catalog.load(root)).contentDigest()).toBe(
      await (await Catalog.load(root)).contentDigest(),
    );
  });
});

describe('whoami expone contra qué catálogo corre el server', () => {
  it('devuelve la versión y el digest sellado junto con la identidad', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const tool = makeWhoamiTool(catalog);
    const res = (await tool.handler({}, testCtx())) as {
      ok: boolean;
      data: { catalog_version: string; catalog_digest: string | null; tenant_id: string };
    };

    expect(res.ok).toBe(true);
    expect(res.data.tenant_id).toBe('default');
    expect(res.data.catalog_version).toBe(catalog.version);
    expect(res.data.catalog_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('un catálogo sin sello reporta digest null en vez de mentir', async () => {
    const catalog = await Catalog.load(makeFixture({ version: '2.3.4' }));
    const res = (await makeWhoamiTool(catalog).handler({}, testCtx())) as {
      data: { catalog_version: string; catalog_digest: string | null };
    };
    expect(res.data.catalog_version).toBe('2.3.4');
    expect(res.data.catalog_digest).toBeNull();
  });
});
