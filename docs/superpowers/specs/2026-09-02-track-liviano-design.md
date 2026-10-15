# Track liviano para fixes y mejoras chicas — Design

**Fecha:** 2026-09-02
**Estado:** implementado el 2026-09-02 en la rama `feat/track-liviano`. El diseño salió entero; las desviaciones de detalle están anotadas en el plan (`docs/superpowers/plans/2026-09-02-track-liviano.md`).

## Problema

Un fix de una línea paga hoy exactamente la misma ceremonia que una iniciativa nueva, y no
hay forma de evitarlo. La cadena de gates no tiene salidas:

- `submit_rfc` exige `prd_ready` — sin PRD no hay RFC.
- `propose_breakdown` y `create_epic` exigen `rfc_ready` — sin RFC no hay backlog.
- `create_stories` exige `flow.epic_external_id`, y `sync_backlog` exige ≥1 story para
  llegar a `backlog_ready`, que es lo único que habilita `claim_story`.

O sea: **no existe camino a implementación sin PRD y RFC aprobados.**

Y no es una ceremonia barata. El validador de PRD pide seis secciones, con
`success_metrics` de ≥3 líneas y `risks` de ≥3; el prompt del catálogo de `prd-draft`
pide además ≥2 KPIs cuantitativos con baseline, target y plazo, una North Star metric
explícita, requisitos funcionales numerados y NFRs cuantificadas. El validador de RFC pide
ocho secciones más tres subsecciones de contexto de arquitectura.

Para "el claim de `workspaces` no llega en el refresh del token" eso no produce rigor:
produce métricas inventadas. El propio prompt del PM llama a eso "una violación grave del
rol", así que el sistema, tal como está, empuja a violar su propia regla o a saltearse el
flow por completo y perder la trazabilidad. Las dos salidas son malas.

### Lo que ya está puesto y no se usa

`start_flow` exige `initiative_type` (`improvement | feature | refactor | fix`), lo
persiste en la tabla `flows` y lo expone en `GET /admin/api/workspaces/:id/flows`.
**Ningún código lo lee.** Es metadato muerto: el modelo ya distingue un fix de una feature
y después trata a los dos igual.

## Objetivo

Que un fix vaya de `start_flow` a `claim_story` en **dos llamadas**, con un documento corto
en lugar de dos largos, sin tocar ninguna de las garantías de entrega.

## No-goals

- **No se aflojan las gates de entrega.** El plan de QA, el sobre con `test_exit_code` /
  `test_output_hash` / cobertura `N/M`, y `assertNotSelfSignoff` siguen idénticos. Lo que
  se aliviana es el descubrimiento, no la verificación: un fix chico es justamente donde
  más seguido se rompe algo sin que nadie mire.
- **No se toca el track completo.** `feature` y `refactor` siguen exactamente como hoy.
- **No se agrega un campo nuevo para elegir el track.** El `initiative_type` ya existe y ya
  es obligatorio.
- **No se cambia el contrato de los adapters.** `StoryInput.epic_id` es requerido y así
  queda.

## Diseño

### 1. El track se deriva, no se declara

```ts
type FlowTrack = 'full' | 'lite';
trackForInitiative(t?: InitiativeType): FlowTrack
```

`fix` e `improvement` → `lite`. `feature` y `refactor` → `full`. **`undefined` → `full`**:
los flows anteriores a la migración `0011` pueden no tener `initiative_type`, y el default
seguro es la ceremonia completa. La ceremonia se afloja sólo si alguien lo pidió
explícitamente.

Derivarlo en vez de guardarlo evita el estado redundante que ya nos costó caro con
`tribu`/`squad`: una sola fuente de verdad, sin drift posible entre el tipo y el track.

### 2. La nota de cambio reemplaza al PRD y al RFC

Un documento, cuatro secciones: **qué pasa · cómo lo sé · qué cambio · cómo se verifica**.
Se publica en el doc store y se ancla con `sha256` en `flow.change_note_ref`, con la misma
forma de `ArtifactRef` que `prd_ref` y `rfc_ref`, y por el mismo camino de
`resolveDocFolderPath` + `doc_folder_path`.

Las cuatro secciones no son un PRD recortado: son lo que un fix sí tiene y un PRD no pide.
"Cómo lo sé" es el repro o la evidencia del bug, que es exactamente el dato que un PRD de
métricas de éxito no captura y que quien revise el PR va a querer.

#### Lo único del RFC que no se puede soltar

`create_stories` exige que toda story nazca con un repo declarado, porque
`submit_review_outcome` compara el PR contra el repo de la story y sin eso el gate de code
review no tiene contra qué comparar. Ese dato sale hoy del frontmatter del RFC
(`components` / `existing_repo`).

**La nota de cambio hereda ese frontmatter.** Es la única parte del RFC que sobrevive, y
sobrevive porque su ausencia rompería una gate de entrega, no porque sea documentación.

### 3. Una llamada hace el trabajo de seis

`submit_change_note` recibe la nota y las stories (típicamente una) y deja el flow en
`backlog_ready` / fase `implementation`, haciendo internamente lo que en el track completo
son `submit_prd`, `submit_rfc`, `propose_breakdown`, `create_epic`, `create_stories` y
`sync_backlog`.

El epic se crea igual, porque `StoryInput.epic_id` es requerido por el contrato de
adapters y porque un backlog externo con stories huérfanas es peor que uno con un epic de
una story. Lo que desaparece no es el epic: es que una persona tenga que pedirlo.

Orden interno, que es el mismo contrato que ya cumplen `submit_prd` y `submit_rfc`:

1. `resolveFlowForCtx` (resuelve y autoriza), `assertRole`, `assertFlowNotAborted`.
2. Track `lite` y status `draft`.
3. **Validación primero.** Si la nota no valida, no se escribe ni se publica nada.
4. Publish al doc store, no-fatal (el `sha256` es el ancla durable).
5. Epic y stories contra el task system.
6. Avance del flow por `updateFlowUnlessAborted`.

**Idempotencia:** si el flow ya tiene `epic_external_id` (reintento después de una falla
parcial entre los pasos 5 y 6), se reusa en lugar de crear un segundo epic.

### 4. Se sube de track, no se baja

Un flow `lite` que resultó más grande de lo pensado llama `submit_prd` y sigue el camino
completo: esas tools sólo miran el status, así que la escalada no necesita código. Al revés
no: `submit_change_note` sobre un flow `full` se rechaza con un mensaje que apunta a
`submit_prd`. Degradar una feature a nota de cambio sería el agujero, no la escalada.

### 5. Quién abre un fix

`start_flow` admite hoy `product-manager | tech-lead | pmo`: **un developer que encuentra un
bug no puede ni abrir el flow.** Para `initiative_type ∈ {fix, improvement}` se agrega
`developer`; `submit_change_note` admite `developer | tech-lead | pmo`.

Es el único lugar donde el track liviano amplía permisos, y no toca la separación de
funciones: `assertNotSelfSignoff` sigue impidiendo que quien escribió la nota e implementó
firme su propio QA o su propio review.

### 6. El catálogo tiene que saber de la fase

Se agrega la fase `change-note` al `PhaseId` y al catálogo (bajo `developer` y
`tech-lead`), con su prompt y un `change-note-template`. Sin esto `get_role_prompt` no
tiene qué entregar en la fase nueva — y entregar el prompt correcto por fase es el producto,
no un accesorio.

## Manejo de errores

| Caso | Respuesta |
|---|---|
| Flow de otro workspace / inexistente | La del helper de resolución, sin cambios |
| Track `full` | Rechazo explicando que un `feature`/`refactor` va por `submit_prd`, y que si el cambio es chico se abre un flow con `initiative_type: fix` |
| Status ≠ `draft` | Rechazo nombrando el status actual, con el mismo tono que `submit_rfc` |
| Nota inválida | Los `issues` del validador, sin ningún side-effect |
| Frontmatter sin repo declarado | Error, no warning: sin repo, el gate de review queda ciego |
| Publish al doc store falla | No-fatal, igual que en `submit_prd`: se persiste el `sha256` y se reporta `publish_error` |
| Falla creando stories después del epic | El `epic_external_id` ya quedó persistido; el reintento lo reusa |

## Testing

- Tabla del mapeo `initiative_type → track`, incluido el `undefined → full`.
- Validador de la nota: las cuatro secciones, el repo del frontmatter, y que un repo no
  comparable sea error.
- `submit_change_note`: las cinco guardas en orden, validación-primero sin side-effects,
  camino feliz hasta `backlog_ready`, e idempotencia del epic en el reintento.
- Extensión de la tabla del registry (`tools-resource-access.test.ts` como molde): toda tool
  declara qué tracks admite, de modo que una tool nueva no pueda olvidarse del gate.
- Las suites de `create_epic` y `create_stories` no cambian de resultado: el refactor que
  extrae sus núcleos es puro.
- End-to-end in-memory: `start_flow(fix)` → `submit_change_note` → `claim_story`, y el
  control negativo sobre un flow `feature`.

## Riesgos

**Que `lite` se vuelva el default de hecho** y las features entren declaradas como `fix`
para saltear el diseño. Es el riesgo real y no se cierra con código: el track queda en el
evento `flow.started` y en el panel admin, así que es medible. Si aparece, la respuesta es
la opción que hoy descartamos —que un tech-lead confirme el track— y no cerrar el atajo,
porque el atajo cerrado es lo que hoy empuja a saltearse el flow entero.

**Que la nota de cambio crezca hasta ser un PRD flaco.** El contrapeso es que sus cuatro
secciones piden hechos (qué rompió, cómo se sabe) y no proyecciones. Si en seis meses el
validador de la nota tiene ocho secciones, el track dejó de existir.
