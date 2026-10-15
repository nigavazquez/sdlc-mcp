# Track liviano para fixes y mejoras chicas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Estado: ejecutado el 2026-09-02** — rama `feat/track-liviano`, diez tasks en once commits:
> `cf5cc61` · `cbee34c` · `c30bea0` · `5492946` · `e684402` · `24a8a1e` · `5ac20f3` · `9a63309` ·
> `a24ad0d` · `a651975` (más `1905bdb`, el spec y este plan).
> Verificación final: `npx turbo run typecheck test build --force` → 11/11 tasks,
> **850 passed | 26 skipped | 0 failed** (baseline antes de la rama: 776).
>
> El diseño del spec salió entero. Seis cosas se hicieron distinto de lo que está escrito más abajo:
>
> 1. **El test del track vive en la suite del server, no en `packages/core/test`.** `@sdlc/core` no
>    tiene runner ni script de test, y agregarle vitest por una función pura no se paga. Es la
>    salida que la Task 1 dejaba abierta ("o el archivo de tests de core que exista"), pero conviene
>    saber que ese archivo no existía.
> 2. **El extract de la Task 4 quedó más chico de lo que el plan sugería.** La validación de
>    componentes se quedó en `create_stories` en vez de moverse al helper: sus mensajes nombran
>    salidas ejecutables que sólo valen en el track completo —"el flow está en `rfc_ready`, así que
>    `submit_rfc` todavía lo acepta"— y arrastrarlas al liviano habría mandado al autor de una nota
>    de cambio a corregir un RFC que no existe. `submit_change_note` tiene su propia versión, más
>    corta. Al helper se fue sólo lo mecánico: crear, persistir, emitir el evento.
> 3. **Las tablas del registry que fallaron al agregar la tool fueron dos, no una.** El plan
>    anticipaba `tools-resource-access.test.ts`; también falló la tabla del terminal en
>    `abort-flow.test.ts`. Las dos son el mecanismo funcionando: una tool nueva no puede olvidarse ni
>    de declarar cómo resuelve su recurso ni de guardar el terminal. El caso de terminal se agregó
>    con el flow en `feature` a propósito, para que un flow abortado se rechace por abortado y no por
>    el track — si algún día se invirtiera ese orden, ese caso lo caza.
> 4. **La Task 6 tuvo una segunda mitad que el plan no pedía:** el mensaje de rechazo de `start_flow`
>    enumeraba los tres roles a mano. Con la lista dependiendo del track, ese texto habría mentido
>    para un `fix` — le habría dicho a un developer habilitado que pidiera ayuda. Ahora enumera lo
>    que la guarda realmente exige.
> 5. **La fase del catálogo quedó sólo bajo `developer`**, no bajo `developer` y `tech-lead` como
>    decía la Task 8. El markdown de fase declara su `role` en el frontmatter, así que ponerla en los
>    dos era duplicar el archivo para un caso que hoy nadie pidió. La tool sigue admitiendo
>    `tech-lead` y `pmo`: lo que no tienen es un prompt propio para esta fase.
> 6. **El end-to-end de la Task 10 es un test contra el registry, no contra el server HTTP en dev.**
>    `POST /mcp/tools/:name` exige un JWT emitido por el Authorization Server y lo que se prueba acá
>    es el flujo, no el login; el registry es exactamente lo que ese endpoint invoca después de
>    autenticar. Como test, además, sigue siendo cierto mañana.
>
> **Y una cosa del step 3 de la Task 10 que no se hizo acá:** `FlowStatus.qa_passed` quedó en el
> enum, y se sacó después en el issue #20.
>
> La razón que se dio para postergarlo era **falsa**: decía que dos tests lo usaban como semilla de
> un flow a mitad de camino. Esos usos (`abort-flow.test.ts`, `flow-status-race.test.ts`) son de
> **story**, no de flow — `seedStory` y `updateStory`—, y el grep que los encontró no distinguía las
> dos entidades, que es justo la confusión que originó el estado de más. Sacarlo del enum no rompió
> nada: typecheck limpio y la suite entera verde sin tocar un solo test.

**Goal:** Que un fix vaya de `start_flow` a `claim_story` en dos llamadas, con una nota de cambio de cuatro secciones en lugar de PRD + RFC, sin tocar las gates de entrega.

**Architecture:** El `initiative_type` que `start_flow` ya exige y nadie lee pasa a derivar un `FlowTrack` (`full | lite`). Una tool nueva, `submit_change_note`, hace en una llamada lo que en el track completo son seis, dejando el flow en `backlog_ready`. Las guardas de QA y review no se tocan.

**Tech Stack:** TypeScript ESM, zod, vitest, pnpm workspaces + turbo, drizzle + postgres-js.

**Spec:** `docs/superpowers/specs/2026-09-02-track-liviano-design.md`

## Global Constraints

- TDD estricto: test primero, verlo fallar por la razón correcta, mínimo código para pasar, commit. Un commit por task.
- Los imports internos llevan extensión `.js` (ESM), incluso apuntando a archivos `.ts`.
- Tests: `pnpm --filter @sdlc/server test <patrón>`; core: `pnpm --filter @sdlc/core test`.
- **Las guardas corren antes de cualquier side-effect**, y en el orden del spec § 3.
- **Ningún test existente cambia de resultado** salvo los que declaren lo contrario (task 6).
- Español en comentarios y mensajes nuevos.
- Una migración ya mergeada no se edita: la nueva es la `0012`.

---

### Task 1: El track, derivado en un solo lugar

**Files:**
- Modify: `packages/core/src/flow.ts`
- Test: `packages/core/test/track.test.ts` (o el archivo de tests de core que exista)

**Interfaces:**
- Produce: `FlowTrack = z.enum(['full','lite'])` y `trackForInitiative(t?: InitiativeType): FlowTrack`. Lo consumen las tasks 5, 6 y 7.

- [x] **Step 1: test (falla)** — tabla: cada valor de `InitiativeType` mapea al track esperado (`fix`/`improvement` → `lite`, `feature`/`refactor` → `full`), y `undefined → 'full'` como caso propio y nombrado.
- [x] **Step 2:** implementar con un `Record<InitiativeType, FlowTrack>` exhaustivo — que agregar un `initiative_type` nuevo sin decidir su track no compile.
- [x] **Step 3: commit** — `feat(track): el initiative_type deriva el track del flow`

---

### Task 2: El validador de la nota de cambio

**Files:**
- Create: `apps/server/src/validation/change-note.ts`
- Modify: `apps/server/src/validation/rfc-frontmatter.ts` (exportar el parseo de componentes / `repoIssue`)
- Test: `apps/server/test/change-note-validation.test.ts`

**Interfaces:**
- Consume: `validateMarkdownSections` y `SectionRule` de `validation/markdown-sections.ts`; el chequeo de repo de `rfc-frontmatter.ts` (**exportarlo, no duplicarlo** — `isComparableRepo` es la misma función que usa el gate de code review).
- Produce: `validateChangeNote(markdown): ValidationResult` y el parseo del frontmatter con los componentes.

- [x] **Step 1: test (falla)** — las cuatro secciones (`what`/`qué pasa`, `evidence`/`cómo lo sé`, `change`/`qué cambio`, `verification`/`cómo se verifica`) con alias en inglés y español como el resto de los validadores; falta de repo en el frontmatter = **error**; repo no comparable = error con el mensaje de `repoIssue`.
- [x] **Step 2:** implementar reusando los dos helpers.
- [x] **Step 3: commit** — `feat(validation): la nota de cambio valida sus cuatro secciones y su repo`

---

### Task 3: Persistencia de `change_note_ref`

**Files:**
- Create: `apps/server/migrations/0012_change_note_ref.sql`
- Modify: `packages/core/src/flow.ts`, `apps/server/src/state/schema.ts`, `state/store.ts`, `state/in-memory.ts`, `state/postgres.ts`
- Test: `apps/server/test/migration-0012.test.ts` (molde: `migration-0011.test.ts`)

- [x] **Step 1: test (falla)** — la columna existe, el round-trip del `ArtifactRef` sobrevive en los dos stores.
- [x] **Step 2:** `change_note_ref jsonb` en la tabla, `ArtifactRef.optional()` en el `Flow`, patch en los dos stores igual que `prd_ref`.
- [x] **Step 3: commit** — `feat(db): migración 0012 — change_note_ref en flows`

---

### Task 4: Extraer los núcleos de epic y stories

**Files:**
- Modify: `apps/server/src/mcp/tools/create-epic.ts`, `create-stories.ts`
- Create: el helper compartido (p. ej. `apps/server/src/mcp/tools/backlog-core.ts`)

**Interfaces:**
- Produce: la creación del epic (task system + `epic_external_id` + evento `epic.created`) y la de stories (resolución de componente, repo declarado, task system, `store.createStory`, eventos) como funciones que consumen las dos tools existentes y la nueva.

- [x] **Step 1:** mover el núcleo, sin cambiar comportamiento. Las guardas de rol y de status **se quedan en las tools**: el helper crea, no autoriza.
- [x] **Step 2:** correr `pnpm --filter @sdlc/server test create-epic create-stories shaping`. Criterio: misma cuenta, ningún test cambia de resultado. Si alguno falla, el extract se llevó algo que no era núcleo.
- [x] **Step 3: commit** — `refactor(shaping): el núcleo de epic y stories se puede reusar`

---

### Task 5: `submit_change_note`

**Files:**
- Create: `apps/server/src/mcp/tools/submit-change-note.ts`
- Modify: `apps/server/src/mcp/tools/index.ts` (registro)
- Test: `apps/server/test/submit-change-note.test.ts`

**Interfaces:**
- Consume: `resolveFlowForCtx`, `assertRole`, `assertFlowNotAborted`, `updateFlowUnlessAborted`, `trackForInitiative` (task 1), `validateChangeNote` (task 2), `resolveDocFolderPath`, los providers de doc store y task system, y los helpers de la task 4.

- [x] **Step 1: tests (fallan)** — uno por guarda y en orden: workspace ajeno, rol, flow abortado, track `full` (mensaje que apunta a `submit_prd`), status ≠ `draft`. Más: nota inválida no escribe **nada** (store espía: cero writes, cero publish); camino feliz → `backlog_ready` / fase `implementation` con `change_note_ref`, `components`, `epic_external_id` y la story creada; reintento con `epic_external_id` ya presente **no** crea un segundo epic.
- [x] **Step 2:** implementar en el orden del spec § 3. El publish es no-fatal y sigue el patrón de `submit-prd.ts` (sólo un publish real fija `doc_folder_path`).
- [x] **Step 3: commit** — `feat(track): submit_change_note lleva un fix de draft a backlog_ready`

---

### Task 6: Quién abre un fix

**Files:**
- Modify: `apps/server/src/mcp/tools/start-flow.ts`
- Test: `apps/server/test/start-flow-*.test.ts`

- [x] **Step 1: test (falla)** — un ctx sólo `developer` abre un flow `fix` y un `improvement`, y **es rechazado** en `feature` y `refactor` con el mensaje de roles de siempre.
- [x] **Step 2:** roles según el track: `['product-manager','tech-lead','pmo']` para `full`, más `developer` para `lite`. Actualizar el comentario que hoy explica los tres roles.
- [x] **Step 3: commit** — `feat(track): un developer puede abrir el flow de su propio fix`

---

### Task 7: La tabla del registry

**Files:**
- Test: `apps/server/test/tools-track.test.ts` (molde: `tools-resource-access.test.ts`)

- [x] **Step 1:** declarar la tabla `tool → tracks admitidos` y cruzarla contra `buildToolRegistry(...).list()`, con el mismo par de tests que la de autorización: que cubra todas las tools registradas, y que no declare tools inexistentes ni repita.
- [x] **Step 2:** el caso por tool: la de nota de cambio rechaza un flow `full`; las del track completo no cambian de comportamiento en un flow `lite` (la escalada tiene que seguir siendo posible).
- [x] **Step 3: commit** — `test(track): la tabla del registry declara qué tracks admite cada tool`

---

### Task 8: El catálogo

**Files:**
- Modify: `packages/core/src/roles.ts` (`PhaseId`), `packages/catalog/catalog.yaml`
- Create: la fase markdown bajo `developer` (y la entrada de `tech-lead`), `packages/catalog/templates/change-note-template.md`

- [x] **Step 1:** agregar `change-note` al `PhaseId`, la fase al catálogo con su template y el bump `0.5.0 → 0.6.0`.
- [x] **Step 2:** el prompt de la fase pide hechos, no proyecciones, y **no** menciona organizaciones ni equipos concretos (lo verifica `catalog.smoke.test.ts`).
- [x] **Step 3:** `get_role_prompt(developer, change-note)` devuelve el bundle. Test.
- [x] **Step 4: commit** — `feat(catalog): fase change-note con su template (0.6.0)`

---

### Task 9: `verify_artifact` acepta `change_note`

**Files:**
- Modify: `apps/server/src/mcp/tools/verify-artifact.ts`
- Test: `apps/server/test/verify-artifact.test.ts`

- [x] **Step 1: test (falla)** — `kind: 'change_note'` verifica contra `flow.change_note_ref.sha256`, con los mismos veredictos (incluida la tolerancia reportada de BOM / CRLF).
- [x] **Step 2:** agregar el kind. `adr` sigue rechazado por la misma razón de siempre: no persiste hash.
- [x] **Step 3: commit** — `feat(verify): verify_artifact cubre la nota de cambio`

---

### Task 10: Verificación final y documentación

**Files:**
- Modify: `docs/ARCHITECTURE.md`

- [x] **Step 1:** `npx turbo run typecheck test build --force`. Todo verde; anotar la cuenta.
- [x] **Step 2:** end-to-end in-memory: `start_flow(fix)` → `submit_change_note` → `claim_story`, más el control negativo (`submit_change_note` sobre un `feature`) y el de escalada (`submit_prd` sobre el flow `fix`).
- [x] **Step 3:** `ARCHITECTURE.md` § *Modelo del flujo*: la tabla de tracks y qué exige cada uno. Aprovechar para cerrar la discrepancia ya detectada: `FlowStatus.qa_passed` está en el enum y en la tabla de fases, y ninguna tool lo escribe — sacarlo o implementarlo, con la decisión escrita.
- [x] **Step 4: commit** — `docs(architecture): tracks del flow y qué exige cada uno`

---

## Self-Review

**Cobertura del spec:** § 1 (track derivado) → task 1. § 2 (nota de cambio, frontmatter con repo) → tasks 2 y 3. § 3 (una llamada, orden, idempotencia) → task 5. § 4 (escalada sí, degradación no) → tasks 5 y 7. § 5 (quién abre) → task 6. § 6 (catálogo) → task 8. Manejo de errores → tasks 2, 5 y 6. Testing → tasks 1, 2, 5, 7 y 10.

**Orden:** 1 → 2 → 3 son independientes entre sí pero las tres preceden a la 5. La 4 es refactor puro y también precede a la 5. La 6 y la 8 dependen de la 1. La 7 depende de la 5. La 10 cierra.

**Riesgo principal:** la task 5 concentra seis efectos en una tool, que es justo lo que el resto del repo evita. El contrapeso es que las guardas y el orden ya están estandarizados y que el núcleo de epic/stories viene extraído de la task 4: la tool nueva orquesta, no reimplementa. Si termina siendo más larga que `submit_qa_results`, es señal de que el epic no debería crearse acá.

**Trampa de verificación:** la suite puede quedar verde con el objetivo incumplido. Que `submit_change_note` funcione no prueba que el fix se haga en dos llamadas — lo prueba el end-to-end del step 2 de la task 10, y por eso está escrito como paso obligatorio y no como demo opcional.
