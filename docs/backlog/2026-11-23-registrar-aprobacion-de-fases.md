# Idea: Registrar la aprobación humana de cada fase

| Campo | Valor |
|---|---|
| Estado | Draft |
| Fecha | 2026-11-23 |
| Origen | Flow `default:sdlc-mcp:sdlc-repo-onboarding` (cierre del PRD) |
| Tipo | Feature (pendiente de Discovery) |

## Problema observado

Los roles del catálogo exigen un gate de **APROBADO** explícito del usuario para cerrar una fase (por ejemplo, el PRD en `prd-draft`). Hoy sdlc-mcp no tiene ninguna tool para registrar esa aprobación:

- El historial del flow sólo muestra `flow.started`, `prd.submitted` y `prd.published`. La aprobación no figura.
- El documento publicado en el doc store sigue diciendo `Estado: Draft` aunque el usuario lo haya aprobado.
- `submit_prd` pasa el flow a `prd_ready` / `current_phase: rfc` apenas la validación estructural da OK, antes de que el usuario apruebe. `submit_rfc` exige `prd_ready`, así que en la práctica el RFC puede empezar sin aprobación humana.

- `submit_prd` no tiene guarda de estado: si se reenvía el PRD con el flow en `rfc_ready` (o más adelante), el flow vuelve siempre a `prd_ready` / `current_phase: rfc`, aunque el RFC siga cargado. Se vio al corregir el REQ-10 de este mismo flow: hubo que reenviar el RFC para volver a `rfc_ready`. Si pasa con el backlog ya creado, el flow quedaría en un estado incoherente.

## Por qué importa

- No queda auditoría de quién aprobó qué, ni cuándo, ni sobre qué versión (sha256).
- El gate de aprobación depende sólo de que el agente respete el prompt, y eso no es un control.
- Es inconsistente con la feature `sdlc-repo-onboarding`, que convierte las reglas "sugeridas" en bloqueos reales.

## Ideas iniciales (sin validar)

- Agregar una tool tipo `approve_phase` (o `approve_prd` / `approve_rfc`), con actor, timestamp y el sha256 aprobado.
- Que las transiciones de fase exijan la aprobación registrada, no sólo la validación estructural.
- Actualizar el estado en el documento publicado (`Draft` → `Approved`).
- Si cambia el contenido después de aprobarlo (otro sha256), invalidar la aprobación.

## Pendiente

- Hacer el Discovery con el rol PM: usuarios, métricas, fuera de alcance.
- Definir si aplica a todas las fases (PRD, RFC, shaping, QA) o sólo a PRD y RFC.
