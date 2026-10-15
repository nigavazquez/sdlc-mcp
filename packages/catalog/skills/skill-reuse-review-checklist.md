---
id: skill-reuse-review-checklist
version: 0.1.1
description: "En review con architecture_mode reuse o hybrid: los bloqueadores típicos cuando el reuso que declaró el RFC no se materializó (duplicación, wrappers, contratos rotos)."
---

# Skill: Code review checklist cuando hay reuso

Aplicable cuando `architecture_mode ∈ {reuse, hybrid}`. Verificá que el reuso declarado en el RFC se materializó en el código.

Bloqueadores típicos a buscar:

1. **Duplicación** — el PR contiene utilities o lógica que ya existe en uno de los componentes listados en `### Existing components reused`. Pedí reuso explícito.
2. **Wrappers innecesarios** — el PR envuelve un componente reusado en una clase/módulo nuevo sin agregar valor. Pedí justificación o eliminación.
3. **Ruptura de contratos públicos** — el PR modifica la API pública de un componente reusado sin coordinarlo. Si lo cambió, el RFC debería tener una sección sobre ese cambio.
4. **Fork interno** — el PR copió código del componente reusado a su propio módulo y lo modificó localmente. Pedí o reuso real, o un sub-RFC declarando el fork.
5. **Integration points no testeados** — para cada bullet de `### Integration points` del RFC, debe haber un test que lo cubra.

Cross-check obligatorio contra `### Integration points`:

- Cada contrato listado tiene su test correspondiente en el diff o ya estaba cubierto.
- Si el PR cambia un contrato declarado en el RFC, el RFC debería estar actualizado en el mismo PR (no en un follow-up).

Cuando encuentres alguno de estos, comentá como `Blocker (Required changes)`.
