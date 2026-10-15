import { describe, expect, it } from 'vitest';
import { InitiativeType, trackForInitiative } from '@sdlc/core';

/**
 * El track no se guarda: se deriva del `initiative_type` que `start_flow` ya exige.
 * Una sola fuente de verdad, sin drift posible entre el tipo y el track — el mismo
 * estado redundante que ya nos costó caro con `tribu`/`squad`.
 */
describe('trackForInitiative', () => {
  it('fix e improvement van por el track liviano', () => {
    expect(trackForInitiative('fix')).toBe('lite');
    expect(trackForInitiative('improvement')).toBe('lite');
  });

  it('feature y refactor van por el track completo', () => {
    expect(trackForInitiative('feature')).toBe('full');
    expect(trackForInitiative('refactor')).toBe('full');
  });

  it('sin initiative_type el track es full: la ceremonia se afloja sólo si la pediste', () => {
    // Los flows anteriores a la migración 0011 pueden no tener `initiative_type`, y
    // `Flow.initiative_type` es opcional. El default tiene que ser el camino largo:
    // un flow viejo no puede quedar habilitado para saltearse el PRD por omisión.
    expect(trackForInitiative(undefined)).toBe('full');
  });

  it('la tabla cubre todo el enum', () => {
    // Si mañana se agrega un initiative_type y nadie le decide un track, este test
    // lo caza acá y no en producción con un `undefined` colándose como 'full'.
    for (const tipo of InitiativeType.options) {
      expect(['full', 'lite']).toContain(trackForInitiative(tipo));
    }
  });
});
