# Idea: Permitir el QA propio en workspaces de una sola persona, con registro explícito

| Campo | Valor |
|---|---|
| Estado | Implementada: épica #20 (flow `self-qa-single-member`, historias #21–#27) |
| Fecha | 2026-11-23 |
| Origen | Flow `default:sdlc-mcp:sdlc-repo-onboarding`, historia #6 (PR #17) |
| Tipo | Feature (pendiente de Discovery) |

## Problema observado

`submit_qa_results` rechaza que el assignee de una story firme su propio QA. Es correcto en un equipo, pero en un workspace con una sola persona (nigav, sus proyectos internos) deja el flow sin salida:

- La historia #6 quedó en `in_review` con el PR listo y no hay nadie más con rol `qa` en el workspace `sdlc-mcp`.
- Tener los seis roles no alcanza: la regla compara contra el assignee, no contra el rol.
- Las salidas de hoy son malas: crear una segunda cuenta para firmarse a uno mismo (el mismo control, con un disfraz) o mergear por fuera del flow (se pierde la trazabilidad).

## Por qué importa

- El objetivo de `sdlc-repo-onboarding` es que todo cambio pase por el flow. Si el flow no se puede cerrar, el incentivo es saltearlo.
- La separación implementar/verificar sigue siendo valiosa en workspaces con más de una persona: no se tiene que debilitar ahí.

## Ideas iniciales (sin validar)

- Configuración por workspace (`allow_self_qa`), apagada por defecto, que sólo un admin puede prender desde el panel.
- Cuando se usa, el resultado queda marcado (`self_signed: true` en el envelope y en el evento `qa.results.submitted`) y visible en el issue y en el PR.
- Que la evidencia siga siendo obligatoria (corrida de CI real): el QA propio relaja quién firma, no qué se prueba.
- Evaluar si aplica igual a `submit_review_outcome` (hoy también lo firmaría la misma persona) o si la review propia necesita otra regla.
- Alternativa: que el server lo permita automáticamente si el workspace tiene un único miembro con rol `qa`, sin flag. Más simple, pero cambia el comportamiento en silencio al sumar o quitar gente.

## Pendiente

- Discovery con el rol PM: alcance (QA, review o ambos), quién puede prender el flag, cómo se muestra.
- Decidir qué pasa con historias ya en `in_review` cuando se prende o apaga el flag.
- Cerrar la historia #6 del flow `sdlc-repo-onboarding` cuando esto exista.
