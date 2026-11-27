---
architecture_mode: new | reuse | hybrid
codebase_status: greenfield | existing
existing_repo: <url o path — requerido si codebase_status=existing y la épica toca un solo repo>
# components: requerido si la épica toca más de un repo (servicios + módulos Terraform).
# Cada historia se asigna a un componente (1 historia = 1 repo = 1 PR).
# Omitilo si usás existing_repo (se sintetiza un único componente app).
# components:
#   - name: checkout-api
#     kind: app
#     repo: https://github.com/acme/checkout
#   - name: checkout-infra
#     kind: infra
#     repo: https://github.com/acme/platform-infra
#     repo_project: platform   # opcional: project key del PR provider si difiere del flow
---

# RFC: <Título técnico>

**Autores:** <nombres>
**Fecha:** <YYYY-MM-DD>
**Estado:** draft
**PRD origen:** <link/path>

## Context

<1-3 párrafos. Por qué este RFC existe ahora. Cita el PRD, no lo copies.>

## Architecture context

### Architecture mode

<1-2 párrafos justificando new / reuse / hybrid. Si reuse: qué se extiende. Si new: por qué no se puede reusar.>

### Existing components reused

<Bullets. Si architecture_mode=new, escribir "Ninguno — arquitectura nueva."

- <componente 1 — path o referencia interna>
- <componente 2>

### Codebase context

<Si codebase_status=greenfield: nombre propuesto del repo + stack tentativo.
Si codebase_status=existing: paths/módulos relevantes y convenciones a respetar.>

### Integration points

<Obligatorio si architecture_mode ∈ {reuse, hybrid}. Permitido vacío si new.

- <contrato / API / evento 1>
- <contrato 2>

## Goals

- <objetivo técnico medible 1>
- <objetivo técnico medible 2>

## Non-goals

- <fuera de scope técnico explícito 1>
- <fuera de scope técnico explícito 2>

## Design

### Architecture overview

<Diagrama en un bloque ```mermaid, vertical (`flowchart TB`), hasta 4 nodos por fila y etiquetas cortas: en Drive se publica como imagen de 624 px de ancho + descripción de componentes.>

### Data model

<Schemas, ER, contratos. No prosa.>

### API / Contracts

<Endpoints, payloads, eventos.>

### Security

<AuthN/AuthZ, datos sensibles, secretos.>

### Performance

<SLAs, throughput esperado, hot paths.>

## Alternatives considered

1. **<Alternativa 1>** — Descartada porque <razón concreta>.
2. **<Alternativa 2>** — Descartada porque <razón concreta>.

## Risks

| Riesgo | Tipo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|---|
| <riesgo 1> | perf/sec/data/integ | L/M/H | L/M/H | |
| <riesgo 2> | | | | |
| <riesgo 3> | | | | |

## Rollout

- Fase 1 (<%>): <criterios de health, métricas a observar>
- Fase 2 (<%>): <criterios de avance>
- Fase 3 (100%): <gate final>

## Rollback

<Pasos ejecutables a las 3am. Cada paso con comando/acción concreta.>

1. <paso>
2. <paso>
3. <paso>

## Observability

- **Métricas:** <lista>
- **Logs:** <campos estructurados>
- **Alertas:** <thresholds y destinos>

## ADRs

- <link a ADR si hay decisión one-way>

## Open Questions

- <pregunta>
