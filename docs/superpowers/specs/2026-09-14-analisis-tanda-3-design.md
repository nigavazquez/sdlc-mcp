# Análisis contra mattpocock/skills — tanda 3 — Design

**Fecha:** 2026-09-14
**Estado:** los cuatro candidatos están implementados (ver sus secciones).

## Qué es este documento

El repo viene ejecutando una comparación contra [mattpocock/skills](https://github.com/mattpocock/skills)
que ya produjo dos tandas mergeadas (PRs #22, #23 y #24). **El documento original de ese
análisis nunca se commiteó**, así que esto lo reconstruye desde lo único que quedó: los
commits, el código y el catálogo. Reconstruirlo tiene un costo —se pierden los candidatos
que en su momento se evaluaron y se descartaron sin dejar rastro— y por eso la sección de
descartes de acá es tan larga como la de propuestas: la próxima tanda va a leer este
archivo, no la conversación.

### El material de referencia, y qué se pudo leer

El repo de referencia se leyó por HTTP: el árbol completo vía la API (52 skills en
`skills/engineering`, `skills/productivity`, `skills/misc` y `skills/in-progress`, más
`docs/` con una página por skill) y el contenido de las que importan para el SDLC:
`writing-for-agents` y su `SKILL-MECHANICS.md`, `grilling`, `tdd`, `code-review`,
`domain-modeling`, `codebase-design`, `diagnosing-bugs` y el `AGENT-BRIEF.md` de `triage`.

Una honestidad sobre el método: el fetcher devuelve **resúmenes**, no el texto literal. Las
reglas están; el fraseo exacto de cada skill, no. Para lo que se propone acá —adoptar o
descartar mecanismos— alcanza, pero cualquier frase que este documento atribuya a ese repo
hay que tratarla como paráfrasis.

## Dónde quedaron las tandas 1 y 2

Cuatro de los siete ítems están enteros. Tres quedaron a medias, y las medias son de dónde
sale la mitad de la tanda 3.

**Enteras:**

- **`required_sections` cruzado contra el validador** (`required_sections-catalogo.test.ts`).
  El catálogo y `PRD_RULES` / `RFC_RULES` / `CHANGE_NOTE_RULES` son dos copias de la misma
  lista, y ahora hay un test que las obliga a coincidir. Además el test se cubre a sí mismo:
  `toda fase con validador está en la tabla` impide que un validador nuevo entre sin cruzar.
- **El hook que bloquea git sin vuelta atrás** (`.claude/hooks/block-dangerous-git.sh`).
  Sobrevivió al contacto con la realidad: se bloqueó a sí mismo dos veces y el arreglo
  —inspeccionar sólo los segmentos que *son* un comando git— está escrito en el propio
  archivo. Un guardarraíl con falsos positivos se desactiva en una semana; éste ya pagó ese
  aprendizaje.
- **`lint:boundaries`** con las cuatro reglas que `ARCHITECTURE.md` ya declaraba y que sólo
  sostenía el review. Corre en CI (`.github/workflows/ci.yml`) antes que el typecheck.
- **El piso de los criterios de aceptación y el review en dos ejes.** Los dos con la frontera
  bien puesta: el server rechaza lo mecánico (un criterio vacío o en `TBD`; un `approved`
  sobre un eje que bloquea) y el juicio vive en `skill-story-shaping` y
  `skill-review-dos-ejes`. El eje de estándares con su piso de doce smells es, de hecho, una
  adopción más completa que el original: el nuestro además dice qué **no** reportar —lo que
  ya enforcea el tooling— que es la parte que hace que un review deje de ser ruido.

**A medias:**

- **Las negaciones.** El commit 83cb757 dice "se aprovecha para sacar las negaciones", y
  tocó exactamente un archivo: `prd-discovery.md`. Hoy 9 de las 31 entradas del catálogo
  siguen cerrando con un bloque "Anti-patrones", y eso es correcto según la guía que las
  gobierna, porque `docs/PROMPT_AUTHORING.md` **nunca se actualizó**: sigue diciendo
  "Anti-patrones explícitos. Listá lo que el agente NO debe hacer". El archivo no cambia
  desde el import inicial del repo. O sea: la tanda 1 adoptó una regla en un archivo y dejó
  intacta la instrucción que le dice a todo el mundo que haga lo contrario.
- **El envelope de review.** El server quedó impecable
  (`submit-review-outcome.ts:21-30`: `{story_id, outcome, comment?, review}`), y el prompt
  de la fase que lo tiene que llamar quedó en la versión anterior. `review.md:42` sigue
  diciendo `submit_review_outcome({pr_url, decision, comments})` — tres argumentos y los
  tres con otro nombre, y sin rastro del `review` que ahora es obligatorio. El detalle está
  en el candidato 1.
- **El seam antes del primer test.** Entró donde tenía que entrar
  (`skill-implementation-checklist` y el paso 0 de CONTRIBUTING), pero `implement.md` —la
  fase que entrega esa skill— sigue narrando su paso 2 como "listá qué archivos vas a tocar
  y qué tests vas a agregar", sin nombrar el seam. Se apoya en que el agente lea la skill
  adjunta. Probablemente alcance; lo anoto porque es el tipo de cosa que después se cita
  como "ya está puesto".

## La frontera server/skill

Es la distinción central del repo y cada ítem de abajo tiene que declararla, así que vale
la pena dejarla escrita en una línea: **el server rechaza lo que se puede decidir sin leer
el contenido; la skill se ocupa de lo que hay que leer para decidir.**

`submit_qa_results` puede verificar que `test_exit_code` sea 0 y que la cobertura sea `N/N`
sin entender un solo criterio; decidir si "la sincronización anda bien" es un criterio o un
deseo requiere leerlo, y por eso está en `skill-story-shaping`. La regla práctica que sale
de las dos tandas anteriores: si para escribir el chequeo hay que escribir una heurística
sobre prosa, va en una skill. Un piso mecánico que intenta juzgar se vuelve o bien un test
que falla con falsos positivos, o bien uno que pasa siempre.

Hay un tercer lugar, menos obvio y que conviene nombrar: **la guía de autoría**
(`PROMPT_AUTHORING.md`, `CONTRIBUTING.md`). Ahí van las reglas que no tienen ni piso
mecánico ni destinatario agente, porque el destinatario es la persona que escribe la
próxima entrada del catálogo. El candidato 2 vive entero en ese tercer lugar.

## Los candidatos

### 1. Las llamadas a tools que el catálogo narra, cruzadas contra el registry

**El problema, con los números.** Los prompts de fase le dicen al agente qué tool llamar y
con qué argumentos. Hoy hay 19 de esas menciones en `packages/catalog/roles/`, y **5 están
mal**:

| Dónde | Dice | El schema real |
|---|---|---|
| `review.md:42` | `submit_review_outcome({pr_url, decision, comments})` | `{story_id, outcome, comment?, review}` |
| `review.md:21` | `request_code_review({pr_url, story_id})` | `{story_id, reviewer_ids, message?}` |
| `qa.md:22` | `submit_qa_results({story_id, results, verdict})` | `+ envelope` (obligatorio) |
| `qa.md:23` | idem | idem |
| `shaping.md:24` | `link_subtasks({story_id, subtasks})` | `{flow_id, story_id, subtasks}` |

Las dos peores son las dos que la tanda 2 acaba de construir. `review.md` manda un `pr_url`
que la tool no acepta, omite el `reviewer_ids` que es obligatorio, y no menciona el envelope
`sdlc.review/v1` —o sea, el prompt de la fase de review describe un review de un eje cuando
el server exige dos—. `qa.md` omite el envelope con `test_command` / `test_exit_code` /
`test_output_hash`, que es la gate de entrega que el track liviano se cuidó de no aflojar.
Y `link_subtasks` estaba mal **desde antes** de las dos tandas, lo que demuestra que esto no
es "la tanda 2 se olvidó": es que nada mira.

El costo de que estén mal no es un error de tipeo. Un agente que sigue el prompt llama mal,
recibe un error de zod, y a partir de ahí improvisa: prueba nombres, o peor, decide que la
tool no anda y sigue sin firmar. La fase entera queda entregando instrucciones falsas sobre
la única gate que esa fase tiene.

`review.md:38-41` tiene además un tercer valor de decisión, `rejected`, que el enum
(`'approved' | 'changes_requested'`) no contempla.

**Dónde va el enforcement: server, mecánico, sin discusión.** Es exactamente la forma de
`required_sections-catalogo.test.ts` de la tanda 1 —dos copias de la misma verdad que se
despegan en silencio— y se resuelve igual: un test que extrae las menciones con la forma
`` `nombre({a, b})` `` del markdown del catálogo y las cruza contra
`buildToolRegistry(...)`, comparando el nombre de la tool y los nombres de los argumentos
contra las claves del `inputSchema`. Nombre inexistente, argumento inexistente o argumento
requerido ausente: rojo.

**La segunda mitad, que es la positiva.** Parar la mentira no alcanza; conviene que la
verdad tenga dónde vivir. El server ya tiene el campo: `next_actions`, que emiten 23 de las
25 tools y que `get_role_prompt` calcula con un `nextActionsFor` (`get-role-prompt.ts:57-66`)
que cubre **2 de las 10 fases** y devuelve `[]` para las otras ocho, shaping, implement, qa,
review y change-note incluidas. Esas ocho sólo tienen la prosa. La propuesta es declarar la
secuencia en el frontmatter de la fase —al lado de `required_sections`, que ya demostró que
ese lugar funciona— y que `nextActionsFor` la lea de ahí en vez de tener la tabla horneada.
El mismo cruce del párrafo anterior la valida gratis.

Conviene extender el cruce también a los cinco literales con forma de llamada que las tools
emiten hoy dentro de `next_actions` (`sync-backlog.ts:101` emite
`'get_role_prompt({role:"developer", phase:"implement", flow_id})'`, una firma dentro de un
string). Los cinco están bien hoy; no hay nada que los mantenga así.

**Qué cuesta.** Un parser de ~30 líneas, un test, la corrección de las 5 menciones, el campo
nuevo en el frontmatter de 10 fases y un bump del catálogo. Churn bajo y acotado: ningún
contrato cambia, ninguna migración, ningún comportamiento de runtime distinto salvo que
`next_actions` deja de estar vacío en ocho fases.

**El riesgo.** Que el parser sea frágil con el markdown: una mención dentro de un bloque de
código, una firma partida en dos líneas. Se acota eligiendo una forma canónica estrecha
(backticks, una línea, `nombre({args})`) y aceptando que lo que no matchee no se revisa —un
falso negativo es tolerable, un falso positivo hace que alguien desactive el test.

**Implementado** (`apps/server/test/catalog-tool-calls.test.ts`, catálogo 0.10.0). Lo que
apareció al hacerlo y no estaba en el análisis:

- El cruce contra el schema solo no veía las dos menciones de `qa.md`: `envelope` es
  `optional()` en zod porque lo exige el handler. El test lleva una tabla corta,
  `REQUIRED_BY_HANDLER`, para esos casos.
- `review.md` estaba más roto que sus firmas: le decía al **reviewer** que llamara a
  `request_code_review`, que exige rol `qa` o `tech-lead` y devuelve `{story, flow}`, no el
  bundle que el prompt prometía. Ahora QA pide el review al pasar (`qa.md`, paso 8) y el
  reviewer arma su contexto con `get_implementation_context` + `get_role_prompt`. También
  decía `request_changes` donde el enum es `changes_requested`.
- `next_actions` quedó declarado en las 10 fases. Las dos que ya tenían tabla conservan su
  lista exacta.

### 2. `PROMPT_AUTHORING.md` al día con lo que la tanda 1 adoptó

**El problema.** La guía de autoría del catálogo dice hoy, textual: *"Anti-patrones
explícitos. Listá lo que el agente NO debe hacer (ej. 'no producir decisiones
técnicas')"*. Es la instrucción opuesta a la que la tanda 1 importó de `writing-for-agents`
y aplicó en `prd-discovery.md`: nombrar la conducta buena en vez de prohibir la mala, porque
prohibirla la mete igual en el contexto. Mientras esa línea siga ahí, cada entrada nueva del
catálogo va a nacer con su bloque de anti-patrones y la tanda 1 se deshace sola.

Y hay más de una línea desactualizada en ese archivo. La sección "Workflow de cambios"
describe un proceso —fork, PR al repo del catálogo, review del COE, release de
`@sdlc/catalog@<version>`, bump en `apps/server/package.json`— que no es el proceso real de
este repo: el catálogo es un workspace del monorepo, se testea con `catalog.smoke.test.ts` y
la versión se bumpea a mano contra un pin en ese mismo test. Un agente que lea la guía para
saber cómo contribuir al catálogo recibe un procedimiento que no existe.

`writing-for-agents` trae además tres cosas que esa guía podría absorber y hoy no tiene: el
**criterio de completitud** por paso (cuándo un paso está hecho, que es lo que evita la
terminación prematura), el **puntero de contexto** como forma de nombrar material que no
está cargado, y el **test del no-op** —borrar una frase y preguntarse si cambia la conducta
del agente; si no, se borra entera en vez de recortarla—. Las tres se pueden escribir en
media página cada una y valen más que las tres reglas genéricas que hoy ocupan ese lugar.

**Dónde va el enforcement: en ningún lado, y eso es la decisión.** Esto es la guía de
autoría, el tercer lugar. Un lint que prohíba la palabra "no" en el catálogo sería
exactamente la regla que `.dependency-cruiser.cjs` se prohíbe a sí mismo: "sólo las que el
repo ya decidió y puede explicar; un linter que impone criterios que nadie discutió se
termina desactivando". El único enforcement razonable es que alguien lo lea en el review de
un PR del catálogo.

**Qué cuesta.** Reescribir un archivo de 60 líneas, y después una pasada sobre las 9
entradas que tienen bloque de anti-patrones. La pasada se puede diferir: la guía corregida
vale por sí sola aunque el catálogo tarde en seguirla, porque frena la reincidencia.

**El riesgo.** Que la pasada sobre las 9 entradas se convierta en una reescritura del
catálogo entero y en un diff imposible de revisar. Se acota haciéndola entrada por entrada,
con su bump de versión, y aceptando que algunas se queden como están: un "anti-patrón" que
nombra una conducta concreta y frecuente —`--no-verify`, "LGTM sin leer el diff"— es más
barato de dejar que de reformular.

**Implementado: la guía.** `PROMPT_AUTHORING.md` reescrita: la regla de anti-patrones
reemplazada por "nombrá la conducta buena" (con la excepción de las conductas con nombre
propio), las tres piezas de `writing-for-agents` (criterio de completitud, puntero de
contexto, test del no-op), una sección sobre qué hace una buena `description` —que el
candidato 3 necesitaba—, la tabla de frontmatter y el workflow real (bump, `seal`, suite).
**La pasada sobre las 9 entradas con bloque de anti-patrones queda diferida**, como se
propuso: entrada por entrada y con su bump.

### 3. El frontmatter del catálogo no lo valida nadie

**El problema.** `Catalog.load` valida `catalog.yaml` con zod, con cuidado
(`packages/catalog/src/index.ts:9-60`). El frontmatter de los markdown, no: `readDoc`
devuelve `parsed.data` y todo el mundo lo tira salvo `getRequiredSections`. Lo que se
acumuló en ese punto ciego:

- **9 de las 15 skills no tienen `description`.** Las que la tienen la tienen porque sí, no
  porque nadie la lea: no la lee nadie. `getRolePrompt` devuelve `{id, version, markdown}`
  y la descripción se queda en el archivo.
- **Conviven dos convenciones de `id`.** `skills.qa-plan` en unas, `skill-terraform-implementation`
  en otras, y en las seis del primer grupo el `id` del frontmatter **no coincide** con la
  clave del catálogo que las indexa (`skills.code-review-checklist` contra
  `skill-code-review-checklist`). Nada rompe porque nada compara.
- **La `version` está en dos lugares** —el frontmatter y `catalog.yaml`— y pueden divergir
  sin que nada lo note. Es el mismo patrón exacto que la tanda 1 cerró para
  `required_sections`, todavía abierto un nivel más abajo.

En `writing-for-agents` la descripción es *el puntero de contexto de primer nivel* de una
skill: lo que hace que se la invoque o no. Acá el reparto de skills lo hace el server por
fase y por escenario, así que la descripción no gobierna la invocación — pero sigue siendo
lo que le dice al agente por qué le adjuntaron cinco documentos y en qué orden leerlos,
sobre todo en `developer.implement`, donde `scenario_skills` puede mergear cuatro además de
la base.

**Dónde va el enforcement: partido, y ahí está el interés del ítem.** El piso es mecánico y
va en el loader: que cada documento tenga frontmatter, que su `id` sea exactamente la clave
que lo indexa, que su `version` coincida con la de `catalog.yaml` y que `description` exista
y no esté vacía. Son cuatro comparaciones de strings, no hay heurística sobre prosa, y
falla al `load` —o sea en los 21 tests que cargan el catálogo, sin test nuevo—. **Qué dice
una descripción** es juicio y va en `PROMPT_AUTHORING.md`, que es el ítem 2: una descripción
que repite el título no hace ningún trabajo, y eso no lo puede medir una comparación de
strings.

**Qué cuesta.** El schema en el loader (~20 líneas), la corrección de 15 archivos —9
descripciones nuevas y 6 `id` renombrados— y un bump. Churn medio y todo en un solo commit
mecánico. El único riesgo real es el orden: si el schema entra antes que las correcciones,
`Catalog.load` tira y la suite entera se pone roja. Va al revés.

**Implementado** (`Catalog.load`, `test/catalog-frontmatter.test.ts`, catálogo 0.11.0): 9
descripciones nuevas, 6 `id` alineados con su clave, en ese orden y antes del schema. Dos
cosas que el análisis no decía:

- **Los templates quedan afuera.** `getTemplate` devuelve el archivo crudo, así que un
  frontmatter se filtraría al artefacto que el agente completa.
- **Un catálogo propio vía `CATALOG_ROOT` con frontmatter inconsistente deja de cargar.** Es
  más estricto que el sello (que sólo loguea), y es a propósito: el error enumera cada
  problema con su archivo.

### 4. El bucle de reproducción antes del fix

**El problema.** La nota de cambio del track liviano pide "Cómo lo sé" y el validador exige
de esa sección `minContentLines: 1` (`validation/change-note.ts:26-30`). El template invita
explícitamente a que la respuesta sea "reportado por X, no reproducido", y **eso está bien**:
es información honesta y cambia cómo se verifica. Lo que falta es lo de al lado. Del otro
extremo del mismo flow, `submit_qa_results` exige un `test_command`, un `test_exit_code` en
0 y un `test_output_hash`: la entrega tiene que demostrarse con un comando que alguien
corrió. El diagnóstico, no.

`diagnosing-bugs` pone ese mismo piso del lado de adelante, y es su única regla dura: antes
de hipotetizar, construir una señal roja reproducible que capture *este* bug —"no
red-capable command, no Phase 2"—. Las cinco fases que siguen (minimizar, hipotetizar 3-5
causas falsables antes de sondear, instrumentar cambiando una variable por vez, arreglar con
el test de regresión escrito primero en el seam correcto, limpiar) son la parte de juicio.

En este repo eso se nota porque el track liviano —el que existe para los `fix`— es
justamente el que no pide el repro. Un fix que entra sin comando rojo llega a QA con un plan
generado a partir de criterios que nadie pudo verificar que fallaran antes.

**Dónde va el enforcement: piso en el server, bucle en una skill.** El piso: para
`initiative_type ∈ {fix, improvement}`, el frontmatter de la nota declara `repro: <comando>`
o `no_repro: <por qué>`. Las dos son respuestas legítimas y la segunda es la que hace que
esto no sea una traba —lo que deja de ser legítimo es el silencio—. El mismo rechazo
mecánico que ya aplica a los criterios de aceptación (vacío, `TBD`, `n/a`) aplica acá, y por
la misma razón: sin eso el campo se satisface con `no_repro: n/a` y se vuelve una
formalidad. El juicio —si el comando es *tight* y determinista, si el repro reproduce el
síntoma del usuario y no uno vecino, si la razón del `no_repro` es real— va en una skill
nueva, adjunta a las fases `change-note` e `implement`.

**Qué cuesta.** Una regla más en el validador de la nota, una skill nueva, dos entradas en
`catalog.yaml` y un bump. Sin migración: es frontmatter, no una columna. Churn bajo en
código, medio en contenido.

**El riesgo, y es el más serio de los cuatro.** Que sea ceremonia. La nota de cambio existe
porque el track completo pedía documentos que obligaban a inventar, y agregarle campos es
empujarla de vuelta para allá — el propio spec del track liviano lo dice: "si en seis meses
el validador de la nota tiene ocho secciones, el track dejó de existir". La diferencia es
que esto no agrega una **sección** sino un campo de frontmatter con dos valores posibles, y
que uno de los dos es "no lo reproduje". Si aun así aparece que la mayoría de las notas
declaran `no_repro`, el dato es interesante por sí solo y la conclusión probable es sacar el
campo, no endurecerlo.

**Implementado** (catálogo 0.12.0; diseño en `2026-09-28-repro-antes-del-fix-design.md`),
aplicado a `fix` **y** `improvement` (en un improvement, `repro` es la línea base). La
declaración viaja en el payload de `change_note.submitted`, así que la señal de § "Cómo se
sabría" es una consulta sobre `flow_events`.

### El orden, y por qué

1. **Las llamadas a tools** (candidato 1). Es lo único de la lista que hoy está
   activamente roto: dos fases entregan instrucciones falsas sobre sus propias gates. Y es
   el más barato de los cuatro.
2. **`PROMPT_AUTHORING.md`** (candidato 2). Casi gratis, y hasta que no entre, cada PR del
   catálogo puede reintroducir lo que la tanda 1 sacó. Antes que el 3 porque el 3 necesita
   que la guía diga qué es una buena descripción.
3. **El frontmatter del catálogo** (candidato 3). Cierra un punto ciego estructural con un
   commit mecánico.
4. **El bucle de reproducción** (candidato 4). El de mayor riesgo de ceremonia y el que más
   conviene discutir antes de escribir. Puede quedar afuera de la tanda sin costo.

## Lo que se descarta, y por qué

Vale tanto como lo de arriba: sin esto, la tanda 4 vuelve a evaluar lo mismo.

**Un `CONTEXT.md` con el glosario del dominio** (de `domain-modeling`). Es el descarte más
difícil, porque el problema existe: `flow.project` **es** el `workspace_id` y la columna
quedó con el otro nombre; `qa_passed` es un status de story y no de flow, y hace falta un
recuadro de advertencia en `ARCHITECTURE.md` para que nadie lo lea mal; `tribu`/`squad` son
labels y no el modelo, y ya hay un test (`tools-vocabulary.test.ts`) que existe sólo para
que ninguna descripción de tool diga "squad". Se descarta igual porque ese vocabulario **ya
tiene casa**: está en `ARCHITECTURE.md`, en prosa, con la explicación de por qué cada
nombre quedó donde quedó. Un `CONTEXT.md` sería el cuarto lugar donde vive la misma verdad
—después de la columna, el test y la arquitectura— y la sedimentación es justamente lo que
`writing-for-agents` manda borrar. Se reconsidera el día que el glosario tenga dientes:
una lista de términos prohibidos con su reemplazo, leída por una versión generalizada de
`tools-vocabulary.test.ts`. Ese día es un candidato fuerte; hoy sería documentación.

**Divulgación progresiva de las skills y un tool `get_skill`.** `Catalog.getSkill` existe y
**no lo llama nadie**: `getRolePrompt` inlinea el markdown completo de cada skill resuelta.
Suena a la falla exacta que `writing-for-agents` describe, y no lo es por una cuestión de
tamaño: el catálogo entero son 1020 líneas y el bundle más gordo posible
(`developer.implement` con `hybrid` + `existing` + `infra`) son ~215 entre rol, fase y cinco
skills. El viaje de ida y vuelta para traer una skill cuesta más que las 150 líneas que
ahorraría, y el cliente MCP tendría que saber pedirla. El método ya está escrito para el día
que el catálogo pese; forzarlo ahora es complejidad sin contraparte.

**`design-it-twice` y el vocabulario de módulos profundos** (de `codebase-design`). La
plantilla del RFC ya ocupa ese lugar con `Alternatives considered: al menos 2, con razón
concreta de descarte`, que es la misma idea con menos maquinaria. Y sumar "profundidad de
módulo" y "ubicación del seam" al piso del eje de estándares sería agregar criterios que en
este repo nadie discutió, que es la regla que `.dependency-cruiser.cjs` se escribió a sí
mismo. El seam ya entró donde se puede defender: como el límite contra el que se testea.

**`improve-codebase-architecture` / `wayfinder`.** La mitad enforceable ya entró en la tanda
1: `lint:boundaries` con las cuatro reglas que el repo puede explicar. Lo que queda de esas
skills es un reporte de deuda arquitectónica, y un reporte que nadie se comprometió a
atender es peor que no tenerlo.

**`handoff` / `wait-what`.** El handoff entre sesiones de este repo ya es un artefacto
persistido y no una narración: `flow_events` lleva el audit trail, `get_flow_state` y
`get_implementation_context` arman el bundle con el que la sesión siguiente arranca, y el
`doc_folder_path` ancla dónde quedaron los documentos. Es una adopción más fuerte que la del
original, porque no depende de que alguien se acuerde de escribir el handoff.

**`setup-pre-commit`.** CI ya corre las cuatro cosas (`lint:boundaries`, typecheck, build,
test) en cada PR. Un pre-commit que corra el pipeline de turbo entero tarda lo suficiente
como para que alguien use `--no-verify`, que es literalmente uno de los antipatrones que
`skill-implementation-checklist` ya nombra. La gate está donde no se puede saltear.

**`to-spec`, `to-tickets`, `triage`, `prototype`, `teach`, `wizard`, `to-questionnaire`.**
Son las piezas de un pipeline que este repo **es**: el PRD, el RFC, el shaping, las stories.
Adoptarlas sería importar una segunda espina dorsal que compite con la propia. Lo único que
vale la pena robarles ya se robó: la forma de las preguntas (`skill-grilling`) y la forma de
un criterio (durable, conductual, verificable — que salió del `AGENT-BRIEF`).

**Los campos "Key interfaces" y "Out of scope" por story** (del `AGENT-BRIEF`). Son el
antídoto contra el gold-plating y hoy la story no los tiene: es título, descripción y
criterios. Se descarta por ahora porque el alcance ya está acotado por tres lados —los
`non_goals` del RFC a nivel épica, el límite de 1-3 días y 2-5 criterios de
`skill-story-shaping`, y el "no tocás scope fuera de la historia" del rol— y porque agregar
un campo a `StoryInput` es una migración y un cambio de contrato de adapters para algo que
en la mayoría de las filas va a quedar vacío. Si aparece evidencia de PRs que se pasan de
alcance, vuelve a la mesa con esa evidencia.

**La mecánica de invocación de skills** (`disable-model-invocation`, skills router, tipos de
invocación, de `SKILL-MECHANICS.md`). No tiene contraparte acá y probablemente nunca la
tenga: en este repo las skills no las descubre el modelo, las reparte el server por fase y
por escenario (`scenario_skills` en `catalog.yaml`). Toda esa maquinaria resuelve un
problema —qué skill se carga y cuándo— que acá resuelve el `get_role_prompt`. Vale dejarlo
anotado para que la tanda 4 no lo vuelva a mirar.

## Cómo se sabría si esto sirvió

Los cuatro candidatos tienen una señal barata, y conviene fijarla antes de implementarlos
para no juzgarlos después por la sensación:

- **1:** el cruce arranca rojo con 5 menciones y queda verde. La señal a seis meses es que
  haya vuelto a ponerse rojo **en un PR** —o sea, que atajó una— y no en `main`.
- **2:** que la próxima entrada del catálogo nazca sin bloque de anti-patrones sin que nadie
  lo pida en el review.
- **3:** el loader falla si alguien agrega una skill sin descripción. Es binario.
- **4:** la proporción de notas con `repro` contra `no_repro`. Si `no_repro` domina, el
  campo se saca; si domina `repro`, la pregunta siguiente es si esos comandos aparecen
  después como `test_command` en el envelope de QA, que es donde el bucle se cerraría de
  verdad.

Y una advertencia sobre el conjunto: tres de los cuatro candidatos son cruces de consistencia
—la tanda 1 hizo uno, la tanda 3 propone tres más—. Es un patrón que funciona y por eso es
tentador, pero cada cruce es una tabla más que hay que mantener. El día que agregar una
fase al catálogo requiera tocar cinco tablas de cruce, el remedio se volvió la enfermedad.
Cuatro cruces todavía no es eso; ocho sí.
