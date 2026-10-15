import { isPlaceholderText } from './qa-envelope.js';

/**
 * Piso mecánico de los criterios de aceptación, al crearlos.
 *
 * Sobre el alcance, porque es la parte que importa: **el server no puede decidir si
 * un criterio es verificable.** "El usuario ve un resumen de los issues que
 * necesitan atención" es un buen criterio y "funciona bien" no lo es, y ninguna
 * regla mecánica separa esos dos casos sin rechazar criterios legítimos. Eso es un
 * juicio, y los juicios viven en `skill-story-shaping`, donde alguien los aplica.
 *
 * Lo que sí es mecánico —y es el modo de falla real, no el hipotético— es el
 * criterio que nunca se escribió: `TBD`, `n/a`, `---`, el string vacío. Ese pasa hoy
 * sin que nada lo mire, y después `submit_qa_results` le exige cobertura a un
 * criterio que no dice nada. La cuenta `N/M` da bien y no significa nada.
 *
 * Devuelve el mensaje de error, o `null` si pasan.
 */
export function acceptanceCriteriaSinContenido(
  criterios: readonly string[],
  storyTitle: string,
): string | null {
  const vacios = criterios
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => isPlaceholderText(c));

  if (vacios.length === 0) return null;

  const detalle = vacios.map(({ c, i }) => `[${i}] ${JSON.stringify(c)}`).join(', ');
  return (
    `La story "${storyTitle}" tiene ${vacios.length} criterio(s) de aceptación sin contenido: ${detalle}. ` +
    'Un criterio que no dice nada igual entra en el denominador de la cobertura de QA, así que ' +
    'después el sobre da "3/3" sobre algo que nadie puede verificar. Escribí qué tiene que pasar ' +
    'para considerar la story terminada, o sacá el criterio.'
  );
}
