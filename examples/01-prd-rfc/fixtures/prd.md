# PRD: Pago en cuotas

**Autor:** Camila Pérez (PM)
**Fecha:** 2026-05-10
**Estado:** draft

## Problem

Los compradores premium abandonan el checkout cuando el ticket supera USD 200 porque no podemos ofrecerles cuotas sin interés en tiempo real.

## Users

- **Comprador premium recurrente**: ticket > 200 USD; abandona al ver el total porque su tarjeta no le permite el cargo único. Hoy migra a la competencia.
- **Comprador ocasional**: ticket bajo. No es nuestro target pero el feature no debe degradar su experiencia (>200ms extra rompe la métrica de checkout time).

## Success Metrics

| Métrica | Baseline actual | Target | Plazo |
|---|---|---|---|
| Conversión premium (ticket > 200) | 1.8% | 2.5% | 60 días post-launch |
| Ticket promedio premium | 180 USD | 250 USD | 60 días post-launch |
| Reclamos relacionados a cuotas | n/a (feature nuevo) | < 2% de transacciones con cuotas | 90 días |

## Scope

- Cuotas de 3, 6 y 12 sin interés para tarjetas de crédito Visa/Master locales.
- Validación de tarjeta y disponibilidad de cupo antes de cobrar la primera cuota.
- Mostrar el cronograma de cuotas en el checkout antes de confirmar.

## Out of Scope

- Cuotas con interés financiadas por el banco emisor (sale en una fase 2).
- Refinanciación post-compra (cambiar el plan después de pagar la primera cuota).
- Soporte para tarjetas corporativas o débito.

## Risks

| Riesgo | Probabilidad (L/M/H) | Impacto (L/M/H) | Mitigación |
| Fraude por uso de tarjetas robadas | M | H | 3DS obligatorio + score antifraude por encima de 70 |
| Backoffice no preparado para conciliación | M | M | Capacitación previa + dashboard de conciliación |
| Aumento de latencia en checkout | L | H | Carga de prueba con 5x el peak + circuit breaker contra processor |

## Open Questions

- ¿Qué tarjetas Amex incluimos en fase 1? — Dueño: Camila — Para: 2026-05-20

## Stakeholders

- Sponsor: Director Comercial
- Product: Camila Pérez
- Engineering lead: Lucas Rodríguez
- Legal/Compliance: Marta López (necesita firmar antes del rollout)
