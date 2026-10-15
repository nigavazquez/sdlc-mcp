import { describe, expect, it } from 'vitest';
import { REVIEW_ENVELOPE_SCHEMA, type ReviewEnvelopeInput } from '@sdlc/core';
import { validateReviewEnvelope, verdictContradice } from '../src/validation/review-envelope.js';

const OK: ReviewEnvelopeInput = {
  schema: REVIEW_ENVELOPE_SCHEMA,
  standards: { verdict: 'ok', findings: [] },
  spec: { verdict: 'ok', findings: [] },
};

const HALLAZGO = { file: 'src/checkout/pay.ts', line: 42, why: 'El RFC pide 3 reintentos; hace 1.' };

const con = (patch: Partial<ReviewEnvelopeInput>): ReviewEnvelopeInput => ({ ...OK, ...patch });

describe('validateReviewEnvelope — forma', () => {
  it('los dos ejes en ok y sin hallazgos es válido', () => {
    expect(validateReviewEnvelope(OK).ok).toBe(true);
  });

  it('exige el schema correcto', () => {
    const res = validateReviewEnvelope({ ...OK, schema: 'sdlc.review/v0' });
    expect(res.ok).toBe(false);
  });

  it.each(['standards', 'spec'] as const)('exige el eje %s', (eje) => {
    const sinEje = { ...OK };
    delete (sinEje as Record<string, unknown>)[eje];

    const res = validateReviewEnvelope(sinEje as ReviewEnvelopeInput);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    // El mensaje dice qué mide el eje que falta: sin eso, "falta spec" no le
    // explica a nadie por qué no alcanza con haber mirado el otro.
    expect(res.issues.some((i) => i.message.includes(eje))).toBe(true);
  });

  it('un "ok" con hallazgos se contradice solo', () => {
    const res = validateReviewEnvelope(con({ spec: { verdict: 'ok', findings: [HALLAZGO] } }));
    expect(res.ok).toBe(false);
  });

  it('un "blocking" sin hallazgos no dice qué arreglar', () => {
    const res = validateReviewEnvelope(con({ spec: { verdict: 'blocking', findings: [] } }));

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issues.some((i) => i.message.includes('qué arreglar'))).toBe(true);
  });

  it('un "advisory" sí puede traer hallazgos y no bloquea', () => {
    const res = validateReviewEnvelope(
      con({ standards: { verdict: 'advisory', findings: [HALLAZGO] } }),
    );
    expect(res.ok).toBe(true);
  });

  it('rechaza placeholders en los hallazgos', () => {
    const res = validateReviewEnvelope(
      con({ spec: { verdict: 'blocking', findings: [{ file: 'TODO', why: 'n/a' }] } }),
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    // Los dos problemas juntos, no de a uno: el agente corrige una vez.
    expect(res.issues.length).toBeGreaterThanOrEqual(2);
  });

  it('junta todos los problemas en una sola respuesta', () => {
    const res = validateReviewEnvelope({
      schema: 'otro',
      standards: { verdict: 'ok', findings: [HALLAZGO] },
      spec: { verdict: 'blocking', findings: [] },
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issues.length).toBe(3);
  });
});

describe('verdictContradice — la firma contra la evidencia', () => {
  it('approved con un eje en blocking se rechaza', () => {
    const envelope = con({ spec: { verdict: 'blocking', findings: [HALLAZGO] } });

    const error = verdictContradice('approved', envelope);

    expect(error).toContain('No se puede aprobar');
    // Nombra el eje y ofrece las dos salidas reales.
    expect(error).toContain('spec');
    expect(error).toContain('changes_requested');
  });

  it('approved con advisory pasa: un juicio no bloquea', () => {
    const envelope = con({ standards: { verdict: 'advisory', findings: [HALLAZGO] } });
    expect(verdictContradice('approved', envelope)).toBeNull();
  });

  it('approved con los dos en ok pasa', () => {
    expect(verdictContradice('approved', OK)).toBeNull();
  });

  it('changes_requested sin ningún hallazgo se rechaza', () => {
    const error = verdictContradice('changes_requested', OK);

    expect(error).toContain('sin hallazgos');
  });

  it('changes_requested con hallazgos advisory pasa', () => {
    // Pedir cambios por algo que no bloquea es legítimo: el reviewer puede querer
    // que se arregle igual. Lo que no puede es pedir cambios sin decir cuáles.
    const envelope = con({ standards: { verdict: 'advisory', findings: [HALLAZGO] } });
    expect(verdictContradice('changes_requested', envelope)).toBeNull();
  });
});
