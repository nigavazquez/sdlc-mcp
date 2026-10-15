import { REVIEW_ENVELOPE_SCHEMA, type ReviewEnvelopeInput } from '@sdlc/core';

/**
 * Envelope de review válido para los tests que no están estudiando el envelope.
 *
 * `submit_review_outcome` lo exige desde que el review pasó a medirse en dos ejes:
 * los tests que sólo quieren ejercitar el resto de la tool lo piden acá en vez de
 * repetir la forma. Los casos del envelope en sí viven en `review-envelope.test.ts`
 * y en `review-tools.test.ts`, y arman el suyo a mano.
 */
export function reviewOk(): ReviewEnvelopeInput {
  return {
    schema: REVIEW_ENVELOPE_SCHEMA,
    standards: { verdict: 'ok', findings: [] },
    spec: { verdict: 'ok', findings: [] },
  };
}

/** Con hallazgos que no bloquean: sirve para el camino de changes_requested. */
export function reviewConHallazgos(): ReviewEnvelopeInput {
  return {
    schema: REVIEW_ENVELOPE_SCHEMA,
    standards: {
      verdict: 'advisory',
      findings: [{ file: 'src/checkout/pay.ts', line: 42, why: 'Nombre poco claro para el retry.' }],
    },
    spec: { verdict: 'ok', findings: [] },
  };
}
