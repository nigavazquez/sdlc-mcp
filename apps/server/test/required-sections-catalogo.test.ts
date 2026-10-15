import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Catalog } from '@sdlc/catalog';
import type { RoleId, PhaseId } from '@sdlc/core';
import { PRD_RULES } from '../src/validation/prd.js';
import { RFC_RULES, ARCH_SUBSECTIONS, INTEGRATION_RULE } from '../src/validation/rfc.js';
import { CHANGE_NOTE_RULES } from '../src/validation/change-note.js';
import type { SectionRule } from '../src/validation/markdown-sections.js';

const CATALOG_ROOT = resolve(__dirname, '../../../packages/catalog');

/**
 * Lo que la fase declara y lo que el validador exige tienen que ser la misma lista.
 *
 * Son dos copias por buenas razones: el catálogo se edita por PR aparte del código y
 * lleva su propio semver, y las aliases y los mínimos de contenido son enforcement,
 * no contenido. Lo que no puede pasar es que se despeguen en silencio — y ya había
 * pasado: `rfc-draft` declaraba ocho secciones mientras el validador exigía once, y
 * lo único que sostenía la diferencia era que el cuerpo del prompt las nombrara.
 *
 * Un agente que lea `required_sections` para saber qué escribir tiene que poder
 * confiar en esa lista.
 */
const ids = (rules: SectionRule[]) => rules.map((r) => r.id).sort();

interface Cruce {
  role: RoleId;
  phase: PhaseId;
  /** Las que el validador exige siempre. */
  siempre: string[];
  /** Las que exige según el caso, declaradas aparte en el frontmatter. */
  condicionales?: string[];
}

const CRUCES: Cruce[] = [
  { role: 'product-manager', phase: 'prd-draft', siempre: ids(PRD_RULES) },
  {
    role: 'tech-lead',
    phase: 'rfc-draft',
    siempre: ids([...RFC_RULES, ...ARCH_SUBSECTIONS]),
    // `integration_points` es obligatoria con architecture_mode reuse/hybrid o con
    // más de un componente. Se declara aparte para que la lista de arriba siga
    // siendo "lo que siempre va".
    condicionales: ids([INTEGRATION_RULE]),
  },
  { role: 'developer', phase: 'change-note', siempre: ids(CHANGE_NOTE_RULES) },
];

describe('el catálogo declara exactamente lo que el validador exige', () => {
  for (const cruce of CRUCES) {
    it(`${cruce.role}/${cruce.phase}: required_sections coincide con las reglas`, async () => {
      const catalog = await Catalog.load(CATALOG_ROOT);
      const declaradas = await catalog.getRequiredSections(cruce.role, cruce.phase);

      expect([...declaradas.siempre].sort()).toEqual(cruce.siempre);
      expect([...declaradas.condicionales].sort()).toEqual(cruce.condicionales ?? []);
    });
  }

  it('toda fase con validador está en la tabla', () => {
    // El otro lado: agregar un validador nuevo y olvidarse de cruzarlo dejaría el
    // hueco abierto justo donde lo acabamos de cerrar.
    expect(CRUCES.map((c) => c.phase).sort()).toEqual(['change-note', 'prd-draft', 'rfc-draft']);
  });
});
