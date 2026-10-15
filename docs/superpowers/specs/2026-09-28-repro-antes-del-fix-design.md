# El repro antes del fix — Design

**Fecha:** 2026-09-28
**Estado:** implementado.
**Origen:** candidato 4 de la tanda 3 (`2026-09-14-analisis-tanda-3-design.md` § 4).

## Problema

El track liviano existe para los `fix` y los `improvement`, y es justamente el que no le
pide al diagnóstico ninguna evidencia ejecutable. Del otro extremo del mismo flow,
`submit_qa_results` exige un `test_command`, un `test_exit_code` en 0 y un
`test_output_hash`: la **entrega** se demuestra con un comando que alguien corrió. El
**diagnóstico**, no. La nota de cambio pide "Cómo lo sé" con `minContentLines: 1`, que se
satisface con cualquier frase.

Un fix que entra sin comando rojo llega a QA con un plan generado a partir de criterios que
nadie pudo verificar que fallaran antes.

## Objetivo

Que toda nota de cambio declare cómo se reproduce lo que arregla o mejora, **o por qué no
se pudo**, y que esa declaración quede registrada de forma que se pueda medir si el campo
sirve.

La frontera es la de siempre: el server rechaza lo que se decide sin leer el contenido
(que la declaración exista y no sea relleno); la skill se ocupa de lo que hay que leer
(si el comando reproduce *este* síntoma, si la razón del `no_repro` es real).

## No-goals

- **Ejecutar el `repro`.** El server no corre nada, igual que no corre el `test_command` de QA.
- **Una sección nueva en la nota.** Es un campo de frontmatter. La nota vale por ser corta.
- **Una columna o una migración.** La declaración viaja en el evento.
- **Exigir que el `repro` reaparezca como `test_command` en QA.** Es la pregunta que el dato
  permite hacer después, no una regla de hoy.

## Diseño

### 1. El piso mecánico: `validateChangeNote`

El frontmatter de la nota, que hoy lleva `repo`/`components`, suma **exactamente una** de
dos claves:

```yaml
repro: pnpm --filter @sdlc/server test -- -t "claim_story sobre story bloqueada"
# o
no_repro: reportado por soporte en el ticket 4411; pasa sólo con datos de prod
```

En un `improvement`, `repro` es el comando que muestra el comportamiento actual: la línea
base contra la que se mide la mejora.

| Caso | Resultado |
|---|---|
| Ninguna de las dos | Error. El mensaje nombra las dos salidas y dice que `no_repro` es legítima |
| Las dos a la vez | Error: una nota no puede afirmar las dos cosas |
| Valor que no es string | Error |
| Valor vacío o relleno (`n/a`, `TBD`, `-`, `???`) | Error, vía `isPlaceholderText` (`qa-envelope.ts`) — el mismo rechazo que ya aplican los AC y el envelope de review |
| Valor con un placeholder de template (`<comando>`) | Error, vía `templatePlaceholderFragment`, un detector local de `change-note.ts` (no el `hasAngleBracketPlaceholder` de `markdown-sections.ts`, que sigue privado): la regex es `/<\p{L}[\p{L}_-]*(?:\s+[\p{L}_-]+)+>/u` — un placeholder es de **varias palabras** hechas sólo de letras, `_` o `-`, así que una redirección de shell (`cmd < in > out`, `<(cmd)`), un tag de una sola palabra (`<title>`, `Array<string>`) o un comando real como `sort <in.txt 2>err.log` pasan como repro válido |
| Más de 500 caracteres | Error (ver § 2) |

Todos son **error**, no warning, por la misma razón que el repo: un campo que se satisface
con cualquier cosa no mide nada. Y se **acumulan** con los de secciones y repo, como hoy:
el autor recibe todo lo que tiene que corregir de una vez.

No hace falta ramificar por `initiative_type`: `submit_change_note` ya rechaza cualquier
flow que no sea del track liviano (`trackForInitiative(...) !== 'lite'`), así que toda nota
que llega al validador es de un `fix` o un `improvement`.

`validateChangeNote` devuelve la declaración parseada, al lado de `components`:

```ts
repro?: { kind: 'repro' | 'no_repro'; value: string }   // value con trim
```

### 2. Qué se guarda, y dónde

`submit_change_note` suma `repro` al payload del evento `change_note.submitted`:

```json
{ "sha256": "…", "doc_url": "…", "published": true,
  "repro": { "kind": "repro", "value": "pnpm --filter @sdlc/server test -- -t \"…\"" } }
```

- **Por qué el evento y no una columna:** la nota no se persiste —sólo su sha256, y el
  publish al doc store puede fallar sin cortar nada—, así que sin esto no queda registro.
  El evento ya existe, no lleva migración, y el `test_command` de QA ya vive en
  `qa.results.submitted`: los dos se cruzan en `flow_events`.
- **Por qué el texto y no sólo el tipo:** el tipo alcanza para la proporción
  `repro`/`no_repro`; el texto es lo que permite ver si el comando reaparece como
  `test_command`, que es donde el bucle se cerraría de verdad.
- **El tope de 500 caracteres** es porque el payload del evento es un campo abierto: es lo
  que pasó con `block_reason` en QA, que dejaba entrar 2 MB al event log. Un comando con
  filtros o una razón de dos frases entran; un log pegado, no.
- **Sin nota válida no se escribe nada**, como hoy: `repro` sólo llega al evento si la nota
  entera pasó.
- La respuesta de la tool devuelve `repro` dentro de `data.validation`, para que el agente
  vea qué quedó registrado.

**El texto se guarda tal cual.** La skill le pide al developer que el `repro` no lleve
tokens ni ids de clientes; el server no lo puede verificar.

### 3. La skill: `skill-repro-antes-del-fix`

Una sola skill para los dos momentos, adaptada de `diagnosing-bugs` (mattpocock/skills):

**Al escribir la nota.**
- La señal roja primero: un comando que falla por *este* bug y no por uno vecino,
  determinista, lo más acotado posible.
- En un `improvement`, la medición de la línea base.
- Cuándo `no_repro` es la respuesta honesta (sólo con datos de prod, intermitente sin
  disparador conocido) y cómo escribir la razón para que quien verifique sepa qué mirar.
- El `repro` sin tokens ni ids de clientes.

**Al implementar.**
- Minimizar el repro.
- Tres a cinco hipótesis falsables antes de tocar código.
- Instrumentar cambiando una variable por vez.
- El arreglo arranca con el test de regresión que reproduce el `repro`, visto fallar, en el
  seam correcto.
- Limpiar la instrumentación.
- Ese comando es el candidato natural para el `test_command` de QA.

La `description` sigue el criterio de `PROMPT_AUTHORING.md`: cuándo aplica y qué cambia.

### 4. Dónde se adjunta: un eje de escenario nuevo

- **`developer.change-note`:** skill base. La fase es exclusiva del track liviano.
- **`developer.implement`:** por escenario, no en la base. La fase es la misma para todos
  los flows y a una feature la skill le sería ruido. Las skills de escenario hoy se eligen
  por `architecture_mode`, `codebase_status` y `component_kind`; se suma `initiative_type`:

  ```yaml
  scenario_skills:
    developer.implement:
      initiative_type:
        fix: [skill-repro-antes-del-fix]
        improvement: [skill-repro-antes-del-fix]
  ```

Cambios de código:

- `packages/catalog/src/index.ts`: `ScenarioSkillMap` y `ScenarioContext` suman
  `initiative_type`; `resolveSkillIds` lo agrega a sus dimensiones.
- `scenarioForStory` (`story-component.ts`) y el armado del escenario en
  `get-role-prompt.ts` lo toman de `flow.initiative_type`. El developer llega a la skill
  por dos caminos: `claim_story`, que pasa por `scenarioForStory` con `developer.implement`,
  y `get_role_prompt` con `flow_id`, que arma el escenario a partir del flow. (No por
  `get_implementation_context`: ese llama a `getRolePrompt('qa', 'qa', …)` — el bundle de
  QA, no el del developer.)

### 5. Textos que se actualizan

- `templates/change-note-template.md`: `repro: <comando que falla hoy>` en el frontmatter,
  con un comentario que diga que la alternativa es `no_repro: <por qué>`, y una línea en
  "Cómo lo sé" que remita al campo. El placeholder `<...>` es lo que el validador rechaza si
  nadie lo completa.
- `roles/developer/phases/change-note.md`: el paso 2 (frontmatter) suma la declaración y el
  puntero a la skill.
- Bump de cada entrada tocada, en `catalog.yaml` y en su frontmatter; catálogo **0.12.0**;
  resellado.

## Manejo de errores

Todo rechazo sale como hoy: `submit_change_note` devuelve `{ ok: false, data: { validation } }`
con la lista de issues, sin escribir nada. Los mensajes nombran la salida ejecutable:

- Sin declaración: *"La nota tiene que declarar en su frontmatter `repro: <comando que
  reproduce el problema>` o, si no lo pudiste reproducir, `no_repro: <por qué>`. Las dos
  son válidas; lo que no vale es no decir nada."*
- Relleno: *"`no_repro` es un placeholder ("n/a"). Escribí por qué no se pudo reproducir:
  de dónde viene el reporte y qué lo impide."*

## Testing

| Seam | Caso |
|---|---|
| `validateChangeNote` | Sin declaración, las dos, no string, relleno, `<...>`, > 500 → error; `repro` y `no_repro` válidos → `ok` con `repro` parseado |
| `validateChangeNote` | El error de `repro` se acumula con los de secciones y repo |
| `submit_change_note` | El evento `change_note.submitted` lleva `repro`; una nota inválida no escribe evento ni avanza el flow |
| `Catalog.getRolePrompt` | `developer.implement` con `initiative_type: fix` o `improvement` adjunta la skill; con `feature`, no; `developer.change-note` la trae siempre |
| `claim_story` | El bundle de un flow `fix` incluye la skill (el camino real por el que llega al developer) |

Los cruces existentes cubren la skill nueva sin tocarlos: `Catalog.load` exige su
`description`, e `id` y `version` coherentes, y `catalog-tool-calls.test.ts` revisa
cualquier llamada que narre.

**Los fixtures que hoy mandan una nota válida sin `repro`** se actualizan: dejan de ser
válidos, y es el cambio. Son **dos** archivos (`submit-change-note`, `track-liviano-e2e`)
más la copia de `change-note-validation`. Los otros cinco mandan `'x'.repeat(60)`, que ya
se rechazaba, o no validan. Las tres copias quedaron en `test/helpers/change-note.ts`.

## Riesgos

**La ceremonia**, que es el riesgo del análisis y sigue siendo el más serio. Se acota con
tres decisiones ya tomadas: es un campo y no una sección, `no_repro` es una salida
legítima, y la medición está definida de antemano.

**Rompe a los agentes con el prompt viejo.** Un agente que sigue la versión anterior de la
fase manda una nota sin `repro` y recibe un error. El mensaje nombra la salida, y el prompt
y el template se actualizan en el mismo diff, así que dura lo que tarde el cliente en pedir
el prompt de nuevo.

## Cómo se sabría si sirvió

La señal del análisis, ahora medible:

```sql
select payload->'repro'->>'kind' as kind, count(*)
from flow_events where type = 'change_note.submitted'
group by 1;
```

- **Si domina `no_repro`**, el dato es interesante por sí solo y la conclusión probable es
  **sacar el campo**, no endurecerlo.
- **Si domina `repro`**, la pregunta siguiente es si esos comandos aparecen después como
  `test_command` en `qa.results.submitted` del mismo flow.

Conviene mirarlo con una muestra que valga la pena, no con las primeras cinco notas.
