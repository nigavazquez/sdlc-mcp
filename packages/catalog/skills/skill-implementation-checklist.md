---
id: skill-implementation-checklist
version: 0.2.1
description: Checklist mínimo antes de marcar una historia como `in_review`.
---

# Skill: Checklist de implementación

## Antes del primer test: acordá el seam

Escribí cuáles son los límites públicos que vas a testear —qué función, qué endpoint, qué
módulo— y confirmalos antes de escribir el primer test. **Ningún test se escribe contra un
seam sin confirmar.**

Es el paso que más barato se saltea y más caro sale: un test escrito contra un colaborador
interno o contra un método privado queda acoplado a la implementación, así que el próximo
refactor lo rompe sin que nada se haya roto de verdad. Un test contra el seam correcto
sobrevive al refactor y se lee como especificación: "el usuario puede pagar con el carrito
válido" dice qué capacidad existe.

El otro lado de la misma regla: **el refactor pertenece al review, no al ciclo de
implementación.** Dentro del ciclo va rojo → verde y nada más; mejorar la forma de lo que
ya pasa es una conversación aparte, con su propio diff.

## Antes de llamar `report_progress(status:"in_review")`:

- [ ] Cada AC tiene un test que lo cubre.
- [ ] Happy path + al menos 1 error path para endpoints/funciones públicas nuevas.
- [ ] Lint y typecheck verdes localmente.
- [ ] Métricas + logs estructurados agregados donde aplique.
- [ ] No hay secrets ni PII en logs.
- [ ] Migrations son backwards-compatible o tienen plan de rollout documentado.
- [ ] Commits pequeños con mensajes accionables.
- [ ] PR description con: link a story, cambios (bullets), cómo probarlo, métricas/logs.
- [ ] Diff < 800 líneas (si más, partir el PR).

Antipatrones a evitar:

- "Refactor de paso" — abrí un PR separado.
- Skip de tests con `--no-verify` o flags análogos.
- Agregar deps nuevas sin discutirlo.
- Cambios fuera del scope de la historia.
