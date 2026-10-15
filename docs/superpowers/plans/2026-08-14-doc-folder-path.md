# Ruta de carpetas de documentos derivada del modelo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Estado: ejecutado el 2026-08-27** — PR [#14](https://github.com/nigavazquez/sdlc-mcp/pull/14), mergeado en `bb11fa6`.
> Seis commits, uno por task: `f40527b` · `726f9bc` · `45f01f1` · `c522911` · `76ed31e` · `0e4f71f`.
> Verificación final: `npx turbo run typecheck test build --force` → 11/11 tasks, 729 passed | 26 skipped | 0 failed.
>
> El plan se escribió el 2026-08-14 y se ejecutó después de las tandas 1 y 2, que tocaron los
> mismos archivos. El diseño del spec quedó intacto; seis detalles del plan no. Lo que se hizo
> distinto de lo que está escrito más abajo:
>
> 1. **La migración es la `0011`, no la `0010`.** La tanda 2 se llevó ese número
>    (`0010_qa_results.sql`, PR #13) y dos archivos con el mismo prefijo no tienen orden
>    definido. Aplica al nombre del `.sql` y al del test en toda la Task 3.
> 2. **Task 5 step 4:** `submit_prd` y `submit_rfc` ya no escriben con `store.updateFlow`. Pasan
>    por `updateFlowUnlessAborted` (el chokepoint de status de la tanda 2), así que la ruta viaja
>    en ese patch — `FlowStatusTransition extends UpdateFlowInput`. `submit_adr` sí usa
>    `updateFlow` directo, y como su publish es fatal no necesita el flag de `published`.
> 3. **Task 4 step 1:** el ctx literal con `roles: []` que propone el snippet ya no sirve.
>    `start_flow` exige rol y el claim `workspaces` es fail-closed desde la tanda 2: va por
>    `testCtx({roles:['product-manager'], workspaces:['p1']})`.
> 4. **Eran 4 archivos de test con `tribu`/`squad` en `createFlow`, no 3.** Falta
>    `verify-artifact.test.ts`, que es de la tanda 2 y por lo tanto posterior a este plan. Y en
>    el test del adapter de Drive (Task 1) el plan enumera 2 sitios: son 7, incluido el de
>    q-escaping, donde el payload de inyección pasa a ser un segmento de la ruta.
> 5. **El typecheck global no queda rojo desde la Task 1**, como dice el plan. Las tres tools
>    pasaban `tribu`/`squad` por spread condicional y TypeScript no aplica excess-property check
>    a los spreads: compilaba mientras mandaba un campo que el contrato ya no tenía y omitía el
>    que sí. El rojo real aparece en la Task 3 (`postgres.ts`) y cierra en la Task 5. El costo
>    en el medio es de runtime: entre la Task 1 y la Task 5 un publish real a Drive tira
>    `folder_path is required` — no-fatal, y los tests usan adapters falsos.
> 6. **Dos tests de la Task 4 pasan contra el código previo**, así que no manejan el cambio: el
>    patch in-memory se aplica por spread y `test/` está fuera del `include` del tsconfig, con
>    lo cual ni el runtime ni el compilador los frenaban. El que sí lo maneja se agregó al
>    ejecutar y no está más abajo: `start_flow` recibiendo `tribu`/`squad` como los mandaría un
>    cliente MCP viejo, asertando que no vuelven en la respuesta ni se persisten.

**Goal:** Que la ruta de publicación de PRD/RFC/ADR se derive del modelo (group + workspace) en vez de venir como texto libre `tribu`/`squad`, sin mover los documentos ya publicados.

**Architecture:** El contrato `DocPublishInput` cambia `tribu?`/`squad?` por `folder_path?: string[]`, así que el adapter solo une segmentos y no sabe nada del vocabulario de la organización. La derivación vive en la capa de tools (un helper que lee `AdminStore`), porque los adapters solo reciben `TenantCtx` y no tienen acceso a los stores. Una migración agrega `flows.doc_folder_path text[]`, backfilleada con la ruta histórica, para que los flows existentes sigan publicando donde ya están.

**Tech Stack:** TypeScript ESM, zod, drizzle-orm + postgres-js, vitest, pnpm workspaces + turbo.

**Spec:** `docs/superpowers/specs/2026-08-14-doc-folder-path-design.md`

## Global Constraints

- TDD estricto: test primero, verlo fallar, mínimo código para pasar, commit. Un commit por task.
- Node 20+, pnpm 9+. Los tests se corren con `pnpm --filter @sdlc/server test <patrón>`.
- Los imports internos llevan extensión `.js` (ESM), incluso apuntando a archivos `.ts`.
- Nada de vocabulario propio de una organización en `packages/*` ni en `packages/catalog`: hay un guard (`catalog.smoke.test.ts`) y otro de descripciones de tools (`tools-vocabulary.test.ts`).
- Una migración ya mergeada no se edita: siempre una nueva. La última es `0009_workspaces.sql`.
- El publish de documentos es **no-fatal** por diseño: si falla, se registra `publish_error`, `published: false` y el flow avanza igual. No cambiar eso.
- Español en comentarios y mensajes nuevos, siguiendo el código existente.

---

### Task 1: Contrato `folder_path` + adapter de Drive

**Files:**
- Modify: `packages/adapters-contracts/src/docs.ts` (campos `tribu`/`squad` de `DocPublishInput`)
- Modify: `apps/server/src/adapters/google-drive-docstore.ts:39-54` (validación + armado de segmentos)
- Test: `apps/server/test/google-drive-docstore.test.ts`

**Interfaces:**
- Consumes: nada de tasks anteriores.
- Produces: `DocPublishInput.folder_path?: string[]`. Las tasks 5 lo llenan; el adapter lo consume.

- [x] **Step 1: Actualizar los tests del adapter (fallan)**

En `apps/server/test/google-drive-docstore.test.ts`, en el test `publish prd: creates folder chain then upserts BOTH .md file and native Doc`, reemplazar las dos líneas `tribu: 'Tribu-A', squad: 'Squad-B',` del objeto pasado a `adapter.publish` por:

```typescript
      folder_path: ['Product', 'Platform'],
```

En el test `publish adr without adr_filename throws`, hacer el mismo reemplazo.

Reemplazar íntegro el test `publish without tribu throws` por estos dos:

```typescript
  it('publish sin folder_path tira antes de tocar la API', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.publish({ title: 'T', markdown: '# T', doc_kind: 'prd', flow_folder: 'f' }, ctx),
    ).rejects.toThrow('folder_path is required');
  });

  it('publish con folder_path vacío tira antes de tocar la API', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.publish(
        { title: 'T', markdown: '# T', doc_kind: 'prd', flow_folder: 'f', folder_path: [] },
        ctx,
      ),
    ).rejects.toThrow('folder_path is required');
  });
```

Y agregar este test nuevo, que es el que prueba que el adapter dejó de asumir dos niveles:

```typescript
  it('une los segmentos que recibe, sean uno o tres', async () => {
    const driveApi = google.drive({ version: 'v3', auth: {} as any });
    (driveApi.files.list as any).mockResolvedValue({ data: { files: [] } });
    let seq = 0;
    (driveApi.files.create as any).mockImplementation(async () => {
      seq++;
      return { data: { id: `created-${seq}`, webViewLink: `https://drive.google.com/file/${seq}` } };
    });
    const adapter = makeAdapter();
    (adapter as any).drive = driveApi;

    await adapter.publish({
      title: 'My PRD',
      markdown: '# PRD',
      doc_kind: 'prd',
      flow_folder: 'checkout',
      folder_path: ['Corp', 'Product', 'Platform'],
    }, ctx);

    // 3 segmentos + la carpeta del flow = 4 carpetas creadas, en ese orden.
    const folderNames = ((driveApi.files.create as any).mock.calls as any[])
      .filter((c) => c[0]?.requestBody?.mimeType === 'application/vnd.google-apps.folder')
      .map((c) => c[0].requestBody.name);
    expect(folderNames).toEqual(['Corp', 'Product', 'Platform', 'checkout']);
  });
```

- [x] **Step 2: Correr y ver fallar**

Run: `pnpm --filter @sdlc/server test google-drive-docstore.test`
Expected: FAIL. Los tests que pasan `folder_path` fallan con el error `tribu and squad are required...`, y los de error esperan `folder_path is required` pero reciben el mensaje viejo.

- [x] **Step 3: Cambiar el contrato**

En `packages/adapters-contracts/src/docs.ts`, dentro de `DocPublishInput`, reemplazar:

```typescript
  /** Required when kind='google-drive'. Top-level org unit folder name. */
  tribu?: string;
  /** Required when kind='google-drive'. Team folder name inside Tribu. */
  squad?: string;
```

por:

```typescript
  /**
   * Segmentos de carpeta, de la raíz hacia abajo. Requerido cuando kind='google-drive'.
   * El adapter los une tal cual: no asume una cantidad fija de niveles ni vocabulario
   * de organización. Quien llama lo deriva del modelo (ver src/docs/folder-path.ts).
   */
  folder_path?: string[];
```

- [x] **Step 4: Adaptar el adapter de Drive**

En `apps/server/src/adapters/google-drive-docstore.ts`, reemplazar el bloque de validación:

```typescript
    if (!input.tribu || !input.squad) {
      throw new Error(
        'tribu and squad are required when doc_store kind is google-drive',
      );
    }
```

por:

```typescript
    if (!input.folder_path || input.folder_path.length === 0) {
      throw new Error(
        'folder_path is required (non-empty) when doc_store kind is google-drive',
      );
    }
```

y el armado de segmentos:

```typescript
    const folderSegments =
      input.doc_kind === 'adr'
        ? [input.tribu, input.squad, input.flow_folder, 'adr']
        : [input.tribu, input.squad, input.flow_folder];
```

por:

```typescript
    const folderSegments =
      input.doc_kind === 'adr'
        ? [...input.folder_path, input.flow_folder, 'adr']
        : [...input.folder_path, input.flow_folder];
```

- [x] **Step 5: Correr y ver pasar**

Run: `pnpm --filter @sdlc/server test google-drive-docstore.test`
Expected: PASS.

El typecheck global todavía falla acá: las tres tools siguen pasando `tribu`/`squad`. Se arregla en la Task 5; es esperado.

- [x] **Step 6: Commit**

```bash
git add packages/adapters-contracts/src/docs.ts apps/server/src/adapters/google-drive-docstore.ts apps/server/test/google-drive-docstore.test.ts
git commit -m "feat(docs-contract): folder_path reemplaza tribu/squad en DocPublishInput"
```

---

### Task 2: Helper `resolveDocFolderPath`

**Files:**
- Create: `apps/server/src/docs/folder-path.ts`
- Test: `apps/server/test/folder-path.test.ts`

**Interfaces:**
- Consumes: `AdminStore` de `apps/server/src/admin/store.ts` — métodos `getWorkspace(id): Promise<WorkspaceRecord | undefined>` y `listGroups(): Promise<GroupRecord[]>`. `WorkspaceRecord = { workspace_id, name, group_id?, created_at }`, `GroupRecord = { group_id, name, created_at }`.
- Produces: `resolveDocFolderPath(opts: { adminStore: AdminStore; workspaceId: string }): Promise<string[]>`. La Task 5 lo usa en las tres tools.

- [x] **Step 1: Escribir el test (falla)**

Crear `apps/server/test/folder-path.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { InMemoryAdminStore } from '../src/admin/in-memory.js';
import { resolveDocFolderPath } from '../src/docs/folder-path.js';

describe('resolveDocFolderPath', () => {
  it('workspace con group: [nombre del group, nombre del workspace]', async () => {
    const adminStore = new InMemoryAdminStore();
    await adminStore.createGroup({ group_id: 'product', name: 'Product' });
    await adminStore.createWorkspace({
      workspace_id: 'platform',
      name: 'Platform',
      group_id: 'product',
    });

    const path = await resolveDocFolderPath({ adminStore, workspaceId: 'platform' });

    expect(path).toEqual(['Product', 'Platform']);
  });

  it('workspace sin group: solo el nombre del workspace', async () => {
    const adminStore = new InMemoryAdminStore();
    await adminStore.createWorkspace({ workspace_id: 'platform', name: 'Platform' });

    const path = await resolveDocFolderPath({ adminStore, workspaceId: 'platform' });

    expect(path).toEqual(['Platform']);
  });

  it('workspace inexistente: cae al id, para no romper el publish en dev/in-memory', async () => {
    const adminStore = new InMemoryAdminStore();

    const path = await resolveDocFolderPath({ adminStore, workspaceId: 'no-existe' });

    expect(path).toEqual(['no-existe']);
  });

  it('group_id que no resuelve a ningún group: usa solo el workspace', async () => {
    const adminStore = new InMemoryAdminStore();
    await adminStore.createWorkspace({
      workspace_id: 'platform',
      name: 'Platform',
      group_id: 'borrado',
    });

    const path = await resolveDocFolderPath({ adminStore, workspaceId: 'platform' });

    expect(path).toEqual(['Platform']);
  });
});
```

- [x] **Step 2: Correr y ver fallar**

Run: `pnpm --filter @sdlc/server test folder-path`
Expected: FAIL — `Failed to load url ../src/docs/folder-path.js`.

- [x] **Step 3: Implementar el helper**

Crear `apps/server/src/docs/folder-path.ts`:

```typescript
import type { AdminStore } from '../admin/store.js';

/**
 * Deriva la ruta de carpetas donde se publican los documentos de un flow, a partir
 * del modelo: el workspace dueño del flow y el group de ese workspace.
 *
 * Devuelve **nombres**, no ids, porque el adapter de Drive crea las carpetas por
 * nombre. Si el workspace no está registrado (típico en dev / in-memory, donde no
 * hay reconciliación) cae al id: el publish es no-fatal, pero igual conviene que
 * escriba en un lugar predecible en vez de tirar.
 */
export async function resolveDocFolderPath(opts: {
  adminStore: AdminStore;
  workspaceId: string;
}): Promise<string[]> {
  const { adminStore, workspaceId } = opts;

  const workspace = await adminStore.getWorkspace(workspaceId);
  if (!workspace) return [workspaceId];

  if (!workspace.group_id) return [workspace.name];

  const groups = await adminStore.listGroups();
  const group = groups.find((g) => g.group_id === workspace.group_id);

  return group ? [group.name, workspace.name] : [workspace.name];
}
```

- [x] **Step 4: Correr y ver pasar**

Run: `pnpm --filter @sdlc/server test folder-path`
Expected: PASS (4 tests).

- [x] **Step 5: Commit**

```bash
git add apps/server/src/docs/folder-path.ts apps/server/test/folder-path.test.ts
git commit -m "feat(docs): resolveDocFolderPath deriva la ruta de group + workspace"
```

---

### Task 3: Migración 0010 + drizzle schema

**Files:**
- Create: `apps/server/migrations/0010_doc_folder_path.sql`
- Modify: `apps/server/src/state/schema.ts:26-27`
- Test: `apps/server/test/migration-0010.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: columna `flows.doc_folder_path text[]`; las columnas `flows.tribu` y `flows.squad` dejan de existir. La Task 4 mapea la columna nueva.

- [x] **Step 1: Escribir el test de migración (falla)**

Crear `apps/server/test/migration-0010.test.ts`. Sigue el patrón de `migration-0009.test.ts`: asserta sobre el SQL, no contra una base real.

```typescript
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(join(__dirname, '../migrations/0010_doc_folder_path.sql'), 'utf8');

describe('migración 0010 (tribu/squad → doc_folder_path)', () => {
  it('agrega doc_folder_path como text[]', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "doc_folder_path" text\[\]/);
  });

  it('backfillea la ruta histórica antes de dropear las columnas viejas', () => {
    const backfillAt = sql.search(/UPDATE "flows"/);
    const dropAt = sql.search(/DROP COLUMN/);
    expect(backfillAt).toBeGreaterThan(-1);
    expect(dropAt).toBeGreaterThan(-1);
    // El orden importa: dropear primero perdería los datos.
    expect(backfillAt).toBeLessThan(dropAt);
  });

  it('cubre el caso de tener solo tribu, sin squad', () => {
    expect(sql).toMatch(/ARRAY\["tribu", "squad"\]/);
    expect(sql).toMatch(/ARRAY\["tribu"\]/);
  });

  it('dropea tribu y squad', () => {
    expect(sql).toMatch(/DROP COLUMN IF EXISTS "tribu"/);
    expect(sql).toMatch(/DROP COLUMN IF EXISTS "squad"/);
  });
});
```

- [x] **Step 2: Correr y ver fallar**

Run: `pnpm --filter @sdlc/server test migration-0010`
Expected: FAIL — `ENOENT`, el archivo de migración no existe.

- [x] **Step 3: Escribir la migración**

Crear `apps/server/migrations/0010_doc_folder_path.sql`:

```sql
-- 0010: la ruta de carpetas de documentos deja de ser texto libre (tribu/squad) y
-- pasa a derivarse del modelo (group + workspace). doc_folder_path guarda la ruta
-- efectiva de cada flow: se backfillea con la histórica para no mover de lugar los
-- documentos ya publicados en Drive.
ALTER TABLE "flows" ADD COLUMN IF NOT EXISTS "doc_folder_path" text[];

-- Backfill ANTES del drop: al revés se perderían los datos.
UPDATE "flows"
   SET "doc_folder_path" = ARRAY["tribu", "squad"]
 WHERE "tribu" IS NOT NULL AND "squad" IS NOT NULL;

UPDATE "flows"
   SET "doc_folder_path" = ARRAY["tribu"]
 WHERE "tribu" IS NOT NULL AND "squad" IS NULL;

ALTER TABLE "flows" DROP COLUMN IF EXISTS "tribu";
ALTER TABLE "flows" DROP COLUMN IF EXISTS "squad";
```

- [x] **Step 4: Actualizar el schema de drizzle**

En `apps/server/src/state/schema.ts`, dentro de `export const flows = pgTable('flows', {`, reemplazar:

```typescript
  tribu:      text('tribu'),
  squad:      text('squad'),
```

por:

```typescript
  /** Ruta de carpetas del doc store. La escribe el primer publish exitoso; no es input de usuario. */
  doc_folder_path: text('doc_folder_path').array(),
```

- [x] **Step 5: Correr el test y el typecheck**

Run: `pnpm --filter @sdlc/server test migration-0010`
Expected: PASS (4 tests).

Run: `pnpm --filter @sdlc/server typecheck`
Expected: FAIL en `src/state/postgres.ts` (líneas ~63 y ~251, que todavía mapean `tribu`/`squad`). Es esperado: lo cierra la Task 4.

- [x] **Step 6: Commit**

```bash
git add apps/server/migrations/0010_doc_folder_path.sql apps/server/src/state/schema.ts apps/server/test/migration-0010.test.ts
git commit -m "feat(db): migración 0010 — doc_folder_path con backfill de tribu/squad"
```

---

### Task 4: Sacar `tribu`/`squad` del dominio y de `start_flow`

**Files:**
- Modify: `packages/core/src/flow.ts:77-78`
- Modify: `apps/server/src/state/store.ts:24-25` (`CreateFlowInput`) y `:29-41` (`UpdateFlowInput`)
- Modify: `apps/server/src/state/in-memory.ts:31-32`
- Modify: `apps/server/src/state/postgres.ts:63-64` y `:251-252`
- Modify: `apps/server/src/mcp/tools/start-flow.ts:14-15` y `:45-46`
- Test: `apps/server/test/flow.test.ts:305-338`

**Interfaces:**
- Consumes: `flows.doc_folder_path` de la Task 3.
- Produces: `Flow.doc_folder_path?: string[]`; `UpdateFlowInput.doc_folder_path?: string[]`. `CreateFlowInput` y `StartFlowInput` pierden `tribu`/`squad`. La Task 5 escribe `doc_folder_path` vía `updateFlow`.

- [x] **Step 1: Reescribir los tests afectados (fallan)**

En `apps/server/test/flow.test.ts`, reemplazar íntegro el bloque `describe('start_flow tribu/squad', ...)` (líneas ~305-322) por:

```typescript
describe('start_flow ya no acepta ruta de carpetas', () => {
  it('la ruta no es input de start_flow: sale del modelo al publicar', async () => {
    const store = new InMemoryFlowStore();
    const tool = makeStartFlowTool(store);
    const ctx: TenantCtx = {
      tenantId: 't2', userId: 'u', roles: [],
      resolveSecret: async () => { throw new Error('not used'); },
    };

    const result = await tool.handler(
      { project: 'p1', title: 'Flow sin ruta', initiative_type: 'feature' },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect((result as any).data.doc_folder_path).toBeUndefined();
  });
});
```

Y reemplazar el test `stores tribu and squad on the flow when provided` (dentro de `describe('FlowStore tribu/squad/adr extensions', ...)`, líneas ~325-338) por:

```typescript
  it('guarda doc_folder_path cuando se lo actualiza', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({
      tenant_id: 't1',
      project: 'p1',
      slug: 'folder-test',
      title: 'T',
    });

    const updated = await store.updateFlow(flow.flow_id, {
      doc_folder_path: ['Product', 'Platform'],
    });

    expect(updated.doc_folder_path).toEqual(['Product', 'Platform']);
  });
```

Renombrar ese `describe` de `'FlowStore tribu/squad/adr extensions'` a `'FlowStore doc_folder_path/adr extensions'`.

- [x] **Step 2: Correr y ver fallar**

Run: `pnpm --filter @sdlc/server test flow.test`
Expected: FAIL — `doc_folder_path` no existe en `UpdateFlowInput` (error de tipos) y `updated.doc_folder_path` es `undefined`.

- [x] **Step 3: Sacar los campos del schema de dominio**

En `packages/core/src/flow.ts`, dentro de `export const Flow = z.object({`, reemplazar:

```typescript
  tribu:     z.string().optional(),
  squad:     z.string().optional(),
```

por:

```typescript
  /** Ruta de carpetas del doc store, derivada del modelo y fijada en el primer publish. */
  doc_folder_path: z.array(z.string()).optional(),
```

- [x] **Step 4: Actualizar los tipos del store**

En `apps/server/src/state/store.ts`, en `CreateFlowInput` borrar:

```typescript
  tribu?: string;
  squad?: string;
```

y en `UpdateFlowInput` agregar, después de `initiative_type?: InitiativeType;`:

```typescript
  doc_folder_path?: string[];
```

- [x] **Step 5: Actualizar las dos implementaciones del store**

En `apps/server/src/state/in-memory.ts`, en `createFlow`, borrar las dos líneas:

```typescript
      ...(input.tribu !== undefined ? { tribu: input.tribu } : {}),
      ...(input.squad !== undefined ? { squad: input.squad } : {}),
```

(`updateFlow` in-memory aplica el patch con spread, así que `doc_folder_path` no necesita nada extra. Verificarlo leyendo el método antes de seguir.)

En `apps/server/src/state/postgres.ts`, en el insert de `createFlow` (línea ~63) borrar:

```typescript
        tribu: input.tribu ?? null,
        squad: input.squad ?? null,
```

y en el mapper de fila a `Flow` (línea ~251) reemplazar:

```typescript
    tribu: row.tribu ?? undefined,
    squad: row.squad ?? undefined,
```

por:

```typescript
    doc_folder_path: row.doc_folder_path ?? undefined,
```

Además, en `updateFlow` de `postgres.ts`, agregar `doc_folder_path` al armado del patch siguiendo exactamente el patrón de los campos vecinos (buscar cómo se trata `adr_refs`/`initiative_type` en ese método y replicarlo).

- [x] **Step 6: Sacar los inputs de `start_flow`**

En `apps/server/src/mcp/tools/start-flow.ts`, en `StartFlowInput` borrar:

```typescript
  tribu: z.string().optional(),
  squad: z.string().optional(),
```

y en la llamada a `store.createFlow` borrar:

```typescript
        ...(input.tribu !== undefined ? { tribu: input.tribu } : {}),
        ...(input.squad !== undefined ? { squad: input.squad } : {}),
```

- [x] **Step 7: Correr tests y typecheck**

Run: `pnpm --filter @sdlc/server test flow.test`
Expected: PASS.

Run: `pnpm --filter @sdlc/server typecheck`
Expected: FAIL solamente en `src/mcp/tools/submit-prd.ts`, `submit-rfc.ts` y `submit-adr.ts`, que siguen leyendo `flow.tribu`/`flow.squad`. Es lo que cierra la Task 5.

Ojo: el tsconfig del server tiene `include: ["src/**/*"]`, así que **los archivos de test no pasan por el typecheck**. Un test que le pase `tribu` a `createFlow` no falla al compilar: falla al correr, cuando el assert no encuentra el campo. Por eso los tests afectados se arreglan explícitamente en su task (Task 5, step 1b) en vez de confiar en el typecheck.

- [x] **Step 8: Commit**

```bash
git add packages/core/src/flow.ts apps/server/src/state apps/server/src/mcp/tools/start-flow.ts apps/server/test/flow.test.ts
git commit -m "feat(flow): doc_folder_path reemplaza tribu/squad en el dominio y start_flow"
```

---

### Task 5: Cablear la derivación en las tools de publish

**Files:**
- Modify: `apps/server/src/mcp/tools/index.ts` (`BuildRegistryDeps` + construcción de las 3 tools)
- Modify: `apps/server/src/mcp/tools/submit-prd.ts:47-75`
- Modify: `apps/server/src/mcp/tools/submit-rfc.ts:59-83`
- Modify: `apps/server/src/mcp/tools/submit-adr.ts:46-71`
- Modify: `apps/server/src/index.ts` (pasar `adminStore` a `buildToolRegistry`)
- Test: `apps/server/test/submit-prd-with-drive.test.ts`, `apps/server/test/submit-rfc-with-drive.test.ts`, `apps/server/test/submit-adr.test.ts`

**Interfaces:**
- Consumes: `resolveDocFolderPath` (Task 2), `DocPublishInput.folder_path` (Task 1), `UpdateFlowInput.doc_folder_path` (Task 4).
- Produces: `BuildRegistryDeps.adminStore?: AdminStore` (opcional, para no romper los tests que arman registries mínimos).

- [x] **Step 1: Escribir los tests (fallan)**

En `apps/server/test/submit-prd-with-drive.test.ts`:

**1a.** Agregar el import del AdminStore in-memory arriba, junto a los otros:

```typescript
import { InMemoryAdminStore } from '../src/admin/in-memory.js';
```

**1b.** El primer test del archivo (`stores Drive url in prd_ref...`) hoy pasa `tribu`/`squad` a `createFlow` y asserta que llegan al `publish`. Como `CreateFlowInput` los perdió en la Task 4, hay que arreglarlo: borrar la línea `tribu: 'Tribu-A', squad: 'Squad-B',` del `createFlow` y cambiar el `objectContaining` final por:

```typescript
    expect(fakeAdapter.publish).toHaveBeenCalledWith(
      expect.objectContaining({ doc_kind: 'prd', folder_path: ['p1'] }),
      ctx,
    );
```

(`['p1']` es el fallback: ese test no le pasa `adminStore` a la tool, y `flow.project` es `'p1'`.)

**1c.** Agregar estos dos tests al final del `describe`:

```typescript
  it('deriva folder_path del modelo y fija la ruta en el primer publish', async () => {
    const store = new InMemoryFlowStore();
    const adminStore = new InMemoryAdminStore();
    await adminStore.createGroup({ group_id: 'product', name: 'Product' });
    await adminStore.createWorkspace({
      workspace_id: 'platform',
      name: 'Platform',
      group_id: 'product',
    });
    const flow = await store.createFlow({
      tenant_id: 't1', project: 'platform', slug: 'derive-test', title: 'Derive',
    });

    const fakeAdapter = {
      kind: 'google-drive' as const,
      publish: vi.fn().mockResolvedValue({ id: 'md-1', url: 'https://docs.example.com/1' }),
      fetch: vi.fn(),
    };
    const docStoreProvider: DocStoreProvider = {
      resolve: vi.fn().mockResolvedValue(fakeAdapter),
    };

    const tool = makeSubmitPrdTool(store, docStoreProvider, adminStore);
    const result = await tool.handler({ flow_id: flow.flow_id, prd_markdown: PRD }, ctx);

    expect(result.ok).toBe(true);
    expect(fakeAdapter.publish).toHaveBeenCalledWith(
      expect.objectContaining({ folder_path: ['Product', 'Platform'] }),
      ctx,
    );
    // El primer publish exitoso deja la ruta fijada, para que un rename posterior
    // del workspace no parta los documentos del flow en dos carpetas.
    expect((result as any).data.flow.doc_folder_path).toEqual(['Product', 'Platform']);
  });

  it('respeta la ruta histórica del flow en vez de re-derivarla', async () => {
    const store = new InMemoryFlowStore();
    const adminStore = new InMemoryAdminStore();
    await adminStore.createWorkspace({ workspace_id: 'platform', name: 'Platform' });
    const flow = await store.createFlow({
      tenant_id: 't1', project: 'platform', slug: 'legacy-test', title: 'Legacy',
    });
    // Ruta heredada del modelo viejo, como la dejó el backfill de la migración 0010.
    await store.updateFlow(flow.flow_id, { doc_folder_path: ['Tribu-A', 'Squad-B'] });

    const fakeAdapter = {
      kind: 'google-drive' as const,
      publish: vi.fn().mockResolvedValue({ id: 'md-2', url: 'https://docs.example.com/2' }),
      fetch: vi.fn(),
    };
    const docStoreProvider: DocStoreProvider = {
      resolve: vi.fn().mockResolvedValue(fakeAdapter),
    };

    const tool = makeSubmitPrdTool(store, docStoreProvider, adminStore);
    await tool.handler({ flow_id: flow.flow_id, prd_markdown: PRD }, ctx);

    expect(fakeAdapter.publish).toHaveBeenCalledWith(
      expect.objectContaining({ folder_path: ['Tribu-A', 'Squad-B'] }),
      ctx,
    );
  });
```

**1d.** Los otros dos archivos de publish tienen el mismo problema que 1b — pasan `tribu`/`squad` a `createFlow` y los assertean en el `publish`. Arreglarlos igual:

- `apps/server/test/submit-rfc-with-drive.test.ts`: borrar `tribu: 'Tribu-X', squad: 'Squad-Y',` del `createFlow` (línea ~69) y cambiar el assert de la línea ~95 a
  `expect.objectContaining({ doc_kind: 'rfc', folder_path: ['p1'] })` — ajustando `'p1'` al `project` que use ese `createFlow`.
- `apps/server/test/submit-adr.test.ts`: borrar `tribu: 'T', squad: 'S',` del `createFlow` (línea ~33) y las dos líneas `tribu: 'T',` / `squad: 'S',` del `objectContaining` (líneas ~62-63), reemplazándolas por `folder_path: [<el project del flow>],`.

Estos dos archivos no rompen el typecheck (los tests están fuera de `include`): rompen al correr.

- [x] **Step 2: Correr y ver fallar**

Run: `pnpm --filter @sdlc/server test submit-`
Expected: FAIL — `makeSubmitPrdTool` todavía no acepta un tercer parámetro, y los asserts de `folder_path` no encuentran el campo en el input capturado.

- [x] **Step 3: Extender la firma de las tres tools**

En cada una de `submit-prd.ts`, `submit-rfc.ts` y `submit-adr.ts`, agregar un tercer parámetro opcional a la factory:

```typescript
export function makeSubmitPrdTool(
  store: FlowStore,
  docStoreProvider: DocStoreProvider,
  adminStore?: AdminStore,
) {
```

(importar `import type { AdminStore } from '../../admin/store.js';` y `import { resolveDocFolderPath } from '../../docs/folder-path.js';`)

Dentro del handler, antes del `try` del publish, calcular la ruta efectiva:

```typescript
      // La ruta histórica manda: si el flow ya publicó, sus documentos viven ahí.
      // Recién si no la tiene se deriva del modelo (group + workspace del flow).
      const folderPath =
        flow.doc_folder_path ??
        (adminStore
          ? await resolveDocFolderPath({ adminStore, workspaceId: flow.project })
          : [flow.project]);
```

y en la llamada a `publish`, reemplazar las dos líneas de `tribu`/`squad` por:

```typescript
          folder_path: folderPath,
```

- [x] **Step 4: Persistir la ruta en el primer publish exitoso**

En las tres tools, sumar `doc_folder_path` al `updateFlow` que ya existe justo después del publish, solo cuando el publish funcionó y el flow todavía no tenía ruta:

```typescript
        ...(published && flow.doc_folder_path === undefined
          ? { doc_folder_path: folderPath }
          : {}),
```

En `submit-adr.ts` la variable que indica éxito puede llamarse distinto: leer el handler y usar la que corresponda (ahí el `publishResult` se asigna dentro del `try`).

- [x] **Step 5: Pasar el `adminStore` por el registry**

En `apps/server/src/mcp/tools/index.ts`:

1. Agregar a `BuildRegistryDeps`:

```typescript
  /** Opcional: sin esto la ruta de documentos cae al workspace_id en vez de derivarse. */
  adminStore?: AdminStore;
```

con `import type { AdminStore } from '../../admin/store.js';`

2. Sumarlo al destructuring de `buildToolRegistry` y pasarlo a las tres tools:

```typescript
    makeSubmitPrdTool(store, docStoreProvider, adminStore) as unknown as ToolDef,
    makeSubmitRfcTool(store, docStoreProvider, adminStore) as unknown as ToolDef,
    makeSubmitAdrTool(store, docStoreProvider, adminStore) as unknown as ToolDef,
```

En `apps/server/src/index.ts`, en la llamada a `buildToolRegistry`, agregar `adminStore: adminStoreHandle.store`.

- [x] **Step 6: Correr y ver pasar**

Run: `pnpm --filter @sdlc/server test submit-`
Expected: PASS.

Run: `npx turbo run typecheck`
Expected: PASS — acá cierra el typecheck global que quedó rojo desde la Task 1.

- [x] **Step 7: Commit**

```bash
git add apps/server/src/mcp/tools apps/server/src/index.ts apps/server/test/submit-prd-with-drive.test.ts
git commit -m "feat(docs): las tools de publish derivan folder_path y fijan la ruta"
```

---

### Task 6: Documentación y envs del test de integración

**Files:**
- Modify: `apps/server/test/gdrive-docstore.integration.test.ts:8` y los tres `publish` (~48, ~65, ~79)
- Modify: `docs/ARCHITECTURE.md` (línea ~9 y ~13, más § *Modelo de adapters*)
- Modify: `apps/server/.env.example` (bloque de tests)

**Interfaces:**
- Consumes: todo lo anterior. No produce nada nuevo.

- [x] **Step 1: Actualizar el test de integración**

En `apps/server/test/gdrive-docstore.integration.test.ts`, reemplazar:

```typescript
const testTribu = process.env.GDRIVE_TEST_TRIBU ?? '_ci-tribu';
```

(y la constante análoga de squad) por:

```typescript
// CSV: cada segmento es una carpeta, de la raíz hacia abajo.
const testFolderPath = (process.env.GDRIVE_TEST_FOLDER_PATH ?? '_ci-group,_ci-workspace')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
```

y en los tres `publish({ ... })` cambiar `tribu: testTribu, squad: testSquad,` por `folder_path: testFolderPath,`.

- [x] **Step 2: Correr el test (se skipea sin credenciales)**

Run: `pnpm --filter @sdlc/server test gdrive-docstore.integration`
Expected: PASS con los 4 tests skipeados (no hay `GDRIVE_TEST_SA_JSON` en local). Lo que se verifica acá es que el archivo compila y que el guard de skip sigue funcionando.

- [x] **Step 3: Actualizar `ARCHITECTURE.md`**

- Línea ~9: en la descripción de `FlowStore`, cambiar `los campos `tribu`/`squad`/`adr_refs`` por `los campos `doc_folder_path`/`adr_refs``.
- Línea ~13: en el bullet de `GoogleDriveDocStoreAdapter`, cambiar `carpetas Tribu/Squad/flow + `adr`` por `carpetas derivadas del modelo (group/workspace) + la del flow + `adr``.
- En § *Modelo de adapters*, en la fila de `DocStoreAdapter` de la tabla de contratos, agregar una oración: la ruta la arma quien llama vía `folder_path`, y el server la deriva con `resolveDocFolderPath` (group + workspace del flow), fijándola en el primer publish para no mover documentos ya publicados.

- [x] **Step 4: Actualizar `.env.example`**

En el bloque `── Tests ──` de `apps/server/.env.example`, agregar:

```
# Ruta de carpetas para el test de integración de Drive (CSV, un segmento por carpeta).
# GDRIVE_TEST_FOLDER_PATH=_ci-group,_ci-workspace
```

- [x] **Step 5: Verificación final**

Run: `npx turbo run typecheck test build --force`
Expected: todo verde. La cuenta de tests sube respecto de la base (357 passed): +1 en el adapter de Drive, +4 de `folder-path`, +4 de `migration-0010`, +2 en `submit-prd-with-drive`, y `flow.test` mantiene su cantidad.

- [x] **Step 6: Commit**

```bash
git add apps/server/test/gdrive-docstore.integration.test.ts docs/ARCHITECTURE.md apps/server/.env.example
git commit -m "docs(adapters): folder_path derivado del modelo + env del test de Drive"
```

---

## Self-Review

**Cobertura del spec:**
- § 1 *Contrato `folder_path: string[]`* → Task 1. ✅
- § 2 *Derivación en la capa de tools* (helper + los tres casos + inyección en el registry) → Task 2 (helper) + Task 5 (inyección). ✅
- § 3 *Compatibilidad con lo ya publicado* (migración 0010 con backfill, ruta efectiva `doc_folder_path ?? derive`, persistir en el primer publish) → Task 3 (migración) + Task 5 (steps 3 y 4). ✅
- § 4 *Superficie que cambia* (`start_flow`, schema `Flow`, ambos stores) → Task 4. ✅
- § *Manejo de errores* → Task 1 step 1 (error temprano si `folder_path` viene vacío), Task 2 step 1 (fallback de workspace inexistente). El "publish no-fatal" no se toca, y está como constraint global. ✅
- § *Testing* → las 6 filas de la tabla del spec caen en Tasks 1, 2, 3, 4, 5 y 6. ✅

**Consistencia de tipos:** `folder_path?: string[]` (Task 1) es lo que consume el adapter y lo que producen las tools en Task 5. `resolveDocFolderPath({ adminStore, workspaceId }): Promise<string[]>` se define en Task 2 y se llama con esa forma exacta en Task 5. `doc_folder_path` es `string[]` en el schema zod (Task 4), `text('doc_folder_path').array()` en drizzle (Task 3) y `text[]` en SQL (Task 3). `AdminStore` se usa solo con `getWorkspace` y `listGroups`, que ya existen en la interfaz: no se agrega ningún método.

**Orden de ejecución:** las Tasks 1, 3 y 4 dejan el typecheck global rojo a propósito (cada una verifica su propio slice con su test) y la Task 5 lo cierra. Cada task queda commiteada por separado para poder bisectar. No se pueden paralelizar: 4 depende de 3, y 5 depende de 1, 2 y 4.

**Riesgo principal:** el step 4 de la Task 5 (persistir la ruta) toca tres handlers con formas ligeramente distintas — `submit-adr` en particular asigna su resultado de publish dentro del `try` con otro nombre de variable. El plan lo señala explícitamente para que no se copie y pegue a ciegas.

**Trampa de verificación:** el tsconfig del server usa `include: ["src/**/*"]`, así que los archivos de `test/` **no** pasan por `tsc`. Los tres tests que hoy le pasan `tribu`/`squad` a `createFlow` (`submit-prd-with-drive`, `submit-rfc-with-drive`, `submit-adr`) no van a romper el typecheck: rompen al correr. Están enumerados uno por uno en la Task 5, steps 1b y 1d, justamente para que no se descubran por sorpresa al final.
