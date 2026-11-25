# PRD: QA y code review propios por proyecto, con registro explícito

| Campo | Valor |
|---|---|
| Autor | Nicolas Vazquez (vazquez.n.g@gmail.com) |
| Vertical | sdlc-mcp (plataforma interna) |
| Q / Año | Q4 / 2026 |
| Tipo de Iniciativa | New Feature |
| Prioridad | Alta: destraba la épica `sdlc-repo-onboarding` (#5), cuya historia #6 está trabada en `in_review` |
| Estado | Aprobado (2026-11-24) |
| Fecha | 2026-11-24 |

> Flow: `default:sdlc-mcp:self-qa-single-member`. Fuente: `docs/backlog/2026-11-23-qa-propio-en-workspaces-de-una-persona.md` y las respuestas de Discovery del 2026-11-24.

## Resumen Ejecutivo

En sdlc-mcp cada persona puede ser un equipo completo: implementa, verifica y revisa sus propios cambios. Hoy el sistema lo impide, porque exige que quien firma el QA y el code review sea alguien distinto de quien implementó, y una persona que trabaja sola no puede cerrar ninguna historia. Proponemos que la verificación y la revisión propias estén permitidas por defecto en cada proyecto, que se puedan desactivar en los proyectos donde hay un equipo que tiene que revisar con otras personas, y que cada firma propia quede marcada de forma visible, con detalle y evidencia, en el historial, en el issue y en el PR.

## Visión y Estrategia

El objetivo de la iniciativa `sdlc-repo-onboarding` es que todo cambio pase por el flow. Si el flow no se puede cerrar, el incentivo es saltearlo y se pierde la trazabilidad. Esta feature mantiene a las personas que trabajan solas dentro del flow y deja que cada proyecto con equipo conserve la separación implementar/verificar.

## Problema

- **Problema**: Las personas que implementan una historia no pueden firmar su QA ni su code review, aunque tengan los roles `qa` y `reviewer`, porque el sistema rechaza que quien tiene asignada la historia firme su propia verificación o revisión. En un proyecto de una sola persona eso deja todas las historias trabadas en `in_review`.
- **Evidencia**: Todos los proyectos que hoy maneja la instancia nigav son de una sola persona. La historia #6 del flow `default:sdlc-mcp:sdlc-repo-onboarding` quedó en `in_review` con el PR #17 listo y CI verde, y las historias #7 y #12 (PR #18 y #19) van al mismo lugar.
- **Oportunidad**: Que cada persona complete el flow de punta a punta, sin las salidas que destruyen el valor del control: crear una segunda cuenta para firmarse a uno mismo o mergear por fuera del flow.

## Usuarios

- **Persona que es su propio equipo (ej. nigav en `sdlc-mcp` y el resto de sus proyectos)**: implementa, verifica y revisa sus propios cambios — hoy no puede cerrar ninguna historia dentro del flow.
- **Administrador de la instancia (panel admin)**: gestiona proyectos y membresías — necesita poder exigir revisión de otra persona en los proyectos que tienen equipo.
- **Quien lee el historial de una story, issue o PR**: necesita distinguir a simple vista una verificación independiente de una propia, y ver qué se verificó.
- **Miembro de un proyecto con equipo**: su interés es que, donde se desactivó, la separación de funciones se siga cumpliendo.

## Métricas de éxito

| Métrica | Baseline | Target | Plazo |
|---|---|---|---|
| Historias trabadas en `in_review` por falta de otra persona que firme, en proyectos con la firma propia permitida | 3 (#6, #7 y #12 de `sdlc-repo-onboarding`) | 0 | Una semana después del launch |
| Firmas propias (QA o review) sin marca, sin comentario de detalle o sin evidencia por criterio de aceptación | No aplica (hoy no están permitidas) | 0 | Desde el launch |
| Firmas propias aceptadas en proyectos donde la firma propia está desactivada | 0 | 0 | Siempre |
| Cambios mergeados por fuera del flow en los proyectos de nigav | [TBD: Definir con Data] | 0 | 30 días post-launch |

- **North Star Metric**: historias que llegan a cerrarse por el flow (de `in_review` a `merged`) en proyectos de una sola persona, sin cuentas adicionales ni merges por fuera. Baseline 0, target 100% de las historias de la épica `sdlc-repo-onboarding`.
- **Métricas de Salud**: en proyectos con la firma propia desactivada se sigue rechazando el 100% de las firmas propias; la tasa de errores de las tools de firma no cambia respecto de hoy.

## Propuesta de Valor / Hipótesis

> Creemos que al **permitir por defecto la verificación y la revisión propias, desactivables por proyecto y siempre registradas con detalle y evidencia** para **las personas que son su propio equipo**, lograremos **que cierren sus historias dentro del flow sin crear cuentas falsas ni mergear por fuera**, y lo sabremos cuando **las historias trabadas en `in_review` por falta de otra persona bajen de 3 a 0 y el 100% de las firmas propias quede marcado en el issue y en el PR**.

## Requisitos Funcionales

- **REQ-1**: El sistema debe permitir por defecto, en todos los proyectos existentes y nuevos, que quien tiene asignada una historia firme su propio QA y su propio code review.
- **REQ-2**: El sistema debe permitir que un administrador desactive y vuelva a activar la firma propia por proyecto. Con la firma propia desactivada, se rechaza con un mensaje que explique por qué y cuál es la salida (que firme otra persona del proyecto).
- **REQ-3**: La firma propia debe cubrir los tres pasos de verificación: el resultado de QA, la solicitud de code review y el resultado del code review.
- **REQ-4**: El sistema debe evaluar la regla en el momento de firmar, de modo que aplique también a las historias que ya están en `in_review` (incluida la #6 de `sdlc-repo-onboarding`).
- **REQ-5**: El sistema debe seguir exigiendo, para una firma propia, la misma evidencia que para una independiente: una evidencia por cada criterio de aceptación y cobertura completa de los criterios. No se pide una justificación adicional.
- **REQ-6**: El sistema debe marcar cada firma propia con una etiqueta y un comentario en el issue y en el PR asociados. El comentario debe detallar qué se verificó: cada criterio de aceptación con su resultado, los links de evidencia y los screenshots. Los screenshots los adjunta quien firma, como parte de la evidencia; el sistema no los genera.
- **REQ-7**: El sistema debe registrar cada firma propia en el historial del flow como tal, distinguible de una firma independiente.
- **REQ-8**: El sistema debe registrar quién desactivó o activó la firma propia de un proyecto, cuándo, y el valor anterior y nuevo.
- **REQ-9**: El sistema debe mostrar, para cada proyecto, si la firma propia está permitida, en el panel de administración y en la información del proyecto que reciben los participantes del flow.
- **REQ-10**: Sumar o quitar miembros de un proyecto no debe cambiar la configuración de la firma propia: sólo la cambia un administrador.

## Requisitos No Funcionales

- **Performance**: leer la configuración del proyecto no debe agregar latencia perceptible a las tools de firma: p95 sin una degradación mayor a 50 ms respecto de hoy.
- **Seguridad**:
  - El default es "permitida" por decisión de producto (cada persona es un equipo completo). Fallar cerrado aplica a la lectura: si la configuración de un proyecto existe pero no se puede leer, se rechaza la firma propia.
  - Aislamiento estricto entre proyectos y clientes: la configuración de un proyecto no tiene efecto sobre ningún otro, aunque compartan tenant o miembros.
  - Sólo un administrador cambia la configuración; los participantes del flow no la pueden cambiar desde las tools del flow.
  - Los roles requeridos para firmar no cambian: la firma propia relaja la regla de identidad (asignado ≠ firmante), no la de rol.
- **Disponibilidad**: un cambio de configuración aplica a la próxima firma, sin reinicio ni despliegue.
- **Otros (opcional)**: auditabilidad — cada firma propia y cada cambio de configuración quedan en el historial de eventos y no se pueden borrar desde el flow.

## Alcance

- Firma propia permitida por defecto en QA, solicitud de review y resultado de review.
- Desactivación y reactivación por proyecto desde el panel de administración.
- Evaluación de la regla al momento de firmar, también para historias ya en `in_review`.
- Evidencia por criterio de aceptación, igual que una firma independiente.
- Etiqueta y comentario con detalle y screenshots en el issue y en el PR.
- Registro en el historial de cada firma propia y de cada cambio de configuración.
- Visibilidad de la configuración en el panel y para los participantes del proyecto.
- Cierre de las historias #6, #7 y #12 de `sdlc-repo-onboarding` como primeros casos reales.

## Fuera de alcance

- Desactivar o alertar automáticamente cuando un proyecto suma un segundo miembro — Razón: decisión del usuario; la configuración la cambia sólo un administrador.
- Eximir a la firma propia de la evidencia por criterio de aceptación — Razón: la feature cambia quién firma, no qué se prueba.
- Configuración por flow o por historia individual — Razón: el equipo es una propiedad del proyecto, no de una historia.
- Que los participantes del flow cambien la configuración desde las tools del flow — Razón: sería autoasignarse una excepción a un control de autorización.
- Cerrar automáticamente las historias trabadas — Razón: la firma sigue siendo un acto explícito de la persona.

## Riesgos

| Riesgo | Probabilidad (L/M/H) | Impacto (L/M/H) | Mitigación |
|---|---|---|---|
| Un proyecto suma un equipo y nadie desactiva la firma propia, así que el control queda relajado | M | H | Estado visible en el panel y en el proyecto; cada firma propia queda marcada en el issue y en el PR, así se ve en la revisión del equipo |
| La configuración de un proyecto afecta a otro (fuga entre proyectos o clientes) | L | H | Aislamiento estricto; pruebas que crucen proyectos; fallar cerrado en la lectura |
| El default permitido sorprende a un cliente externo que espera revisión independiente | M | M | Al dar de alta un proyecto de cliente con equipo, el administrador la desactiva; queda en el checklist de alta de proyectos |
| Comentarios con screenshots exponen información sensible en el issue o PR | L | M | Los screenshots salen de la evidencia que ya adjunta quien firma; el comentario no agrega datos nuevos |

## Dependencias

| Servicio / Equipo | Referente | Resuelto |
|---|---|---|
| Panel admin (configuración por proyecto) | Nicolas Vazquez | No |
| Integración con GitHub para etiqueta y comentario en issue y PR | Nicolas Vazquez | No |
| Flow `default:sdlc-mcp:sdlc-repo-onboarding` (historias #6, #7 y #12) como caso de validación | Nicolas Vazquez | En curso |

## Preguntas abiertas

- Baseline de cambios mergeados por fuera del flow en los proyectos de nigav. — Dueño: Nicolas Vazquez — Fecha objetivo: 2026-12-01.

## Referencias / Mockups

- Idea de origen: `docs/backlog/2026-11-23-qa-propio-en-workspaces-de-una-persona.md`
- Casos reales: flow `default:sdlc-mcp:sdlc-repo-onboarding`, historias #6, #7 y #12 (PR #17, #18 y #19)
- Regla actual de separación de funciones: `docs/ARCHITECTURE.md` (autorización por workspace)
