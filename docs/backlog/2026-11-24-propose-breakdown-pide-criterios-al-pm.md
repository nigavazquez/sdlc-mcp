# Idea: Que `propose_breakdown` pida los criterios de aceptación al usuario con rol PM

| Campo | Valor |
|---|---|
| Estado | Draft |
| Fecha | 2026-11-24 |
| Origen | Shaping de los flows `sdlc-repo-onboarding` y `self-qa-single-member` |
| Tipo | Feature (pendiente de Discovery) |

## Problema observado

`propose_breakdown` (`apps/server/src/shaping/propose.ts`) arma las historias con una heurística determinista: toma cada bullet de `## Goals` del RFC como una historia y les deja `acceptance_criteria: []`. Su propia validación las marca como error ("must have at least one acceptance criterion").

- En los dos shapings que hicimos, la propuesta salió inutilizable: historias que son goals ("Gate en edición p95 < 200 ms") y ninguna con criterios.
- El agente terminó escribiendo el backlog a mano, criterios incluidos. Los criterios de aceptación son el contrato de la historia y los terminó definiendo el agente, no la persona con rol PM.
- Nada en el flow le pide esos criterios a una persona: el único control es que el usuario lea la tabla antes de que se creen los issues.

## Por qué importa

- Los criterios son lo que después verifica QA (`submit_qa_results` mide cobertura N/M contra ellos). Si los inventa el agente, QA verifica contra algo que nadie de producto validó.
- Es la misma clase de hueco que la aprobación de fases (ver `2026-11-23-registrar-aprobacion-de-fases.md`): el flow avanza con validaciones estructurales, no con decisiones humanas registradas.

## Qué rol confirma los criterios

El rol `product-manager` (siempre con su id del catálogo). "PM" es ambiguo: puede ser *Product Manager* (`product-manager`, dueño del PRD) o *Project Manager*, cuyo trabajo en el catálogo hace `pmo` (*Project Management Office*, descripto como "PMO / Delivery Lead"). Los criterios los propone el lado proyecto y los confirma el lado producto.

- `pmo` parte el RFC en historias y propone los criterios en borrador. Su prompt ya le pide que sean verificables ("2-5 AC verificables… demo de 5 minutos"): cuida la forma.
- `product-manager` los confirma o corrige contra los REQ del PRD: cuida el contenido. Un criterio de aceptación es una promesa de producto ("qué cuenta como terminado") y QA mide la cobertura contra él, así que lo firma quien es dueño del PRD.
- Hoy `product-manager` sólo tiene fases de PRD (discovery, draft, validate). Haría falta una fase nueva en el catálogo, por ejemplo `acceptance-review`, dentro del shaping.

## Ideas iniciales (sin validar)

- Que `propose_breakdown` devuelva las historias sugeridas con un estado `needs_acceptance_criteria` y un `next_action` explícito: pedirle al usuario, en el rol `product-manager`, los criterios de cada historia antes de `create_stories`.
- Una fase o sub-fase de shaping con el rol PM (prompt del catálogo) que tome la propuesta del PMO y complete o valide los criterios con el usuario, historia por historia.
- Que `create_stories` registre quién definió o validó los criterios (actor con rol `product-manager`), igual que la idea de registrar aprobaciones.
- Mejorar la heurística para partir el `## Design` en historias en vez de los `## Goals`, y sugerir criterios borrador a partir de Goals y Risks, siempre marcados como borrador hasta que el PM los confirme.

## Pendiente

- Discovery con el rol PM: ¿el PM escribe los criterios desde cero o confirma un borrador? ¿Se pide historia por historia o en bloque?
- Definir si `create_stories` debe rechazar historias cuyos criterios no fueron confirmados por alguien con rol `product-manager`.
- Relación con la idea de registrar aprobaciones de fases: probablemente compartan el mecanismo de "decisión humana registrada".
