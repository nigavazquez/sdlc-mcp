import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { Catalog } from '@sdlc/catalog';

const CATALOG_ROOT = resolve(__dirname, '../../../packages/catalog');

describe('catalog bootstrap', () => {
  it('catalog content contains no org-specific proper nouns (revenue-growth, finance-erp)', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const roles = catalog.listRoles();
    const chunks: string[] = [];

    for (const { role, phases } of roles) {
      for (const phase of phases) {
        const bundle = await catalog.getRolePrompt(role, phase);
        chunks.push(bundle.system_prompt);
        for (const skill of bundle.skills) chunks.push(skill.markdown);
        for (const tpl of bundle.templates) chunks.push(tpl.content);
      }
    }

    const dump = chunks.join('\n').toLowerCase();
    expect(dump).not.toMatch(/revenue-growth|finance-erp/);
  });

  it('loads the bundled catalog and lists all 6 SDLC roles', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const ids = catalog.listRoles().map((r) => r.role).sort();
    expect(ids).toEqual(['developer', 'pmo', 'product-manager', 'qa', 'reviewer', 'tech-lead']);
  });

  it('declara una catalog_version', async () => {
    // El pin al string exacto se fue: lo reemplazó el sello (`catalog-version.test.ts`),
    // que falla cuando el **contenido** cambia sin bump en vez de fallar en cada bump.
    // Acá queda sólo que la versión existe y tiene forma de semver.
    const catalog = await Catalog.load(CATALOG_ROOT);
    expect(catalog.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('entrega el bundle de la nota de cambio con su template', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const bundle = await catalog.getRolePrompt('developer', 'change-note');

    expect(bundle.system_prompt).toContain('nota de cambio');
    // Sin el template la fase no sirve: es lo que define las cuatro secciones que el
    // validador va a exigir, y el agente no las puede adivinar.
    expect(bundle.templates.map((t) => t.id)).toContain('change-note-template');
  });

  it('returns the PM prompt bundle for prd-draft with the required template attached', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const bundle = await catalog.getRolePrompt('product-manager', 'prd-draft');
    expect(bundle.system_prompt).toContain('Product Manager');
    expect(bundle.system_prompt).toContain('Redacción del PRD');
    expect(bundle.skills.map((s) => s.id)).toContain('skill-prd-template');
    expect(bundle.templates.map((t) => t.id)).toContain('prd-template');
  });

  it.each([
    ['pmo', 'shaping', 'breakdown-template', 'skill-story-shaping'],
    ['developer', 'implement', undefined, 'skill-implementation-checklist'],
    ['qa', 'qa', 'qa-plan-template', 'skill-qa-plan'],
    ['reviewer', 'review', undefined, 'skill-code-review-checklist'],
  ])('role %s phase %s loads with expected skill/template', async (role, phase, template, skill) => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const bundle = await catalog.getRolePrompt(role as never, phase as never);
    expect(bundle.role).toBe(role);
    expect(bundle.phase).toBe(phase);
    expect(bundle.skills.map((s) => s.id)).toContain(skill);
    if (template) {
      expect(bundle.templates.map((t) => t.id)).toContain(template);
    } else {
      expect(bundle.templates).toEqual([]);
    }
  });
});
