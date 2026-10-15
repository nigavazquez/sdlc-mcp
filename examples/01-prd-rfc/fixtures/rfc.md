---
architecture_mode: reuse
codebase_status: existing
existing_repo: https://github.com/acme/checkout
---

# RFC: Pago en cuotas

**Autores:** Lucas Rodríguez (Tech Lead), Equipo Checkout
**Fecha:** 2026-05-10
**Estado:** draft
**PRD origen:** /docs/prd/cuotas.md

## Context

El PRD aprobado solicita pagos en 3/6/12 cuotas sin interés para compradores premium. El processor actual (Acquirex) ya soporta planes de cuotas vía un endpoint dedicado; lo que falta es la integración del frontend de checkout, el modelo de datos y el flujo de webhooks idempotente para conciliar cada cuota.

## Architecture context

### Architecture mode
Reusamos la arquitectura del servicio checkout existente. Acquirex ya soporta planes de cuotas; agregamos integración de frontend, modelo de datos y webhooks idempotentes encima de lo existente. No se inaugura arquitectura nueva.

### Existing components reused
- Checkout API (servicio existente)
- Acquirex SDK (integración de processor ya en uso)
- Webhook receiver del checkout

### Codebase context
Monorepo del checkout (TypeScript). Se respetan las convenciones de naming, el logger estructurado con trace_id, y el patrón de migraciones online ya en uso. No se introducen libs nuevas de HTTP/ORM.

### Integration points
- Evento `checkout.order.created` (consumido para iniciar el plan).
- `POST /v1/checkout/plans` (contrato nuevo expuesto por Checkout API).
- `POST /v1/webhooks/acquirex` (webhook idempotente por `event_id`).

## Goals

- Pago en cuotas con p99 < 800ms en el step "Confirm" del checkout.
- Idempotencia end-to-end: un mismo `order_id` no genera duplicados aunque el webhook llegue varias veces.
- Visibilidad para conciliación: dashboard con estado por cuota y por orden.

## Non-goals

- Refinanciación post-compra.
- Tarjetas corporativas / débito.
- Migración del modelo de pagos existente (solo agregamos planes encima).

## Design

### Architecture overview

```
Checkout SPA ──▶ Checkout API ──▶ Acquirex SDK ──▶ Processor
                      │
                      ├──▶ payments_plans (Postgres, nuevo)
                      │
                      └──▶ Webhook receiver (idempotent) ──▶ Conciliation worker
```

### Data model

```sql
CREATE TABLE payments_plans (
  id           UUID PRIMARY KEY,
  order_id     UUID NOT NULL,
  installments SMALLINT NOT NULL CHECK (installments IN (3,6,12)),
  amount_total NUMERIC(12,2) NOT NULL,
  status       TEXT NOT NULL, -- pending | active | failed | completed
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payments_installments (
  id           UUID PRIMARY KEY,
  plan_id      UUID NOT NULL REFERENCES payments_plans(id),
  position     SMALLINT NOT NULL,
  amount       NUMERIC(12,2) NOT NULL,
  due_at       DATE NOT NULL,
  status       TEXT NOT NULL, -- pending | charged | failed
  external_id  TEXT
);

CREATE UNIQUE INDEX uq_installment_external ON payments_installments(external_id) WHERE external_id IS NOT NULL;
```

### API / Contracts

`POST /v1/checkout/plans` → `{ plan_id, schedule[] }`
`POST /v1/webhooks/acquirex` → 200 (idempotent por `event_id`)

### Security

- 3DS obligatorio para ticket > 100 USD si hay cuotas.
- Webhook firmado con HMAC-SHA256, secret rotable.
- PII (nombre, tarjeta enmascarada) no se loguea.

### Performance

- p99 checkout < 800ms con cuotas activas (medido contra baseline 620ms sin cuotas).
- Worker de conciliación procesa 200 webhooks/seg en peak.

## Alternatives considered

1. **Cuotas implementadas client-side simulando con Acquirex Charge único**. Descartada porque deja la conciliación off-band y bloquea el dashboard.
2. **Usar el processor B (BankPay)**. Descartada porque no soporta 12 cuotas y exige onboarding de 8 semanas.

## Risks

| Riesgo | Tipo | Probabilidad | Impacto | Mitigación |
| Webhook drop | integ | M | H | Cola de retry con DLQ + reconciliación nocturna |
| Migración bloqueante | data | L | H | Backfill async; tablas nuevas, no se tocan las existentes |
| Costo por txn supera presupuesto | perf | M | M | Cap mensual por cliente + alerta a 80% del cap |

## Rollout

- **Fase 1 (canary 5% durante 48h):** habilitar feature flag `payments_installments` solo para usuarios premium en AR. Métrica clave: p99 checkout, tasa de fallback a pago único.
- **Fase 2 (25% durante 72h):** ampliar a premium en LATAM. Gate: cero incidentes Sev1, p99 < 800ms sostenido.
- **Fase 3 (100%):** sign-off de Producto + Operaciones.

## Rollback

1. Desactivar feature flag `payments_installments` en LaunchDarkly (dashboard, 1 click).
2. Drenar la cola de webhooks pendientes con el script `scripts/drain_acquirex.ts`.
3. Si hay datos huérfanos en `payments_plans` con status `pending`, marcarlos como `failed` vía job manual (`pnpm task:cleanup-pending`).
4. Las tablas nuevas quedan en la DB (no rompen nada); no hay rollback de schema necesario.

## Observability

- **Métricas:** `checkout.installments.requests`, `checkout.installments.errors`, `webhooks.acquirex.lag_seconds`, `payments_plans.status_count`.
- **Logs:** estructurados con `trace_id`, `order_id`, `plan_id`. Sin PII.
- **Alertas:** lag de webhook > 60s; tasa de error > 1% sostenida 5min.

## ADRs

- ADR-014: por qué usar tablas nuevas y no extender `payments`.

## Open Questions

- ¿Soportamos pause de cuotas en fase 1? Producto dijo no, pero confirmar antes del freeze.
