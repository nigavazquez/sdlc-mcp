import { describe, expect, it } from 'vitest';
import { acceptanceCriteriaSinContenido } from '../src/validation/acceptance-criteria.js';

describe('acceptanceCriteriaSinContenido', () => {
  it('deja pasar criterios con contenido', () => {
    expect(
      acceptanceCriteriaSinContenido(
        ['El token del refresh trae el claim workspaces', 'Hay un test que lo cubre'],
        'Propagar el claim',
      ),
    ).toBeNull();
  });

  it.each(['TBD', 'n/a', 'N/A', 'todo', '---', '???', '   ', ''])(
    'rechaza %j, que es un criterio que nunca se escribió',
    (criterio) => {
      const error = acceptanceCriteriaSinContenido(['Algo real', criterio], 'Una story');

      expect(error).toContain('sin contenido');
      // El mensaje dice por qué importa: el criterio vacío entra igual en el
      // denominador de la cobertura de QA.
      expect(error).toContain('cobertura');
    },
  );

  it('nombra el índice y el valor de cada uno', () => {
    const error = acceptanceCriteriaSinContenido(['ok', 'TBD', 'ok2', '---'], 'S');

    expect(error).toContain('[1]');
    expect(error).toContain('[3]');
    expect(error).toContain('2 criterio(s)');
  });

  it('no se mete a juzgar si un criterio es verificable', () => {
    // "funciona bien" es un mal criterio y el server no lo rechaza: separar eso de
    // uno legítimo es un juicio, y una regla mecánica que lo intentara rechazaría
    // criterios buenos. Esa regla vive en skill-story-shaping, donde alguien la
    // aplica. Este test fija la frontera para que nadie la mueva sin discutirlo.
    expect(acceptanceCriteriaSinContenido(['funciona bien'], 'S')).toBeNull();
    expect(acceptanceCriteriaSinContenido(['ac'], 'S')).toBeNull();
  });
});
