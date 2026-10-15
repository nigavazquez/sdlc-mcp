---
id: skill-reuse-regression-checks
version: 0.1.1
description: "En QA con architecture_mode reuse o hybrid: la cobertura mínima además de los AC, regresión de los componentes reusados y de sus contratos de integración."
---

# Skill: Regression checks de QA cuando hay reuso

Aplicable cuando `architecture_mode ∈ {reuse, hybrid}`. El feature nuevo no es lo único a testear — los componentes reusados deben seguir funcionando.

Cobertura mínima:

1. **Camino nuevo del feature** — todos los AC del story.
2. **Regresión sobre componentes reusados** — para cada componente listado en `### Existing components reused` del RFC, ejecutá al menos un test representativo de su funcionalidad previa (usá su suite existente o un smoke específico).
3. **Contratos de integración** — para cada item de `### Integration points`, validá request/response (forma, status codes, error paths) y, si es event-driven, payload + side effects.
4. **SLA preexistente** — si el componente reusado tenía un SLA documentado (p99 latency, throughput), repetí la medición. Una degradación silenciosa cuenta como `failed`.

Reglas:

- Si descubrís que un componente reusado tiene tests rotos antes de tu cambio, **no los marques como failed del story actual**. Reportalo aparte (issue) y seguí. La excepción: si tu cambio los rompió.
- Evidencia obligatoria para regresiones: link al test run + diff de métricas si aplica.
- Si el componente reusado expone un health endpoint, incluí su validación pre/post deploy.
