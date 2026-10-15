# Resolución y autorización de flows en un solo lugar — Design

**Fecha:** 2026-08-28
**Estado:** implementado el 2026-08-30 — PR [#16](https://github.com/nigavazquez/sdlc-mcp/pull/16), mergeado en `05214d9`. El diseño salió tal cual; las desviaciones de detalle están anotadas en el plan (`docs/superpowers/plans/2026-08-30-flow-resolution-authz.md`).

## Problema

Las 24 tools que resuelven un flow o una story repiten a mano la misma secuencia de
tres pasos:

```ts
const flow = await store.getFlow(input.flow_id);
if (!flow) return { ok: false, error: `Unknown flow: ${input.flow_id}` };
const denied = assertFlowAccess(ctx, flow);
if (denied) return { ok: false, error: denied };
```

Veinticuatro copias, con dos formas de entrada (15 por `flow_id`, 9 por `story_id` →
`story.flow_id`). Eso tiene dos costos, y el segundo es el que importa.

### 1. Un oráculo de existencia

La respuesta cambia según si el recurso existe, aun cuando el usuario no tenga acceso:

| Llamada con un `flow_id` de otro workspace | Respuesta de hoy |
|---|---|
| el flow existe | `No tenés acceso al workspace "otro"…` |
| el flow no existe | `Unknown flow: t1:otro:checkout` |

El dato del flow no se filtra —eso lo cerró la tanda 2— pero sí un bit por llamada:
existe o no existe. Probando slugs se mapea qué iniciativas tiene otro equipo sin
acceder a ninguna. El mismo split existe en el camino de `story_id` (`Unknown story`).

La tanda 2 lo dejó anotado como follow-up en lugar de taparlo en las seis tools de
lectura: con las otras dieciocho respondiendo igual, cerrarlo parcialmente daba falsa
sensación de cierre — el atacante llama a `submit_prd` con un body cualquiera y lee la
misma respuesta binaria.

### 2. La secuencia duplicada (el costo real)

Cuatro de los hallazgos de las tandas 1 y 2 fueron exactamente esto: una tool a la que
le faltaba uno de los tres pasos. Las seis tools de lectura que no llamaban ninguna
guarda de workspace, y las trece que mutaban sin guarda de rol, son el mismo error
repetido: la secuencia es convención, no estructura, así que cada tool nueva puede
olvidarse un paso y nada lo detecta.

## Objetivo

Que resolver-y-autorizar sea **una llamada**, que el orden de los pasos esté decidido
en un solo lugar, y que una tool nueva que se olvide de la guarda haga fallar la suite.
El cierre del oráculo sale de ahí como consecuencia del orden, no como un chequeo extra.

## No-goals

- **Uniformar el vocabulario de los mensajes.** `'Flow belongs to a different tenant'`
  sigue en inglés y `Unknown flow: <id>` igual. Hay tests que los matchean y cambiarlos
  es un cambio de superficie separado, sin relación con la deduplicación.
- **Tocar `start_flow`.** Filtra que un slug ya existe, pero su guarda de rol corre
  antes sobre `input.project`, así que sólo te enterás de flows de un workspace donde ya
  tenés rol. No es un oráculo cruzado.
- **Mover la guarda a la capa de dispatch.** Sería el único diseño que hace *imposible*
  olvidarse, pero cambia la forma de `ToolDef`, obliga a declarar la entrada por tool y
  tiene excepciones reales (`start_flow` no tiene flow; `get_role_prompt` lo tiene
  opcional). El test estructural da la misma propiedad mucho más barato.
- **Unificar la autorización de las tools que no resuelven nada** (`whoami`,
  `list_roles`, `start_flow`): no tienen recurso que resolver.

## Diseño

### 1. El módulo

`apps/server/src/mcp/tools/flow-access.ts`, al lado de `workspace-access.ts`, que sigue
siendo el que decide si un ctx tiene acceso a un workspace. El módulo nuevo no
reimplementa esa decisión: la ordena respecto de la lectura del store.

```ts
export type FlowResolution =
  | { ok: true; flow: Flow }
  | { ok: false; error: string };

export type StoryResolution =
  | { ok: true; story: Story; flow: Flow }
  | { ok: false; error: string };

export async function resolveFlowForCtx(
  store: FlowStore, ctx: TenantCtx, flowId: string,
): Promise<FlowResolution>;

export async function resolveStoryForCtx(
  store: FlowStore, ctx: TenantCtx, storyId: string,
): Promise<StoryResolution>;
```

Devuelven una unión discriminada y no `flow | null` más un mensaje aparte, para que el
caller no pueda usar el flow sin haber mirado el `ok`. En las tools queda:

```ts
const resolved = await resolveFlowForCtx(store, ctx, input.flow_id);
if (!resolved.ok) return { ok: false, error: resolved.error };
const flow = resolved.flow;
```

`resolveStoryForCtx` devuelve **las dos** entidades porque los nueve callers usan la
story y el flow: la story para su status y su assignee, el flow para el workspace y el
status del flow.

### 2. El orden, que es el diseño

`resolveFlowForCtx`:

1. **Sacar el workspace del id, sin tocar el store.** El `flow_id` es
   `tenant:project:slug` y `project` **es** el `workspace_id`.
2. **Si el prefijo del tenant no es el nuestro** → `'Flow belongs to a different tenant'`.
3. **Si no se puede extraer un workspace** → `Unknown flow: <id>`.
4. **Si el ctx no tiene membresía en ese workspace** → el mensaje de
   `assertWorkspaceAccess`. Acá se cierra el bit: se deniega sin haber leído nada.
5. **Leer el store.** No existe → `Unknown flow: <id>`.
6. **`assertFlowAccess(ctx, flow)` contra el record cargado.** Backstop, no la autoridad.

Los pasos 1-4 no leen el store, así que para un no-miembro la respuesta es idéntica
exista o no el flow. Para un miembro el paso 5 sigue diciendo "no existe", que es lo que
hace que un typo siga siendo debuggeable: quien pasa el paso 4 podría ver ese flow si
existiera, así que decírselo no filtra nada.

El paso 6 no es redundante. El parseo es una heurística sobre un string que manda el
caller; la autoridad es el record. Mientras la decisión se tome sobre el id y no sobre
lo leído, un día que el id deje de derivarse de `(tenant, project, slug)` la guarda pasa
a mirar el lugar equivocado. Con los dos, ese día falla cerrado.

`resolveStoryForCtx` es lo mismo con un paso más: `story_id` es `flow_id::external_id`,
así que el mismo parseo aplica; los pasos 1-4 corren igual, después `getStory` (no
existe → `Unknown story: <id>`), después `getFlow(story.flow_id)` (no existe →
`Unknown flow: <id>`) y el paso 6 sobre el flow.

### 3. El parseo

```ts
export function workspaceFromResourceId(ctx: TenantCtx, id: string): string | null;
```

No hace `split(':')[1]`. Saca el prefijo `${ctx.tenantId}:` —que es un valor conocido— y
recién ahí lee hasta el próximo `:`. La diferencia importa: `tenantId` es
`z.string().default('default')` desde `TENANT_ID`, **sin restricción de charset**, así
que un `TENANT_ID=a:b` haría que `split(':')[1]` devuelva `b` en vez del workspace. Del
otro lado el parseo sí es seguro: `workspace_id` está validado `^[a-z0-9_-]+$` en la
ruta admin y `slugify` sólo produce `[a-z0-9-]`, así que ninguno puede contener `:`.

Devuelve `null` en dos casos, que el caller distingue:

| Caso | Cómo se detecta | Respuesta |
|---|---|---|
| Otro tenant | no arranca con `${ctx.tenantId}:` y contiene `:` | `'Flow belongs to a different tenant'` |
| No direccionable | no arranca con el prefijo y no contiene `:` | `Unknown flow: <id>` / `Unknown story: <id>` |

El sustantivo lo elige el caller, no el parser: `resolveStoryForCtx` recibió un
`story_id` y decir `Unknown flow` sobre él mandaría a buscar el recurso equivocado. El
parser sólo distingue los dos casos y devuelve cuál es.

La regla del segundo caso es una convención declarada, no una verdad: un id basura
(`"abc"`) no es "otro tenant", y decírselo a alguien que se equivocó tipeando manda a
investigar en la dirección equivocada. Un id con forma de id ajeno sí se nombra como
tal.

### 4. Qué cambia en el comportamiento observable

Los strings no cambian; **cuál de los dos sale, sí**, y sólo en el caso que es el bug:

| Llamada | Hoy | Después |
|---|---|---|
| flow de otro workspace, existe | error de acceso | igual |
| flow de otro workspace, no existe | `Unknown flow` | **error de acceso** |
| id de otro tenant, existe | `different tenant` | igual |
| id de otro tenant, no existe | `Unknown flow` | **`different tenant`** |
| flow del workspace propio, no existe | `Unknown flow` | igual |

Las dos filas en negrita son el oráculo. Los tres tests que matchean
`'Flow belongs to a different tenant'` y el que matchea `Unknown flow` siguen verdes: sus
casos son los de las filas sin cambio.

### 5. El mecanismo estructural

Un test nuevo con una tabla de las 27 tools del registry y su forma de entrada
(`flow_id`, `story_id`, o ninguna), comparada contra los nombres que el registry
expone — el mismo patrón que la tabla de `abort-flow.test.ts` contra el registry.

- Una tool nueva sin caso en la tabla hace fallar la suite.
- Una tool declarada `flow_id` o `story_id` se ejercita contra un recurso ajeno y tiene
  que rechazar.
- Las tres exentas (`whoami`, `list_roles`, `start_flow`) se declaran exentas, con el
  motivo al lado.

El censo se hace **por comportamiento**, no por substring sobre las fuentes: un
`source.includes('resolveFlowForCtx(')` pasa con el retorno ignorado, con la llamada
comentada y con la llamada dentro de un string. Es la lección de la tanda 2, donde 8 de
12 evasiones pasaban el censo por regex.

## Manejo de errores

| Situación | Comportamiento |
|---|---|
| `flow_id` de otro tenant | `'Flow belongs to a different tenant'`, sin leer el store |
| `flow_id` no direccionable (sin `:`) | `Unknown flow: <id>`, sin leer el store |
| Sin membresía en el workspace del id | Mensaje de `assertWorkspaceAccess`, sin leer el store |
| Miembro, flow inexistente | `Unknown flow: <id>` |
| Miembro, story inexistente | `Unknown story: <id>` |
| Story existe, su flow no | `Unknown flow: <story.flow_id>` |
| El record cargado contradice al id | Backstop de `assertFlowAccess`; falla cerrado |
| `ctx.workspaces` ausente | Ya lo cubre `assertWorkspaceAccess` (fail-closed, con `SDLC_ALLOW_UNSCOPED_CTX` como escape para tests) |

## Testing

| Nivel | Qué cubre |
|---|---|
| `flow-access.test.ts` (nuevo) | Los seis pasos del orden, uno por uno: otro tenant, id no direccionable, no-miembro, miembro con flow inexistente, camino feliz, y el backstop con un flow cuyo `project` contradice al id |
| Oráculo cerrado | Para un no-miembro, la respuesta de un flow existente y de uno inexistente es **byte a byte la misma**. Es la aserción que da sentido al cambio |
| Sin lectura del store | Los pasos 1-4 se prueban con un store que explota al leer: si el gate temprano se mueve después del `getFlow`, el test falla |
| `workspaceFromResourceId` | `flow_id` y `story_id`; un `ctx.tenantId` que contiene `:` (el caso que rompe el `split`) |
| Tabla del registry | Las 27 tools declaradas; una tool nueva sin caso rompe la suite |
| Las 24 suites existentes | Sin cambios de resultado: los mensajes y sus triggers se conservan salvo las dos filas del oráculo, que ningún test cubre hoy |

## Riesgos

| Riesgo | Mitigación |
|---|---|
| El parseo del id se desalinea del record si algún día el `flow_id` deja de derivarse de `(tenant, project, slug)` | El paso 6 mira el record cargado, así que la autorización no depende del parseo. Un test siembra un flow cuyo `project` contradice al id y verifica que se rechace |
| 24 archivos tocados en un solo cambio | Un commit por grupo de entrada (`flow_id` / `story_id`), con la suite verde en cada uno; el helper y su test van primero y solos |
| Una tool nueva vuelve a escribir la secuencia a mano | La tabla del registry falla si no está declarada; el motivo de la exención se escribe al lado del caso |
| `get_role_prompt` tiene `flow_id` opcional | Su camino sin `flow_id` no resuelve nada y queda igual: devuelve catálogo del servidor. Sólo el camino con `flow_id` pasa por el helper |
