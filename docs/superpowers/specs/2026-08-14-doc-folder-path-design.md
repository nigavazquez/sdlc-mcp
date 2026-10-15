# Ruta de carpetas de documentos derivada del modelo — Design

**Fecha:** 2026-08-14
**Estado:** implementado el 2026-08-27 — PR [#14](https://github.com/nigavazquez/sdlc-mcp/pull/14), mergeado en `bb11fa6`.
Plan: `docs/superpowers/plans/2026-08-14-doc-folder-path.md`. El diseño se implementó tal cual;
el único cambio es el número de la migración, que salió como **0011** porque la tanda 2 se llevó
el 0010 (`0010_qa_results.sql`, PR #13).

## Problema

El flow guarda dos campos de texto libre, `tribu` y `squad`, cuyo único consumidor es
`GoogleDriveDocStoreAdapter`: forman la ruta de carpetas `Tribu/Squad/<flow-slug>` donde se
publican PRD, RFC y ADRs. Los pasa quien llama a `start_flow`.

Eso tiene tres problemas:

1. **Vocabulario propio de una organización dentro del contrato.** `DocPublishInput.tribu` /
   `.squad` está en `packages/adapters-contracts`, la interfaz que implementa cualquier adapter
   de terceros. Un deploy que hable de "teams" dentro de "departments" implementa campos que se
   llaman de otra manera.
2. **Estado redundante que puede driftear.** `flow.project` **es** el `workspace_id`, y el
   workspace ya tiene su `group_id`. Un flow puede tener `squad: "planning"` con
   `project: "platform"` y nada lo detecta: la ruta de Drive contradice al workspace dueño del
   flow.
3. **Asume exactamente dos niveles** de jerarquía, que es la forma de una organización puntual.

## Objetivo

Que la ruta de publicación se **derive del modelo** (el workspace del flow y el group de ese
workspace) en vez de venir como texto libre, y que el contrato no tenga vocabulario de
organización — sin mover de lugar los documentos ya publicados.

## No-goals

- Renombrar `flows.project` (sigue siendo el `workspace_id`; ver la nota en `ARCHITECTURE.md`).
- Cambiar la jerarquía del modelo: `group` sigue siendo metadato opcional, sin efecto en permisos.
- Hacer configurable la forma de la ruta (p. ej. una plantilla `"{group}/{workspace}"`). YAGNI:
  hoy nadie lo pide y el campo histórico ya cubre los casos existentes.
- Tocar el resto de los adapters (backlog, PRs).

## Diseño

### 1. Contrato: `folder_path: string[]`

En `packages/adapters-contracts/src/docs.ts`, `DocPublishInput` pierde `tribu?` y `squad?`, y gana:

```ts
/** Segmentos de carpeta, de la raíz hacia abajo. Requerido cuando kind='google-drive'. */
folder_path?: string[];
```

`GoogleDriveDocStoreAdapter.publish` valida que `folder_path` venga y no esté vacío (mismo error
temprano que hoy, antes de cualquier I/O) y arma los segmentos así:

```
doc_kind === 'adr'  →  [...folder_path, flow_folder, 'adr']
otro                →  [...folder_path, flow_folder]
```

El contrato deja de asumir dos niveles: el adapter une los segmentos que reciba.

### 2. Derivación en la capa de tools

El adapter no puede derivar la ruta: no tiene acceso a los stores, solo al `TenantCtx`. La
derivación va en la capa de tools, en un helper nuevo:

```ts
// apps/server/src/docs/folder-path.ts
export async function resolveDocFolderPath(opts: {
  adminStore: AdminStore;
  workspaceId: string;
}): Promise<string[]>;
```

Devuelve los **nombres** (no los ids) porque `ensureFolderPath` crea las carpetas de Drive por
nombre:

| Caso | Resultado |
|---|---|
| Workspace con group | `[group.name, workspace.name]` |
| Workspace sin group | `[workspace.name]` |
| Workspace inexistente (dev / in-memory) | `[workspaceId]` |

El fallback importa: en modo in-memory no hay registros de workspace, y el publish ya es
**no-fatal** en las tres tools (se cachea el error, `published: false`, el `sha256` es el ancla
durable), así que un problema de derivación no bloquea el avance del flow.

`buildToolRegistry` recibe el `adminStore` como dependencia nueva —del mismo modo que ya recibe
los providers— y `submit_prd`, `submit_rfc` y `submit_adr` lo usan para armar el `folder_path`.

### 3. Compatibilidad con lo ya publicado

Es el punto de riesgo. El upsert del adapter matchea por nombre **dentro de la carpeta destino**,
así que si la ruta de un flow existente cambia, un re-publish no actualiza el documento: crea un
duplicado en la carpeta nueva.

Migración `0010` (salió como **`0011`**, ver el estado arriba):

1. `ALTER TABLE flows ADD COLUMN doc_folder_path text[]`
2. Backfill: `doc_folder_path = ARRAY[tribu, squad]` donde ambos sean NOT NULL (y `ARRAY[tribu]`
   cuando solo esté `tribu`)
3. `DROP COLUMN tribu`, `DROP COLUMN squad`

Al publicar, la ruta efectiva es:

```
flow.doc_folder_path ?? await resolveDocFolderPath(...)
```

Los flows históricos siguen publicando exactamente donde ya están; solo los flows nuevos
—`doc_folder_path` NULL— derivan del modelo.

**El primer publish exitoso persiste la ruta derivada** en `doc_folder_path`. Así, si más adelante
se renombra el workspace o su group, los documentos de ese flow siguen yendo a la carpeta donde ya
están en vez de partirse en dos ubicaciones. No agrega I/O: las tres tools ya hacen un
`store.updateFlow(...)` inmediatamente después del publish, así que es un campo más en esa misma
escritura. La columna nunca es entrada de usuario: se escribe sola y no la expone ninguna tool.

### 4. Superficie que cambia

- `start_flow` pierde los inputs opcionales `tribu` y `squad`.
- El schema `Flow` de `packages/core` pierde los dos campos, así que **cambia la forma de la
  respuesta** de toda tool que devuelve un flow (`start_flow`, `get_flow_state`, …). Es un cambio
  incompatible en la superficie MCP, aceptable porque los campos no tenían consumidor externo más
  allá del adapter de Drive.
- `InMemoryFlowStore` y `PostgresFlowStore` dejan de mapear `tribu`/`squad` y mapean
  `doc_folder_path`.

### Manejo de errores

| Situación | Comportamiento |
|---|---|
| `folder_path` vacío o ausente con kind `google-drive` | El adapter tira antes de cualquier I/O (igual que hoy con tribu/squad) |
| Workspace inexistente al derivar | Fallback a `[workspaceId]`; no se corta el flow |
| Falla el publish por cualquier motivo | Ya es no-fatal: `published: false` + `publish_error`, el flow avanza |

## Testing

| Nivel | Qué cubre |
|---|---|
| `folder-path.test.ts` (nuevo) | Los tres casos de derivación: con group, sin group, workspace inexistente |
| `docs.ts` / adapter unit | `folder_path` de 1 y de 3 segmentos; ADR agrega `'adr'`; error temprano si viene vacío |
| `migration-0010.test.ts` (nuevo) | Backfill de `[tribu, squad]`, columna nueva presente, columnas viejas ausentes |
| `flow.test.ts` | Reescribir el caso `start_flow tribu/squad` (línea ~305): `start_flow` ya no acepta esos inputs |
| Publish de PRD/RFC/ADR | La ruta efectiva prefiere `doc_folder_path` cuando está, deriva cuando es NULL, y el primer publish exitoso la persiste |
| `gdrive-docstore.integration.test.ts` | `GDRIVE_TEST_TRIBU`/`GDRIVE_TEST_SQUAD` → `GDRIVE_TEST_FOLDER_PATH` (CSV) |

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Un flow existente re-publica en una carpeta nueva y duplica el documento | El backfill de `doc_folder_path` preserva la ruta histórica; solo los flows nuevos derivan |
| Renombrar un workspace o su group parte los documentos de un flow en dos carpetas | El primer publish exitoso fija la ruta en `doc_folder_path`, así que un rename posterior no mueve nada. Solo afecta a flows que nunca publicaron |
| Cambio incompatible en la superficie MCP | Los campos no tenían consumidor externo; queda asentado en el commit y en `ARCHITECTURE.md` |
