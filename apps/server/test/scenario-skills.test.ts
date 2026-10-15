import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Catalog } from '@sdlc/catalog';

const CATALOG_ROOT = resolve(__dirname, '../../../packages/catalog');

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Catálogo mínimo con una skill atada al eje initiative_type de developer.implement. */
function catalogoConEje(): string {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-catalog-eje-'));
  temps.push(root);
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content, 'utf8');
  };
  write(
    'catalog.yaml',
    [
      'schema: 1',
      'catalog_version: 1.0.0',
      'roles:',
      '  developer:',
      '    role_prompt: roles/dev/role.md',
      '    version: 1.0.0',
      '    phases:',
      '      implement:',
      '        path: roles/dev/implement.md',
      '        version: 1.0.0',
      '        skills: [skill-base]',
      '        templates: []',
      'skills:',
      '  skill-base:',
      '    path: skills/base.md',
      '    version: 1.0.0',
      '  skill-del-fix:',
      '    path: skills/fix.md',
      '    version: 1.0.0',
      'templates: {}',
      'scenario_skills:',
      '  developer.implement:',
      '    initiative_type:',
      '      fix: [skill-del-fix]',
      '      improvement: [skill-del-fix]',
      '',
    ].join('\n'),
  );
  write('roles/dev/role.md', '---\nid: roles.developer\nversion: 1.0.0\n---\nRol.\n');
  write('roles/dev/implement.md', '---\nid: roles.developer.phases.implement\nversion: 1.0.0\n---\nFase.\n');
  write('skills/base.md', '---\nid: skill-base\nversion: 1.0.0\ndescription: Base.\n---\nBase.\n');
  write('skills/fix.md', '---\nid: skill-del-fix\nversion: 1.0.0\ndescription: Del fix.\n---\nFix.\n');
  return root;
}

describe('catalog — scenario_skills', () => {
  it('developer.implement with architecture_mode=reuse adds skill-reuse-implementation', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const bundle = await catalog.getRolePrompt('developer', 'implement', {
      architecture_mode: 'reuse',
    });
    const ids = bundle.skills.map((s) => s.id);
    expect(ids).toContain('skill-implementation-checklist');
    expect(ids).toContain('skill-reuse-implementation');
    expect(ids).not.toContain('skill-greenfield-implementation');
  });

  it('developer.implement with architecture_mode=hybrid + codebase_status=existing adds three extras', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const bundle = await catalog.getRolePrompt('developer', 'implement', {
      architecture_mode: 'hybrid',
      codebase_status: 'existing',
    });
    const ids = bundle.skills.map((s) => s.id);
    expect(ids).toContain('skill-greenfield-implementation');
    expect(ids).toContain('skill-reuse-implementation');
    expect(ids).toContain('skill-existing-codebase-conventions');
  });

  it('developer.implement without scenario returns only base skills', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const bundle = await catalog.getRolePrompt('developer', 'implement');
    const ids = bundle.skills.map((s) => s.id);
    expect(ids).toEqual(['skill-implementation-checklist']);
  });

  it('developer.implement with component_kind=infra adds skill-terraform-implementation', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const bundle = await catalog.getRolePrompt('developer', 'implement', {
      component_kind: 'infra',
    });
    const ids = bundle.skills.map((s) => s.id);
    expect(ids).toContain('skill-implementation-checklist');
    expect(ids).toContain('skill-terraform-implementation');
  });

  it('developer.implement with component_kind=app does NOT add the terraform skill', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const bundle = await catalog.getRolePrompt('developer', 'implement', {
      component_kind: 'app',
    });
    const ids = bundle.skills.map((s) => s.id);
    expect(ids).not.toContain('skill-terraform-implementation');
  });

  it('qa.qa with architecture_mode=new returns only base skill', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const bundle = await catalog.getRolePrompt('qa', 'qa', { architecture_mode: 'new' });
    const ids = bundle.skills.map((s) => s.id);
    expect(ids).toEqual(['skill-qa-plan']);
  });

  it('qa.qa with component_kind=infra adds skill-terraform-implementation', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const bundle = await catalog.getRolePrompt('qa', 'qa', { component_kind: 'infra' });
    const ids = bundle.skills.map((s) => s.id);
    expect(ids).toContain('skill-qa-plan');
    expect(ids).toContain('skill-terraform-implementation');
  });

  it('qa.qa with component_kind=app does NOT add the terraform skill', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const bundle = await catalog.getRolePrompt('qa', 'qa', { component_kind: 'app' });
    expect(bundle.skills.map((s) => s.id)).not.toContain('skill-terraform-implementation');
  });

  it('reviewer.review with architecture_mode=reuse + codebase_status=existing adds both extras', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const bundle = await catalog.getRolePrompt('reviewer', 'review', {
      architecture_mode: 'reuse',
      codebase_status: 'existing',
    });
    const ids = bundle.skills.map((s) => s.id);
    expect(ids).toContain('skill-code-review-checklist');
    expect(ids).toContain('skill-reuse-review-checklist');
    expect(ids).toContain('skill-codebase-consistency-review');
  });

  it('skills are merged without duplicates', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const bundle = await catalog.getRolePrompt('developer', 'implement', {
      architecture_mode: 'hybrid',
      codebase_status: 'existing',
    });
    const ids = bundle.skills.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('catalog — scenario_skills por initiative_type', () => {
  it.each(['fix', 'improvement'] as const)('%s suma la skill del eje', async (initiative_type) => {
    const catalog = await Catalog.load(catalogoConEje());
    const bundle = await catalog.getRolePrompt('developer', 'implement', { initiative_type });
    expect(bundle.skills.map((s) => s.id)).toEqual(['skill-base', 'skill-del-fix']);
  });

  it.each(['feature', 'refactor'] as const)('%s no la suma', async (initiative_type) => {
    const catalog = await Catalog.load(catalogoConEje());
    const bundle = await catalog.getRolePrompt('developer', 'implement', { initiative_type });
    expect(bundle.skills.map((s) => s.id)).toEqual(['skill-base']);
  });

  it('sin initiative_type (un flow viejo) no la suma y no rompe', async () => {
    const catalog = await Catalog.load(catalogoConEje());
    const bundle = await catalog.getRolePrompt('developer', 'implement', {});
    expect(bundle.skills.map((s) => s.id)).toEqual(['skill-base']);
  });

  it('scenarioForStory toma el initiative_type del flow', async () => {
    const { scenarioForStory } = await import('../src/mcp/tools/story-component.js');
    const flow = { initiative_type: 'fix' } as never;
    const story = {} as never;
    expect(scenarioForStory(flow, story)).toEqual({ initiative_type: 'fix' });
    expect(scenarioForStory({} as never, story)).toEqual({});
  });

  it('el catálogo real: implement de un fix trae skill-repro-antes-del-fix, el de una feature no', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const ids = async (initiative_type: 'fix' | 'feature') =>
      (await catalog.getRolePrompt('developer', 'implement', { initiative_type })).skills.map((s) => s.id);
    expect(await ids('fix')).toContain('skill-repro-antes-del-fix');
    expect(await ids('feature')).not.toContain('skill-repro-antes-del-fix');
  });

  it('el catálogo real: change-note trae la skill siempre', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const bundle = await catalog.getRolePrompt('developer', 'change-note');
    expect(bundle.skills.map((s) => s.id)).toContain('skill-repro-antes-del-fix');
  });
});
