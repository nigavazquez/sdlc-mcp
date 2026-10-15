---
id: skill-rfc-template
version: 0.1.1
description: Reglas para que un RFC sea construible, operable y revisable por pares.
---

# Skill: Redacción de RFC

Reglas no negociables:

- **Cabecera**: título, autores, fecha, estado, link al PRD origen.
- **Context**: 1-3 párrafos. Por qué este RFC existe ahora. Cita el PRD pero no lo copies.
- **Goals**: bullets accionables con criterio de éxito técnico (latencia, throughput, SLA).
- **Non-goals**: explícitos. Bloquea scope creep en review.
- **Design**: la sección más densa. Diagramas (texto/mermaid), componentes, contratos (schemas o snippets), flujo de datos, decisiones de almacenamiento, seguridad.
- **Alternatives considered**: al menos 2, con razón concreta de descarte. "Más simple" no alcanza.
- **Risks**: tabla técnica (perf, seguridad, integraciones, datos). Cada riesgo con mitigación implementable.
- **Rollout**: fases (canary, %, métricas de health, criterios de avance).
- **Rollback**: pasos ejecutables a las 3am. Si depende de "redeploy", no es rollback.
- **Observability**: métricas, logs estructurados, alertas. Qué se mide para saber que funciona.
- **ADRs**: para decisiones one-way (cambio de DB, protocolo, data model irreversible). Una decisión = un ADR.

Anti-patrones:
- "Microservicios" como solución sin justificar. Si no hay razón fuerte, monolito.
- Diagramas sin contratos. Un sistema sin schemas no es diseño, es ASCII art.
- Premature abstraction: interfaces para un solo implementador.
- "TBD" en design o rollback. Si no lo sabés, marcalo como Open Question explícita.
