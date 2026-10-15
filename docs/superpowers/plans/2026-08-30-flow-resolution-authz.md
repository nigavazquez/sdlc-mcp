# Resolución y autorización de flows en un solo lugar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Estado: ejecutado el 2026-08-30** — PR [#16](https://github.com/nigavazquez/sdlc-mcp/pull/16), mergeado en `05214d9`.
> Siete tasks en nueve commits: `9523a3a` · `b75e474` · `3a01793` · `2ea3478` · `7923ea4` · `71abdac` ·
> `60773e0` · `c12cf55` · `9e36107`.
> Verificación final (re-corrida el 2026-08-31): `npx turbo run typecheck test build --force` → 11/11
> tasks, 776 passed | 26 skipped | 0 failed, con `flow-access.test.ts` en 21 tests y
> `tools-resource-access.test.ts` en 26. Los greps de invariante dan lo esperado: `store.getFlow(` /
> `store.getStory(` sólo en `flow-access.ts` y en el chequeo de slug duplicado de `start-flow.ts`, y no
> queda ningún `Unknown flow: ${input.flow_id}` ni `Unknown story` fuera del helper.
>
> El diseño del spec quedó intacto y las 24 tools migradas son exactamente las dos listas de las Tasks
> 4 y 5. Cuatro cosas se hicieron distinto de lo que está escrito más abajo:
>
> 1. **Nueve commits, no siete.** Los dos que no salen del plan son `2ea3478` (punto 2) y `9e36107`,
>    que cierra los cuatro hallazgos del review de la rama con las siete tasks ya hechas.
> 2. **El backstop del lado story no estaba pedido.** La Task 2 step 1 tiene el test del backstop de
>    `resolveFlowForCtx` (un flow cuyo `project` contradice al id), pero la Task 3 no pide el
>    equivalente para `resolveStoryForCtx`, que es lo único que prueba que la línea
>    `resolveFlowForCtx(store, ctx, story.flow_id)` hace falta y no es adorno. Se agregó al ejecutar,
>    en `2ea3478`, y de ahí sale el test 21 contra los "+20" que anuncia la Task 7 step 1.
> 3. **Ese test, como se escribió primero, no ejercitaba el backstop.** La story apuntaba a un
>    workspace del que el ctx no era miembro, así que el gate temprano cortaba antes y `getFlow` medía
>    0 llamadas: verde por el camino equivocado. `9e36107` lo arregla —ctx miembro del workspace de la
>    story y flow devuelto que contradice el `project`, `getFlow` de 0 a 1 llamada medida— y reescribe
>    el comentario para que describa lo que el test prueba.
> 4. **La Task 7 step 3 agrega el bloque nuevo pero no toca el párrafo vecino, que estaba mal.** El
>    bullet de autorización por workspace decía "sin claim (tests/fakes) no bloquea", falso desde la
>    tanda 2: `assertWorkspaceAccess` falla cerrado salvo `SDLC_ALLOW_UNSCOPED_CTX=true`. Corregido en
>    `9e36107`, junto con el renombre de los 24 `it()` de la tabla —decían más de lo que cubren, porque
>    el store de `makeRegistry` está vacío y por lo tanto sólo ejercitan el lado inexistente— y con el
>    límite de `POR_FLOW_ID` frente al segundo campo (`story_id`) de `link_subtasks` dejado por escrito
>    en el test.

**Goal:** Que resolver-y-autorizar un flow (o una story y su flow) sea una sola llamada en las 24 tools que hoy repiten la secuencia a mano, y que el orden de esa secuencia cierre el oráculo de existencia.

**Architecture:** Un módulo nuevo `mcp/tools/flow-access.ts` con `resolveFlowForCtx` y `resolveStoryForCtx`. El orden interno es el diseño: se saca el `workspace_id` del propio id —`flow_id` es `tenant:project:slug` y `project` **es** el `workspace_id`— y se chequea tenant + membresía **antes** de leer el store, así que un no-miembro recibe la misma respuesta exista o no el recurso. Después se lee, después se responde "no existe", y al final `assertFlowAccess` contra el record cargado como backstop.

**Tech Stack:** TypeScript ESM, zod, vitest, pnpm workspaces + turbo.

**Spec:** `docs/superpowers/specs/2026-08-28-flow-resolution-authz-design.md`

## Global Constraints

- TDD estricto: test primero, verlo fallar, mínimo código para pasar, commit. Un commit por task.
- Los imports internos llevan extensión `.js` (ESM), incluso apuntando a archivos `.ts`.
- Los tests se corren con `pnpm --filter @sdlc/server test <patrón>`.
- **Los strings de error no cambian.** `'Flow belongs to a different tenant'` sigue en inglés y `` `Unknown flow: ${id}` `` / `` `Unknown story: ${id}` `` conservan su forma exacta. Lo que cambia es *cuál de los dos sale* en los dos casos del oráculo.
- Las guardas corren **antes de cualquier side-effect**. En estas 24 tools el helper reemplaza código que ya estaba arriba de todo: no moverlo hacia abajo.
- El helper **no** reemplaza `assertRole` ni `assertFlowNotAborted`. Resuelve y autoriza el acceso; las guardas de rol y de terminal siguen donde están, después.
- Español en comentarios y mensajes nuevos, siguiendo el código existente.
- No tocar `start_flow`, `whoami` ni `list_roles`: no resuelven un recurso existente.

---

### Task 1: El parser de ids

**Files:**
- Create: `apps/server/src/mcp/tools/flow-access.ts`
- Test: `apps/server/test/flow-access.test.ts`

**Interfaces:**
- Consumes: `TenantCtx` de `@sdlc/adapters-contracts`.
- Produces: `workspaceFromResourceId(ctx: TenantCtx, id: string): ResourceIdParse`, donde `ResourceIdParse` es `{ kind: 'ok'; workspaceId: string } | { kind: 'other-tenant' } | { kind: 'unaddressable' }`. La Task 2 la consume.

- [x] **Step 1: Escribir el test (falla)**

Crear `apps/server/test/flow-access.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { workspaceFromResourceId } from '../src/mcp/tools/flow-access.js';
import { testCtx } from './helpers/tenant-ctx.js';

const ctx = testCtx({ tenantId: 't1', workspaces: ['platform'] });

describe('workspaceFromResourceId', () => {
  it('flow_id del tenant propio: devuelve el segmento del workspace', () => {
    expect(workspaceFromResourceId(ctx, 't1:platform:checkout')).toEqual({
      kind: 'ok',
      workspaceId: 'platform',
    });
  });

  it('story_id: el workspace sale igual, el sufijo :: es ruido', () => {
    expect(workspaceFromResourceId(ctx, 't1:platform:checkout::AB-123')).toEqual({
      kind: 'ok',
      workspaceId: 'platform',
    });
  });

  it('otro tenant: no se intenta adivinar el workspace', () => {
    expect(workspaceFromResourceId(ctx, 'otro:platform:checkout')).toEqual({
      kind: 'other-tenant',
    });
  });

  it('id sin separador: no direccionable, no "otro tenant"', () => {
    // Un typo no es un id ajeno. Decirle "otro tenant" a quien se equivocó tipeando
    // lo manda a investigar en la dirección equivocada.
    expect(workspaceFromResourceId(ctx, 'abc')).toEqual({ kind: 'unaddressable' });
  });

  it('prefijo correcto pero sin workspace: no direccionable', () => {
    expect(workspaceFromResourceId(ctx, 't1:')).toEqual({ kind: 'unaddressable' });
  });

  it('un tenantId con ":" adentro no rompe el parseo', () => {
    // El caso que rompe un split(':')[1] ingenuo: `tenantId` viene de TENANT_ID como
    // z.string().default('default'), SIN restricción de charset. Del otro lado el
    // parseo sí es seguro: workspace_id está validado ^[a-z0-9_-]+$ en la ruta admin
    // y slugify sólo produce [a-z0-9-], así que ninguno puede contener ":".
    const raro = testCtx({ tenantId: 'a:b', workspaces: ['platform'] });
    expect(workspaceFromResourceId(raro, 'a:b:platform:checkout')).toEqual({
      kind: 'ok',
      workspaceId: 'platform',
    });
  });

  it('un tenant que es prefijo de otro no se confunde', () => {
    // "t1" no debe matchear "t10:...": el separador es parte del prefijo.
    expect(workspaceFromResourceId(ctx, 't10:platform:checkout')).toEqual({
      kind: 'other-tenant',
    });
  });
});
```

- [x] **Step 2: Correr y ver fallar**

Run: `pnpm --filter @sdlc/server test flow-access`
Expected: FAIL — `Failed to load url ../src/mcp/tools/flow-access.js`.

- [x] **Step 3: Implementar el parser**

Crear `apps/server/src/mcp/tools/flow-access.ts`:

```typescript
import type { TenantCtx } from '@sdlc/adapters-contracts';

/**
 * Resultado de leer el workspace de un id de recurso.
 *
 * Los tres casos se distinguen porque el caller responde distinto a cada uno, y la
 * diferencia entre los dos de error es deliberada: un id ajeno se nombra como tal,
 * un id que no tiene forma de id es un typo y se responde "no existe".
 */
export type ResourceIdParse =
  | { kind: 'ok'; workspaceId: string }
  | { kind: 'other-tenant' }
  | { kind: 'unaddressable' };

/**
 * Saca el `workspace_id` de un `flow_id` (`tenant:project:slug`) o de un `story_id`
 * (`flow_id::external_id`), **sin tocar el store**. `flow.project` *es* el
 * `workspace_id`, así que el id ya dice a qué workspace pertenece el recurso.
 *
 * No es un `split(':')[1]`: se saca el prefijo `${ctx.tenantId}:`, que es un valor
 * conocido, y recién ahí se lee hasta el próximo `:`. `tenantId` sale de `TENANT_ID`
 * como `z.string().default('default')`, sin restricción de charset, así que un
 * `TENANT_ID=a:b` haría que un split ingenuo devolviera el segmento equivocado.
 */
export function workspaceFromResourceId(ctx: TenantCtx, id: string): ResourceIdParse {
  const prefix = `${ctx.tenantId}:`;
  if (!id.startsWith(prefix)) {
    // Con separador y otro prefijo tiene forma de id de otro tenant; sin separador
    // no es direccionable y lo tratamos como inexistente.
    return id.includes(':') ? { kind: 'other-tenant' } : { kind: 'unaddressable' };
  }
  const rest = id.slice(prefix.length);
  const end = rest.indexOf(':');
  const workspaceId = end === -1 ? rest : rest.slice(0, end);
  if (!workspaceId) return { kind: 'unaddressable' };
  return { kind: 'ok', workspaceId };
}
```

- [x] **Step 4: Correr y ver pasar**

Run: `pnpm --filter @sdlc/server test flow-access`
Expected: PASS (7 tests).

- [x] **Step 5: Commit**

```bash
git add apps/server/src/mcp/tools/flow-access.ts apps/server/test/flow-access.test.ts
git commit -m "feat(authz): parser del workspace a partir del id del recurso"
```

---

### Task 2: `resolveFlowForCtx`

**Files:**
- Modify: `apps/server/src/mcp/tools/flow-access.ts`
- Test: `apps/server/test/flow-access.test.ts`

**Interfaces:**
- Consumes: `workspaceFromResourceId` (Task 1); `assertWorkspaceAccess(ctx, workspaceId, label?): string | null` y `assertFlowAccess(ctx, flow): string | null` de `./workspace-access.js`; `FlowStore.getFlow(flowId): Promise<Flow | undefined>`.
- Produces: `resolveFlowForCtx(store: FlowStore, ctx: TenantCtx, flowId: string): Promise<FlowResolution>`, con `FlowResolution = { ok: true; flow: Flow } | { ok: false; error: string }`. Lo consumen la Task 4 y la Task 3.

- [x] **Step 1: Escribir el test (falla)**

Agregar al final de `apps/server/test/flow-access.test.ts`. Importar arriba lo que falta:

```typescript
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { resolveFlowForCtx } from '../src/mcp/tools/flow-access.js';
import type { FlowStore } from '../src/state/index.js';
```

y agregar:

```typescript
async function seedFlow(store: InMemoryFlowStore, project = 'platform') {
  return store.createFlow({
    tenant_id: 't1',
    project,
    slug: 'checkout',
    title: 'Checkout',
  });
}

/**
 * Store que explota al leer. Es lo que prueba que el gate temprano corre ANTES del
 * `getFlow`: si alguien mueve el chequeo de membresía debajo de la lectura, estos
 * tests fallan con el mensaje de abajo en vez de con el de la guarda.
 *
 * El mensaje no tiene ni una palabra del vocabulario del dominio a propósito: si
 * dijera "workspace" o "acceso", una aserción escrita como /workspace/i pasaría por
 * el motivo equivocado.
 */
const explodingStore = {
  getFlow: async () => { throw new Error('PROBE_SHOULD_NOT_READ'); },
  getStory: async () => { throw new Error('PROBE_SHOULD_NOT_READ'); },
} as unknown as FlowStore;

describe('resolveFlowForCtx', () => {
  it('camino feliz: devuelve el flow', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store);

    const res = await resolveFlowForCtx(store, ctx, flow.flow_id);

    expect(res.ok).toBe(true);
    expect(res.ok && res.flow.flow_id).toBe(flow.flow_id);
  });

  it('otro tenant: rechaza sin leer el store', async () => {
    const res = await resolveFlowForCtx(explodingStore, ctx, 'otro:platform:checkout');

    expect(res).toEqual({ ok: false, error: 'Flow belongs to a different tenant' });
  });

  it('id no direccionable: "no existe", sin leer el store', async () => {
    const res = await resolveFlowForCtx(explodingStore, ctx, 'abc');

    expect(res).toEqual({ ok: false, error: 'Unknown flow: abc' });
  });

  it('sin membresía en el workspace del id: rechaza sin leer el store', async () => {
    const res = await resolveFlowForCtx(explodingStore, ctx, 't1:ajeno:checkout');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain('No tenés acceso al workspace "ajeno"');
  });

  it('miembro, flow inexistente: "no existe"', async () => {
    const store = new InMemoryFlowStore();

    const res = await resolveFlowForCtx(store, ctx, 't1:platform:no-existe');

    expect(res).toEqual({ ok: false, error: 'Unknown flow: t1:platform:no-existe' });
  });

  it('EL PUNTO DEL CAMBIO: para un no-miembro, existir o no da la misma respuesta', async () => {
    // Es la aserción que le da sentido a todo el helper. Antes, un flow ajeno que
    // existía devolvía el error de acceso y uno inexistente devolvía "Unknown flow":
    // un bit por llamada, suficiente para mapear qué iniciativas tiene otro equipo
    // probando slugs.
    const store = new InMemoryFlowStore();
    await seedFlow(store, 'ajeno');

    const existe = await resolveFlowForCtx(store, ctx, 't1:ajeno:checkout');
    const noExiste = await resolveFlowForCtx(store, ctx, 't1:ajeno:no-existe');

    expect(existe.ok).toBe(false);
    expect(noExiste.ok).toBe(false);
    expect(existe.ok === false && existe.error).toBe(noExiste.ok === false && noExiste.error);
  });

  it('backstop: un flow cuyo project contradice al id se rechaza igual', async () => {
    // El parseo es una heurística sobre un string que manda el caller; la autoridad
    // es el record. Este caso no debería existir —`project` no está en
    // UpdateFlowInput, así que el segmento no puede driftear— pero si algún día el
    // flow_id deja de derivarse de (tenant, project, slug), el paso final es lo que
    // hace que falle cerrado en vez de autorizar mirando el lugar equivocado.
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, 'platform');
    const mentiroso = {
      ...store,
      getFlow: async () => ({ ...flow, project: 'ajeno' }),
    } as unknown as FlowStore;

    const res = await resolveFlowForCtx(mentiroso, ctx, 't1:platform:checkout');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain('No tenés acceso al workspace "ajeno"');
  });
});
```

- [x] **Step 2: Correr y ver fallar**

Run: `pnpm --filter @sdlc/server test flow-access`
Expected: FAIL — `resolveFlowForCtx is not a function`.

- [x] **Step 3: Implementar `resolveFlowForCtx`**

Agregar a `apps/server/src/mcp/tools/flow-access.ts` (y sumar los imports arriba):

```typescript
import type { Flow } from '@sdlc/core';
import type { FlowStore } from '../../state/index.js';
import { assertFlowAccess, assertWorkspaceAccess } from './workspace-access.js';

export type FlowResolution =
  | { ok: true; flow: Flow }
  | { ok: false; error: string };

/**
 * Resuelve un flow y autoriza el acceso, en ese orden y en un solo lugar.
 *
 * Los cuatro primeros pasos **no leen el store**, y eso es el diseño y no una
 * optimización: como el id nombra el workspace, se puede denegar antes de saber si el
 * recurso existe. Para un no-miembro la respuesta es entonces idéntica exista o no el
 * flow, que es lo que cierra el oráculo. Para un miembro el paso 5 sigue diciendo "no
 * existe": quien pasó el paso 4 podría ver ese flow si existiera, así que decírselo no
 * filtra nada y mantiene debuggeable un typo.
 *
 * Devuelve una unión discriminada, no `Flow | null` más un mensaje aparte, para que el
 * caller no pueda usar el flow sin haber mirado el `ok`.
 */
export async function resolveFlowForCtx(
  store: FlowStore,
  ctx: TenantCtx,
  flowId: string,
): Promise<FlowResolution> {
  const parsed = workspaceFromResourceId(ctx, flowId);
  if (parsed.kind === 'other-tenant') {
    return { ok: false, error: 'Flow belongs to a different tenant' };
  }
  if (parsed.kind === 'unaddressable') {
    return { ok: false, error: `Unknown flow: ${flowId}` };
  }

  const deniedByClaim = assertWorkspaceAccess(ctx, parsed.workspaceId);
  if (deniedByClaim) return { ok: false, error: deniedByClaim };

  const flow = await store.getFlow(flowId);
  if (!flow) return { ok: false, error: `Unknown flow: ${flowId}` };

  // Backstop contra el record cargado: el parseo es una heurística sobre un string
  // del caller, la autoridad es el record.
  const denied = assertFlowAccess(ctx, flow);
  if (denied) return { ok: false, error: denied };

  return { ok: true, flow };
}
```

- [x] **Step 4: Correr y ver pasar**

Run: `pnpm --filter @sdlc/server test flow-access`
Expected: PASS (14 tests).

- [x] **Step 5: Commit**

```bash
git add apps/server/src/mcp/tools/flow-access.ts apps/server/test/flow-access.test.ts
git commit -m "feat(authz): resolveFlowForCtx autoriza antes de leer el store"
```

---

### Task 3: `resolveStoryForCtx`

**Files:**
- Modify: `apps/server/src/mcp/tools/flow-access.ts`
- Test: `apps/server/test/flow-access.test.ts`

**Interfaces:**
- Consumes: `workspaceFromResourceId` (Task 1), `resolveFlowForCtx` (Task 2), `FlowStore.getStory(storyId): Promise<Story | undefined>`.
- Produces: `resolveStoryForCtx(store, ctx, storyId): Promise<StoryResolution>`, con `StoryResolution = { ok: true; story: Story; flow: Flow } | { ok: false; error: string }`. La consume la Task 5.

- [x] **Step 1: Escribir el test (falla)**

Agregar al final de `apps/server/test/flow-access.test.ts` (y sumar `resolveStoryForCtx` al import de `flow-access.js`):

```typescript
async function seedStory(store: InMemoryFlowStore, project = 'platform') {
  const flow = await seedFlow(store, project);
  const story = await store.createStory({
    flow_id: flow.flow_id,
    external_id: 'AB-1',
    external_url: 'https://dev.azure.com/acme/p/_workitems/edit/1',
    title: 'Implementar',
    acceptance_criteria: ['anda'],
  });
  return { flow, story };
}

describe('resolveStoryForCtx', () => {
  it('camino feliz: devuelve la story y su flow', async () => {
    const store = new InMemoryFlowStore();
    const { flow, story } = await seedStory(store);

    const res = await resolveStoryForCtx(store, ctx, story.story_id);

    expect(res.ok).toBe(true);
    expect(res.ok && res.story.story_id).toBe(story.story_id);
    // Devuelve las dos entidades porque los nueve callers usan las dos: la story para
    // su status y su assignee, el flow para el workspace y el status del flow.
    expect(res.ok && res.flow.flow_id).toBe(flow.flow_id);
  });

  it('sin membresía: rechaza sin leer el store', async () => {
    const res = await resolveStoryForCtx(explodingStore, ctx, 't1:ajeno:checkout::AB-1');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain('No tenés acceso al workspace "ajeno"');
  });

  it('el sustantivo es el del recurso pedido: "Unknown story", no "Unknown flow"', async () => {
    // Decir "Unknown flow" sobre un story_id manda a buscar el recurso equivocado.
    const store = new InMemoryFlowStore();

    const res = await resolveStoryForCtx(store, ctx, 't1:platform:checkout::NO-EXISTE');

    expect(res).toEqual({
      ok: false,
      error: 'Unknown story: t1:platform:checkout::NO-EXISTE',
    });
  });

  it('id de story no direccionable: "Unknown story"', async () => {
    const res = await resolveStoryForCtx(explodingStore, ctx, 'abc');

    expect(res).toEqual({ ok: false, error: 'Unknown story: abc' });
  });

  it('story huérfana: nombra el flow que falta', async () => {
    const store = new InMemoryFlowStore();
    const { story } = await seedStory(store);
    const huerfana = {
      ...store,
      getStory: async () => ({ ...story, flow_id: 't1:platform:borrado' }),
      getFlow: async () => undefined,
    } as unknown as FlowStore;

    const res = await resolveStoryForCtx(huerfana, ctx, story.story_id);

    expect(res).toEqual({ ok: false, error: 'Unknown flow: t1:platform:borrado' });
  });

  it('para un no-miembro, existir o no da la misma respuesta', async () => {
    const store = new InMemoryFlowStore();
    const { story } = await seedStory(store, 'ajeno');

    const existe = await resolveStoryForCtx(store, ctx, story.story_id);
    const noExiste = await resolveStoryForCtx(store, ctx, 't1:ajeno:checkout::NO-EXISTE');

    expect(existe.ok).toBe(false);
    expect(existe.ok === false && existe.error).toBe(noExiste.ok === false && noExiste.error);
  });
});
```

- [x] **Step 2: Correr y ver fallar**

Run: `pnpm --filter @sdlc/server test flow-access`
Expected: FAIL — `resolveStoryForCtx is not a function`.

- [x] **Step 3: Implementar `resolveStoryForCtx`**

Agregar a `apps/server/src/mcp/tools/flow-access.ts` (sumando `Story` al import de `@sdlc/core`):

```typescript
export type StoryResolution =
  | { ok: true; story: Story; flow: Flow }
  | { ok: false; error: string };

/**
 * Igual que `resolveFlowForCtx` pero entrando por `story_id`, que es
 * `flow_id::external_id` — así que el mismo parseo da el workspace y el gate temprano
 * corre idéntico, sin leer el store.
 *
 * Devuelve las dos entidades porque los nueve callers usan las dos.
 */
export async function resolveStoryForCtx(
  store: FlowStore,
  ctx: TenantCtx,
  storyId: string,
): Promise<StoryResolution> {
  const parsed = workspaceFromResourceId(ctx, storyId);
  if (parsed.kind === 'other-tenant') {
    return { ok: false, error: 'Flow belongs to a different tenant' };
  }
  if (parsed.kind === 'unaddressable') {
    // El sustantivo es el del recurso que pidió el caller: decir "Unknown flow" sobre
    // un story_id lo manda a buscar el recurso equivocado.
    return { ok: false, error: `Unknown story: ${storyId}` };
  }

  const deniedByClaim = assertWorkspaceAccess(ctx, parsed.workspaceId);
  if (deniedByClaim) return { ok: false, error: deniedByClaim };

  const story = await store.getStory(storyId);
  if (!story) return { ok: false, error: `Unknown story: ${storyId}` };

  // El flow se resuelve por el camino completo: vuelve a pasar por el gate y por el
  // backstop, que es lo que cubre una story cuyo flow_id apunta a otro workspace.
  const resolvedFlow = await resolveFlowForCtx(store, ctx, story.flow_id);
  if (!resolvedFlow.ok) return { ok: false, error: resolvedFlow.error };

  return { ok: true, story, flow: resolvedFlow.flow };
}
```

- [x] **Step 4: Correr y ver pasar**

Run: `pnpm --filter @sdlc/server test flow-access`
Expected: PASS (20 tests).

- [x] **Step 5: Commit**

```bash
git add apps/server/src/mcp/tools/flow-access.ts apps/server/test/flow-access.test.ts
git commit -m "feat(authz): resolveStoryForCtx resuelve story y flow con el mismo gate"
```

---

### Task 4: Migrar las 15 tools que entran por `flow_id`

**Files:**
- Modify (15): `apps/server/src/mcp/tools/` → `abort-flow.ts`, `create-epic.ts`, `create-stories.ts`, `generate-rfc-skeleton.ts`, `get-flow-state.ts`, `get-role-prompt.ts`, `link-subtasks.ts`, `propose-breakdown.ts`, `submit-adr.ts`, `submit-prd.ts`, `submit-rfc.ts`, `sync-backlog.ts`, `validate-prd.ts`, `validate-rfc.ts`, `verify-artifact.ts`
- Test: sin archivos nuevos; las suites existentes tienen que seguir verdes.

**Interfaces:**
- Consumes: `resolveFlowForCtx` (Task 2).
- Produces: nada nuevo. Deja las 15 tools sin la secuencia manual.

- [x] **Step 1: Correr la suite completa y anotar el baseline**

Run: `pnpm test`
Expected: PASS. Anotar la cuenta exacta (`N passed | M skipped`) — es contra lo que se compara al final de la task.

- [x] **Step 2: Migrar las 15, una por una**

En cada archivo, reemplazar el bloque:

```typescript
      const flow = await store.getFlow(input.flow_id);
      if (!flow) return { ok: false, error: `Unknown flow: ${input.flow_id}` };
      const denied = assertFlowAccess(ctx, flow);
      if (denied) return { ok: false, error: denied };
```

por:

```typescript
      const resolved = await resolveFlowForCtx(store, ctx, input.flow_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const flow = resolved.flow;
```

Cambiar el import de `assertFlowAccess` por `import { resolveFlowForCtx } from './flow-access.js';` **sólo si `assertFlowAccess` no se usa en otra parte del archivo** — si queda sin usar, `tsc` no se queja (no es `noUnusedLocals` por defecto), así que hay que mirarlo a ojo con un `grep assertFlowAccess <archivo>`.

Tres archivos no siguen el molde exacto y hay que leerlos antes de tocar:

- **`get-flow-state.ts`**: el `if (!flow)` está en dos líneas con llaves y el `assertFlowAccess` viene después de un comentario largo. El comentario explica *por qué* la guarda es completa y no sólo de tenant: conservarlo, adaptando la primera oración a que ahora la guarda vive en el helper.
- **`get-role-prompt.ts`**: el `flow_id` es **opcional** y la resolución está dentro de un `if (input.flow_id)`. Sólo se migra ese bloque; el camino sin `flow_id` devuelve catálogo del servidor y no cambia.
- **`abort-flow.ts`**: además del helper, el archivo exporta `assertFlowNotAborted` y `updateFlowUnlessAborted`, que otras tools importan. No tocar esas exportaciones.

En los archivos donde la variable ya se llama `flow` y se usa muchas veces, la tercera línea (`const flow = resolved.flow;`) evita tener que renombrar nada más abajo.

- [x] **Step 3: Correr la suite y el typecheck**

Run: `pnpm --filter @sdlc/server test`
Expected: PASS, con la misma cuenta del Step 1. Ningún test debería cambiar de resultado: los mensajes y sus triggers se conservan salvo los dos casos del oráculo, que ningún test cubre hoy.

Run: `pnpm --filter @sdlc/server typecheck`
Expected: PASS.

Si algún test falla, **no adaptar el test**: el helper tiene que producir el mismo mensaje que el código que reemplaza. Un fallo acá es un bug del helper o una tool cuyo bloque no era el estándar.

- [x] **Step 4: Verificar que no quedó ninguna**

Run: `grep -n 'Unknown flow: ${input.flow_id}' apps/server/src/mcp/tools/*.ts`
Expected: sin resultados.

- [x] **Step 5: Commit**

```bash
git add apps/server/src/mcp/tools
git commit -m "refactor(authz): las 15 tools que entran por flow_id usan el helper"
```

---

### Task 5: Migrar las 9 tools que entran por `story_id`

**Files:**
- Modify (9): `apps/server/src/mcp/tools/` → `block-story.ts`, `claim-story.ts`, `discard-story.ts`, `generate-qa-plan.ts`, `get-implementation-context.ts`, `report-progress.ts`, `request-code-review.ts`, `submit-qa-results.ts`, `submit-review-outcome.ts`
- Test: sin archivos nuevos; las suites existentes tienen que seguir verdes.

**Interfaces:**
- Consumes: `resolveStoryForCtx` (Task 3).
- Produces: nada nuevo.

- [x] **Step 1: Migrar las 9, una por una**

En cada archivo, reemplazar el bloque:

```typescript
      const story = await store.getStory(input.story_id);
      if (!story) return { ok: false, error: `Unknown story: ${input.story_id}` };

      const flow = await store.getFlow(story.flow_id);
      if (!flow) return { ok: false, error: `Unknown flow: ${story.flow_id}` };
      const denied = assertFlowAccess(ctx, flow);
      if (denied) return { ok: false, error: denied };
```

por:

```typescript
      const resolved = await resolveStoryForCtx(store, ctx, input.story_id);
      if (!resolved.ok) return { ok: false, error: resolved.error };
      const { story, flow } = resolved;
```

Importar `resolveStoryForCtx` desde `./flow-access.js` y sacar el import de `assertFlowAccess` si queda sin usar (`grep assertFlowAccess <archivo>`).

Ojo con el orden en dos archivos:

- **`get-implementation-context.ts`**: la guarda tiene que quedar **antes** del chequeo de `status === 'created'`. Si corriera después, el error de "not been claimed yet" confirmaría que la story existe — el mismo oráculo que este cambio cierra, por otra puerta. El helper ya está arriba de todo; sólo hay que no moverlo.
- **`submit-qa-results.ts` y `submit-review-outcome.ts`**: después de la resolución vienen `assertRole` y `assertNotSelfSignoff`. El helper **no** los reemplaza: siguen donde están, después.

- [x] **Step 2: Correr la suite y el typecheck**

Run: `pnpm --filter @sdlc/server test`
Expected: PASS, misma cuenta que el baseline de la Task 4.

Run: `pnpm --filter @sdlc/server typecheck`
Expected: PASS.

- [x] **Step 3: Verificar que no quedó ninguna**

Run: `grep -rn 'Unknown story' apps/server/src/mcp/tools/*.ts`
Expected: sin resultados (el único `Unknown story` que queda vive en `flow-access.ts`).

- [x] **Step 4: Commit**

```bash
git add apps/server/src/mcp/tools
git commit -m "refactor(authz): las 9 tools que entran por story_id usan el helper"
```

---

### Task 6: La tabla del registry

**Files:**
- Create: `apps/server/test/tools-resource-access.test.ts`

**Interfaces:**
- Consumes: `buildToolRegistry` de `../src/mcp/tools/index.js`; el registry expone `list()` con `{ name }` y `get(name)`.
- Produces: nada de código. Es el mecanismo que hace fallar la suite si una tool nueva no declara su forma de entrada.

- [x] **Step 1: Escribir el test (falla)**

Crear `apps/server/test/tools-resource-access.test.ts`. Sigue el patrón de la tabla de `abort-flow.test.ts:498`, que compara contra los nombres del registry:

```typescript
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { Catalog } from '@sdlc/catalog';
import { buildToolRegistry } from '../src/mcp/tools/index.js';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { ConfigBackedTaskSystemProvider } from '../src/adapters/task-system-provider.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';
import { testCtx } from './helpers/tenant-ctx.js';

// Mismo patrón que abort-flow.test.ts:45 — `resolve(__dirname, ...)`, no `new URL()`.
const CATALOG_ROOT = resolve(__dirname, '../../../packages/catalog');

/** Tools que resuelven un flow por `input.flow_id`. */
const POR_FLOW_ID = [
  'abort_flow', 'create_epic', 'create_stories', 'generate_rfc_skeleton',
  'get_flow_state', 'get_role_prompt', 'link_subtasks', 'propose_breakdown',
  'submit_adr', 'submit_prd', 'submit_rfc', 'sync_backlog',
  'validate_prd', 'validate_rfc', 'verify_artifact',
];

/** Tools que resuelven una story por `input.story_id` (y su flow). */
const POR_STORY_ID = [
  'block_story', 'claim_story', 'discard_story', 'generate_qa_plan',
  'get_implementation_context', 'report_progress', 'request_code_review',
  'submit_qa_results', 'submit_review_outcome',
];

/**
 * Las exentas, y por qué:
 *  - `whoami` y `list_roles` devuelven identidad y catálogo del servidor: no hay
 *    recurso que resolver ni workspace contra el cual chequear.
 *  - `start_flow` crea un flow nuevo. Filtra que un slug ya existe, pero su guarda de
 *    rol corre antes sobre `input.project`, así que sólo se entera de flows de un
 *    workspace donde ya tenés rol: no es un oráculo cruzado.
 */
const EXENTAS = ['whoami', 'list_roles', 'start_flow'];

function makeRegistry(catalog: Catalog) {
  return buildToolRegistry({
    catalog,
    store: new InMemoryFlowStore(),
    taskSystemProvider: new ConfigBackedTaskSystemProvider({
      configStore: new InMemoryIntegrationConfigStore(),
      inMemory: new InMemoryTaskSystemAdapter(),
    }),
  });
}

describe('toda tool del registry declara cómo resuelve su recurso', () => {
  it('cada tool está en una de las tres listas', async () => {
    // Esto es lo que hace que la tabla valga para las tools que se agreguen. El censo
    // NO se hace por substring sobre las fuentes: un `source.includes('resolveFlowForCtx(')`
    // pasa con el retorno ignorado, con la llamada comentada y con la llamada dentro de
    // un string — es la lección de la tanda 2, donde 8 de 12 evasiones pasaban el censo
    // por regex. Acá o la tool aparece en una lista y su caso corre de verdad contra un
    // recurso ajeno, o hay que declararla exenta, que es una afirmación que se lee y se
    // discute en el review.
    const catalog = await Catalog.load(CATALOG_ROOT);
    const registradas = makeRegistry(catalog).list().map((t) => t.name).sort();
    const cubiertas = [...POR_FLOW_ID, ...POR_STORY_ID, ...EXENTAS].sort();

    expect(registradas).toEqual(cubiertas);
  });

  it('las listas no declaran tools que no existen ni repiten', () => {
    // El otro lado: una entrada podrida (tool renombrada, typo) haría que el caso nunca
    // corriera y la cobertura fuera falsa.
    const todas = [...POR_FLOW_ID, ...POR_STORY_ID, ...EXENTAS];
    expect(new Set(todas).size).toBe(todas.length);
  });
});

describe('el recurso ajeno se rechaza igual exista o no', () => {
  // Un ctx que no es miembro de "ajeno". El claim va explícito: las guardas de
  // workspace no dejan pasar un ctx sin él.
  const ctx = testCtx({ tenantId: 'default', roles: ['tech-lead'], workspaces: ['propio'] });

  for (const name of POR_FLOW_ID) {
    it(`${name}: flow ajeno inexistente responde como uno ajeno existente`, async () => {
      const catalog = await Catalog.load(CATALOG_ROOT);
      const registry = makeRegistry(catalog);
      const tool = registry.get(name)!;

      const res = (await tool.handler(
        { flow_id: 'default:ajeno:no-existe' } as never,
        ctx,
      )) as { ok: boolean; error?: string };

      expect(res.ok).toBe(false);
      // No dice "Unknown": eso confirmaría que no existe, que es el bit que se cierra.
      expect(res.error).toContain('No tenés acceso al workspace "ajeno"');
    });
  }

  for (const name of POR_STORY_ID) {
    it(`${name}: story ajena inexistente responde como una ajena existente`, async () => {
      const catalog = await Catalog.load(CATALOG_ROOT);
      const registry = makeRegistry(catalog);
      const tool = registry.get(name)!;

      const res = (await tool.handler(
        { story_id: 'default:ajeno:flow::NO-EXISTE' } as never,
        ctx,
      )) as { ok: boolean; error?: string };

      expect(res.ok).toBe(false);
      expect(res.error).toContain('No tenés acceso al workspace "ajeno"');
    });
  }
});
```

Nota sobre los inputs: se pasa sólo `flow_id`/`story_id` con `as never` porque el handler recibe el input **ya parseado** por el borde MCP; la guarda de acceso corre antes de mirar cualquier otro campo. Si alguna tool tocara `input.<otro_campo>` antes de resolver, su test fallaría — y eso sería el hallazgo, no un problema del test.

- [x] **Step 2: Correr y ver fallar**

Run: `pnpm --filter @sdlc/server test tools-resource-access`
Expected: FAIL si alguna de las tres listas está desactualizada respecto del registry, o si alguna tool todavía filtra el bit. Si pasa en verde de una, verificar que el archivo se está corriendo (`--reporter verbose`) antes de darlo por bueno.

- [x] **Step 3: Ajustar lo que el test encuentre**

Si el primer test falla, el registry y las listas no coinciden: agregar la tool que falta a la lista que corresponda (o a `EXENTAS`, **con el motivo escrito**). Si falla uno de los casos por tool, esa tool no está usando el helper o lo llama después de otro chequeo: arreglar la tool, no el test.

- [x] **Step 4: Correr y ver pasar**

Run: `pnpm --filter @sdlc/server test tools-resource-access`
Expected: PASS (26 tests: 2 de la tabla + 15 + 9).

- [x] **Step 5: Commit**

```bash
git add apps/server/test/tools-resource-access.test.ts
git commit -m "test(authz): tabla del registry — toda tool declara cómo resuelve su recurso"
```

---

### Task 7: Verificación final y documentación

**Files:**
- Modify: `docs/ARCHITECTURE.md` (§ *Auth y modelo de workspaces*)

**Interfaces:**
- Consumes: todo lo anterior. No produce nada nuevo.

- [x] **Step 1: Verificación completa**

Run: `npx turbo run typecheck test build --force`
Expected: todo verde. La cuenta sube respecto del baseline de la Task 4: +20 de `flow-access` y +26 de `tools-resource-access`.

- [x] **Step 2: Confirmar que el helper es el único camino**

Run: `grep -rn 'store.getFlow(\|store.getStory(' apps/server/src/mcp/tools/*.ts`
Expected: sólo `flow-access.ts` (las dos lecturas del helper) y `start-flow.ts` (el chequeo de slug duplicado, que es la excepción declarada). Cualquier otro resultado es una tool que se salteó la migración.

- [x] **Step 3: Actualizar `ARCHITECTURE.md`**

En § *Auth y modelo de workspaces*, después de la descripción de las guardas existentes, agregar:

```markdown
**Resolución de recursos.** Las 24 tools que trabajan sobre un flow o una story no lo
resuelven a mano: llaman a `resolveFlowForCtx` / `resolveStoryForCtx`
(`mcp/tools/flow-access.ts`), que resuelven y autorizan en un solo lugar. El orden es
parte del contrato: como `flow_id` es `tenant:project:slug` y `project` *es* el
`workspace_id`, la membresía se chequea **antes** de leer el store, así que a un
no-miembro se le responde lo mismo exista o no el recurso. Un miembro sí ve "no
existe" — podría verlo si existiera, así que no se le oculta nada y un typo sigue
siendo debuggeable. El chequeo contra el record cargado se mantiene como backstop: el
parseo del id es una heurística sobre un string del caller, la autoridad es el record.
`tools-resource-access.test.ts` verifica contra el registry que toda tool declare cómo
resuelve su recurso.
```

- [x] **Step 4: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs(architecture): resolución y autorización de recursos en un solo lugar"
```

---

## Self-Review

**Cobertura del spec:**
- § 1 *El módulo* (`resolveFlowForCtx`, `resolveStoryForCtx`, unión discriminada, story devuelve las dos entidades) → Tasks 2 y 3. ✅
- § 2 *El orden* (los seis pasos, gate temprano sin leer, backstop) → Task 2 steps 1 y 3; el store que explota cubre el "sin leer". ✅
- § 3 *El parseo* (prefijo conocido y no `split`, los dos casos de `null`, el sustantivo lo elige el caller) → Task 1 + Task 3 step 1. ✅
- § 4 *Qué cambia en el comportamiento* (las dos filas del oráculo) → Task 2 step 1 (el test "EL PUNTO DEL CAMBIO") y Task 6 (por tool). ✅
- § 5 *El mecanismo estructural* (tabla contra el registry, por comportamiento) → Task 6. ✅
- § *Manejo de errores*: las ocho filas caen en Tasks 1, 2 y 3. La de `ctx.workspaces` ausente ya la cubre `assertWorkspaceAccess` y no se toca. ✅
- § *Testing*: las seis filas caen en Tasks 1, 2, 3, 6 y en el "sin cambios de resultado" de Tasks 4 y 5. ✅
- § *Riesgos*: el desalineado del parseo → test del backstop (Task 2); los 24 archivos → un commit por forma de entrada (Tasks 4 y 5); la tool nueva → Task 6; `get_role_prompt` opcional → Task 4 step 2. ✅

**Consistencia de tipos:** `ResourceIdParse` se define en Task 1 y se consume en Tasks 2 y 3 con los tres `kind` exactos. `FlowResolution` (Task 2) y `StoryResolution` (Task 3) usan `ok` como discriminante, igual que el `{ok, error}` que ya devuelven los handlers. `resolveStoryForCtx` llama a `resolveFlowForCtx` con la firma definida en Task 2. `assertWorkspaceAccess` y `assertFlowAccess` se usan con la firma que ya tienen en `workspace-access.ts`, sin cambios.

**Orden de ejecución:** 1 → 2 → 3 son estrictamente secuenciales (cada una usa la anterior). 4 y 5 dependen de 2 y 3 y son independientes entre sí, pero van en commits separados para poder bisectar 15 y 9 archivos por separado. 6 depende de 4 y 5 (antes fallaría por las tools sin migrar). 7 cierra.

**Riesgo principal:** las Tasks 4 y 5 tocan 24 archivos con un reemplazo casi mecánico, y "casi" es la palabra. Los cinco archivos que no siguen el molde están nombrados uno por uno con qué tienen de distinto (`get-flow-state`, `get-role-prompt`, `abort-flow`, `get-implementation-context`, y el par de QA/review). El criterio de aceptación es que **ningún test existente cambie de resultado**: si alguno falla, el helper no está produciendo el mensaje que producía el código que reemplazó.

**Trampa de verificación:** la suite puede quedar verde con el oráculo abierto, porque hoy **ningún test cubre las dos filas que cambian**. Por eso el test que importa no es que las 24 suites sigan pasando —eso sólo prueba que no se rompió nada— sino los dos casos explícitos de "existir o no da la misma respuesta" (Tasks 2 y 3) y los 24 casos por tool de la Task 6. Sin la Task 6, la Task 4 y la 5 son un refactor sin evidencia de haber cerrado nada.
