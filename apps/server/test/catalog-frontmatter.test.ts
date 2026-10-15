import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Catalog } from '@sdlc/catalog';

/**
 * El frontmatter de los documentos del catálogo, validado al cargar.
 *
 * `catalog.yaml` se validaba con zod y el frontmatter de los markdown no lo miraba nadie:
 * convivían dos convenciones de `id`, la `version` estaba en dos lugares sin nada que las
 * cruzara, y 9 de 15 skills no tenían `description`. Son cuatro comparaciones de strings,
 * sin heurística sobre prosa, así que van en el loader y un catálogo inconsistente no
 * carga. Qué dice una descripción es juicio y va en docs/PROMPT_AUTHORING.md.
 *
 * Seam: `Catalog.load`. El catálogo bundleado lo cubre cualquier test que lo cargue.
 */

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

interface Docs {
  role?: string;
  phase?: string;
  skill?: string;
  template?: string;
}

const VALID: Required<Docs> = {
  role: '---\nid: roles.product-manager\nversion: 1.0.0\n---\n\nRol.\n',
  phase: '---\nid: roles.product-manager.phases.prd-draft\nversion: 1.0.0\n---\n\nFase.\n',
  skill: '---\nid: skill-x\nversion: 1.0.0\ndescription: Cuándo aplica y qué cambia.\n---\n\nSkill.\n',
  template: '# Template\n\n<placeholder>\n',
};

function makeFixture(docs: Docs = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-catalog-fm-'));
  temps.push(root);
  write(
    root,
    'catalog.yaml',
    [
      'schema: 1',
      'catalog_version: 1.0.0',
      'roles:',
      '  product-manager:',
      '    role_prompt: roles/pm/role.md',
      '    version: 1.0.0',
      '    phases:',
      '      prd-draft:',
      '        path: roles/pm/phases/prd-draft.md',
      '        version: 1.0.0',
      '        skills: [skill-x]',
      '        templates: [tpl-x]',
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
  const all = { ...VALID, ...docs };
  write(root, 'roles/pm/role.md', all.role);
  write(root, 'roles/pm/phases/prd-draft.md', all.phase);
  write(root, 'skills/x.md', all.skill);
  write(root, 'templates/x.md', all.template);
  return root;
}

describe('el frontmatter del catálogo se valida al cargar', () => {
  it('un catálogo consistente carga', async () => {
    await expect(Catalog.load(makeFixture())).resolves.toBeInstanceOf(Catalog);
  });

  it('una skill sin description no carga', async () => {
    const root = makeFixture({ skill: '---\nid: skill-x\nversion: 1.0.0\n---\n\nSkill.\n' });
    await expect(Catalog.load(root)).rejects.toThrow(/skills\/x\.md.*description/);
  });

  it('una description vacía cuenta como ausente', async () => {
    const root = makeFixture({ skill: '---\nid: skill-x\nversion: 1.0.0\ndescription: "  "\n---\n' });
    await expect(Catalog.load(root)).rejects.toThrow(/description/);
  });

  it('un id que no es la clave que indexa el documento no carga', async () => {
    const root = makeFixture({
      skill: '---\nid: skills.x\nversion: 1.0.0\ndescription: Algo útil.\n---\n',
    });
    await expect(Catalog.load(root)).rejects.toThrow(/skills\/x\.md.*"skills\.x".*"skill-x"/);
  });

  it('el id de una fase es roles.<rol>.phases.<fase>', async () => {
    const root = makeFixture({ phase: '---\nid: prd-draft\nversion: 1.0.0\n---\n' });
    await expect(Catalog.load(root)).rejects.toThrow(/roles\.product-manager\.phases\.prd-draft/);
  });

  it('una version distinta de la de catalog.yaml no carga', async () => {
    const root = makeFixture({ role: '---\nid: roles.product-manager\nversion: 0.9.0\n---\n' });
    await expect(Catalog.load(root)).rejects.toThrow(/roles\/pm\/role\.md.*0\.9\.0.*1\.0\.0/);
  });

  it('un documento sin frontmatter no carga', async () => {
    const root = makeFixture({ phase: '# Fase sin frontmatter\n' });
    await expect(Catalog.load(root)).rejects.toThrow(/prd-draft\.md.*frontmatter/);
  });

  it('enumera todos los problemas de una vez, no el primero', async () => {
    const root = makeFixture({
      role: '---\nid: pm\nversion: 1.0.0\n---\n',
      skill: '---\nid: skill-x\nversion: 1.0.0\n---\n',
    });
    const err = await Catalog.load(root).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/role\.md/);
    expect((err as Error).message).toMatch(/skills\/x\.md/);
  });

  // `getTemplate` devuelve el archivo crudo: un frontmatter ahí se filtraría al artefacto.
  it('los templates no llevan frontmatter y no se les exige', async () => {
    await expect(Catalog.load(makeFixture({ template: '# Solo el formato\n' }))).resolves.toBeInstanceOf(
      Catalog,
    );
  });
});
