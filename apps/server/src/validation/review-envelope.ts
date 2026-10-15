import type { ReviewAxisReport, ReviewEnvelopeInput, ValidationIssue } from '@sdlc/core';
import { REVIEW_ENVELOPE_SCHEMA } from '@sdlc/core';
import { isPlaceholderText } from './qa-envelope.js';

/**
 * Validador del envelope de review (`sdlc.review/v1`).
 *
 * Mismo contrato que el de QA y por las mismas razones: junta **todos** los
 * problemas y los devuelve juntos, y vive fuera del schema zod de la tool porque
 * `inputSchema.parse()` corre en el borde MCP y tira, así que no puede enumerar N
 * problemas ni nombrar la salida ejecutable.
 *
 * Lo que este validador chequea es **coherencia interna**, no calidad del review:
 * el server no leyó el diff y no tiene forma de saber si el hallazgo es cierto. Lo
 * que sí puede exigir es que un veredicto que bloquea diga qué arreglar, y que un
 * hallazgo se pueda ubicar en un archivo. Es la misma frontera que el envelope de
 * QA: `test_command` es trazabilidad, no prueba de que los tests corrieron.
 */

export type ReviewEnvelopeValidation =
  | { ok: true; envelope: ReviewEnvelopeInput }
  | { ok: false; issues: ValidationIssue[] };

export const REVIEW_ENVELOPE_TEMPLATE = `{
  "schema": "${REVIEW_ENVELOPE_SCHEMA}",
  "standards": { "verdict": "ok", "findings": [] },
  "spec": { "verdict": "blocking", "findings": [
    { "file": "src/checkout/pay.ts", "line": 42, "why": "El RFC pide reintentar 3 veces; acá reintenta una." }
  ]}
}`;

const EJES = ['standards', 'spec'] as const;
type Eje = (typeof EJES)[number];

/** Qué mide cada eje, para que los mensajes de error lo puedan decir. */
const QUE_MIDE: Record<Eje, string> = {
  standards: 'las convenciones del repo y el piso de smells',
  spec: 'que el código haga lo que el RFC o la nota de cambio dijeron',
};

export function validateReviewEnvelope(raw: ReviewEnvelopeInput): ReviewEnvelopeValidation {
  const issues: ValidationIssue[] = [];
  const problema = (message: string, section = 'review_envelope') =>
    issues.push({ severity: 'error', section, message });

  if (raw.schema !== REVIEW_ENVELOPE_SCHEMA) {
    problema(
      `"schema" tiene que ser "${REVIEW_ENVELOPE_SCHEMA}" (llegó ${JSON.stringify(raw.schema)}).`,
    );
  }

  for (const eje of EJES) {
    const reporte: ReviewAxisReport | undefined = raw[eje];
    if (!reporte) {
      problema(
        `Falta el eje "${eje}", que mide ${QUE_MIDE[eje]}. Los dos ejes son obligatorios: ` +
          'un review que sólo mira uno de los dos deja pasar exactamente el problema que el otro busca.',
        eje,
      );
      continue;
    }

    const { verdict, findings } = reporte;

    if (verdict === 'ok' && findings.length > 0) {
      problema(
        `El eje "${eje}" dice "ok" y trae ${findings.length} hallazgo(s). Si los hallazgos son ` +
          'reales el veredicto es "advisory" o "blocking"; si no lo son, sacalos.',
        eje,
      );
    }

    if (verdict !== 'ok' && findings.length === 0) {
      problema(
        `El eje "${eje}" dice "${verdict}" y no trae ningún hallazgo. Un veredicto que no dice ` +
          'qué arreglar deja a quien recibe el review releyendo el diff entero.',
        eje,
      );
    }

    findings.forEach((f, i) => {
      if (isPlaceholderText(f.file)) {
        problema(`${eje}.findings[${i}].file es un placeholder (${JSON.stringify(f.file)}).`, eje);
      }
      if (isPlaceholderText(f.why)) {
        problema(
          `${eje}.findings[${i}].why es un placeholder (${JSON.stringify(f.why)}). Escribí qué ` +
            'está mal y por qué importa.',
          eje,
        );
      }
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, envelope: raw };
}

/**
 * Coherencia entre el veredicto de la persona y lo que dicen los dos ejes.
 *
 * Va aparte del validador de forma porque no es un problema del envelope: el
 * envelope puede estar perfecto y el `outcome` contradecirlo. Devuelve el mensaje
 * de error, o `null` si son coherentes.
 */
export function verdictContradice(
  outcome: 'approved' | 'changes_requested',
  envelope: ReviewEnvelopeInput,
): string | null {
  const bloqueantes = EJES.filter((eje) => envelope[eje]?.verdict === 'blocking');

  if (outcome === 'approved' && bloqueantes.length > 0) {
    const detalle = bloqueantes
      .map((eje) => `${eje} (${envelope[eje].findings.length} hallazgo(s))`)
      .join(' y ');
    return (
      `No se puede aprobar: el review marca "blocking" en ${detalle}. Un approved sobre un eje ` +
      'que bloquea es la firma diciendo lo contrario que la evidencia. Enviá ' +
      'changes_requested, o bajá el eje a "advisory" si los hallazgos no bloquean de verdad.'
    );
  }

  if (outcome === 'changes_requested') {
    const conHallazgos = EJES.some((eje) => (envelope[eje]?.findings.length ?? 0) > 0);
    if (!conHallazgos) {
      return (
        'No se pueden pedir cambios sin hallazgos: los dos ejes vinieron sin ninguno. ' +
        'Quien reciba el review no tiene qué corregir. Agregá el hallazgo que motiva el rechazo.'
      );
    }
  }

  return null;
}
