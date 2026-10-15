---
id: skill-codebase-consistency-review
version: 0.1.1
description: "En review con codebase_status=existing: si el PR parece escrito por alguien que conoce el repo (naming, imports, logging, tests)."
---

# Skill: Code review checklist de consistencia con codebase existente

Aplicable cuando `codebase_status=existing`. El PR debe parecer escrito por alguien que conoce el repo.

Verificá:

1. **Naming y layering** — los archivos nuevos siguen el patrón del repo (kebab vs camel, ubicación, agrupación por feature vs por capa).
2. **Imports** — orden y agrupación consistentes con el resto del módulo.
3. **Logging y errores** — usa el wrapper estándar del repo. Sin `console.log` perdidos.
4. **Config / env** — usa el módulo central de config si existe. Sin `process.env` huérfanos en código de feature.
5. **Tests** — patrón de tests consistente (mismo framework, mismos helpers, ubicación correcta).
6. **Dependencias** — si el PR agrega una lib nueva, ¿se justificó? ¿hay una equivalente ya en el repo?

**Flag de "stack drift"** — un PR introduce silenciosamente una lib, un patrón o una abstracción nueva sin discusión:

- Una lib de HTTP/ORM/DI distinta a la que el resto del repo usa.
- Un patrón de async (callback en repo basado en promises, o RxJS en repo plain async/await).
- Una capa de abstracción nueva (DI container, mediator, repository pattern) cuando el repo no la usa en otros lugares.

Cuando detectes stack drift, comentá: "stack drift — el repo ya usa X para esto, ¿por qué Y?". Es bloqueante salvo que haya un ADR que lo justifique.

Nota: no es trabajo del reviewer reescribir convenciones. Si el "estilo de la casa" tiene un problema real, sugerí un issue/RFC separado, no fuerces el rework en este PR.
