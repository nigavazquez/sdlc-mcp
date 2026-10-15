import { describe, expect, it } from 'vitest';
import { validatePrd } from '../src/validation/prd.js';

const RAW_TEMPLATE = `
# PRD: <Nombre de la Iniciativa>

## Problema

- **Problema**: <descripción del dolor del usuario en una frase>
- **Evidencia**: <datos cualitativos o cuantitativos>
- **Oportunidad**: <qué ganamos al resolverlo>

## Usuarios

- **<Rol/persona específico>**: <contexto> — <dolor actual concreto>
- **<Rol/persona específico>**: <contexto> — <dolor actual concreto>

## Métricas de éxito

| Métrica | Baseline | Target | Plazo |
|---|---|---|---|
| <KPI 1> | <valor> | <valor> | <plazo> |
| <KPI 2> | <valor> | <valor> | <plazo> |
| <KPI 3> | <valor> | <valor> | <plazo> |

## Alcance

- <capacidad verificable 1>
- <capacidad verificable 2>

## Fuera de alcance

- <ítem 1> — Razón: <breve>
- <ítem 2> — Razón: <breve>
- <ítem 3> — Razón: <breve>

## Riesgos

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| <riesgo 1> | <L/M/H> | <L/M/H> | <mitigación> |
| <riesgo 2> | <L/M/H> | <L/M/H> | <mitigación> |
| <riesgo 3> | <L/M/H> | <L/M/H> | <mitigación> |
`;

const PRD_WITH_TBDS = `
# PRD: Pago en cuotas

## Problema

- Problema: Los compradores premium abandonan el checkout cuando el ticket supera USD 200.
- Evidencia: [TBD: Definir con Data]
- Oportunidad: Recuperar conversión en segmento de mayor margen.

## Usuarios

- Comprador premium recurrente: ticket > 200, abandona en checkout.
- Comprador ocasional: ticket bajo, feedback útil.

## Métricas de éxito

| Métrica | Baseline | Target | Plazo |
|---|---|---|---|
| Conversion premium | [TBD: Definir con Data] | 2.5% | 60 días |
| Ticket promedio | [TBD: Definir con Data] | 250 | 60 días |
| Reclamos cuotas | n/a | 2% | 90 días |

## Alcance

- Cuotas 3, 6, 12 sin interés.
- Validación de tarjeta antes de cobrar primera cuota.

## Fuera de alcance

- Cuotas con interés del banco.
- Refinanciación post-compra.
- Soporte tarjetas corporativas.

## Riesgos

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Fraude con cuotas | M | H | 3DS obligatorio |
| Backoffice no preparado | M | M | Capacitación previa |
| Performance pagos | L | H | Carga + circuit breaker |
`;

const PRD_COMPLETE = `
# PRD: Pago en cuotas

## Problema

- Problema: Los compradores premium abandonan el checkout cuando el ticket supera USD 200.
- Evidencia: 38% de abandonos en sesiones con ticket > USD 200 (Analytics Q1-2026).
- Oportunidad: Recuperar 12 puntos de conversión en segmento premium.

## Usuarios

- Comprador premium recurrente: ticket > 200, abandona en checkout.
- Comprador ocasional: ticket bajo, feedback útil.

## Métricas de éxito

| Métrica | Baseline | Target | Plazo |
|---|---|---|---|
| Conversion premium | 1.8% | 2.5% | 60 días |
| Ticket promedio | 180 | 250 | 60 días |
| Reclamos cuotas | n/a | 2% | 90 días |

## Alcance

- Cuotas 3, 6, 12 sin interés.
- Validación de tarjeta antes de cobrar primera cuota.

## Fuera de alcance

- Cuotas con interés del banco.
- Refinanciación post-compra.
- Soporte tarjetas corporativas.

## Riesgos

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| Fraude con cuotas | M | H | 3DS obligatorio |
| Backoffice no preparado | M | M | Capacitación previa |
| Performance pagos | L | H | Carga + circuit breaker |
`;

describe('PRD validation: TBD vs angle-bracket placeholders', () => {
  it('rejects raw template (unfilled <...> placeholders) with error severity', () => {
    const result = validatePrd(RAW_TEMPLATE);
    expect(result.ok).toBe(false);
    const errors = result.issues.filter((i) => i.severity === 'error');
    expect(errors.some((i) => /placeholders/.test(i.message))).toBe(true);
  });

  it('accepts PRD with [TBD: ...] markers as ok=true and reports warnings', () => {
    const result = validatePrd(PRD_WITH_TBDS);
    expect(result.ok).toBe(true);
    const tbdWarnings = result.issues.filter(
      (i) => i.severity === 'warning' && /TBD/.test(i.message),
    );
    expect(tbdWarnings.length).toBeGreaterThan(0);
    // No debe haber errores de placeholder por los TBDs
    const placeholderErrors = result.issues.filter(
      (i) => i.severity === 'error' && /placeholders/.test(i.message),
    );
    expect(placeholderErrors.length).toBe(0);
  });

  it('accepts complete PRD with no issues', () => {
    const result = validatePrd(PRD_COMPLETE);
    expect(result.ok).toBe(true);
    expect(result.issues.length).toBe(0);
  });
});
