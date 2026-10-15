# Panel Admin Web — Design

**Fecha:** 2026-07-06
**Estado:** diseño aprobado

## Contexto

Fase 4 del roadmap agrupa cuatro entregas independientes: OAuth2/OIDC, panel admin web,
adapters Linear/GitHub Issues y deploy prod. Se decidió **arrancar por el panel admin**;
OAuth queda como sub-proyecto siguiente y reemplazará el login del panel.

Hoy la administración es por fuera del sistema:

- `tenant_integrations` se puebla con `seed:integrations` (CLI + archivo JSON versionado).
- Los tenants y sus API keys viven en la env var `API_KEYS` (`tenant:key,...`), sin
  rotación ni alta/baja sin redeploy.
- No hay visibilidad operativa de flows/stories/eventos fuera de la DB.

### Decisiones tomadas

- **Alcance v1 (completo):** CRUD de integraciones + gestión de tenants/API keys
  (movidas a Postgres) + visibilidad read-only de flows con eventos.
- **Auth del panel:** `ADMIN_PASSWORD_HASH` (scrypt) + `ADMIN_SESSION_SECRET` en env.
  Sesión en cookie httpOnly firmada (HMAC), `SameSite=Strict`, expiración 8 h.
  Rate-limit de intentos de login en memoria. Single-admin hasta OAuth.
- **Stack UI:** SPA React + Vite + TS en `apps/admin`, servida como estáticos por el
  mismo Fastify en `/admin` (un solo contenedor en el compose del EC2). API en
  `/admin/api/*`, separada del endpoint MCP (que no se toca).
- **Secretos:** el panel guarda **solo referencias** (`aws-sm://...`); nunca recibe ni
  muestra valores. El alta del secreto en AWS SM sigue siendo por consola/CLI.

## Objetivo

Un panel web para el COE que reemplace el seed CLI y la env `API_KEYS` como mecanismo
de administración cotidiano, y dé visibilidad del estado de los flows por tenant.

Fuera de scope v1: OAuth (siguiente sub-proyecto), escritura de valores de secretos,
edición/mutación de flows desde el panel, multi-admin, panel para tenants finales.

## Datos (migración 0006)

La tabla `tenants(id, name, task_system, doc_system, created_at)` **ya existe** desde
`0000_init`; el panel hace CRUD sobre ella (id + name). La migración solo agrega:

```sql
CREATE TABLE tenant_api_keys (
  id         text PRIMARY KEY,          -- uuid
  tenant_id  text NOT NULL,
  key_hash   text NOT NULL UNIQUE,      -- sha256 hex de la key
  label      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
```

- Las keys se generan server-side (`sdlc_<32 bytes url-safe>`), se muestran **una sola
  vez** en la respuesta de creación y se persisten hasheadas (sha256).
- La env `API_KEYS` **sigue funcionando** como bootstrap/fallback (primer arranque,
  tests, modo in-memory sin DB). La auth MCP resuelve: DB primero (hash lookup,
  `revoked_at IS NULL`), env después.
- `tenant_integrations` no cambia; el panel escribe sobre ella reutilizando la lógica
  de upsert de `seedIntegrations` (extraída a una función por-fila).

## API `/admin/api/*`

Todas (salvo login) detrás del middleware de sesión. JSON, errores `{ error }`.

| Método y ruta | Propósito |
|---|---|
| `POST /admin/api/login` | `{ password }` → set-cookie de sesión. 401 + rate-limit si falla. |
| `POST /admin/api/logout` | Invalida la cookie. |
| `GET /admin/api/tenants` | Lista tenants (DB) con conteo de keys activas e integraciones. |
| `POST /admin/api/tenants` | `{ tenant_id, name }` → crea tenant. |
| `GET /admin/api/tenants/:id/api-keys` | Lista keys del tenant (label, created, revoked; nunca la key). |
| `POST /admin/api/tenants/:id/api-keys` | `{ label }` → genera key, la devuelve **una vez** en plaintext. |
| `DELETE /admin/api/tenants/:id/api-keys/:keyId` | Revoca (soft: `revoked_at`). |
| `GET /admin/api/tenants/:id/integrations` | Filas de `tenant_integrations` del tenant. |
| `PUT /admin/api/tenants/:id/integrations/:project` | Upsert de `{ task_system?, doc_store?, pr_provider? }` (valida con los mismos schemas zod del seed). |
| `DELETE /admin/api/tenants/:id/integrations/:project` | Borra la fila. |
| `GET /admin/api/tenants/:id/flows` | Flows del tenant (`project` opcional): id, title, status, current_phase, updated_at. |
| `GET /admin/api/flows/:flowId` | Detalle: flow + stories + `flow_events` ordenados. |

Los stores ganan los métodos de lectura/escritura que falten (`listIntegrations`,
`upsertIntegration`, `deleteIntegration`, CRUD de tenants/keys, `listFlowEvents`),
implementados en Postgres **y** in-memory para que los tests corran sin DB.

## Auth del panel — detalle

- `ADMIN_PASSWORD_HASH`: formato `scrypt$N$r$p$salt$hash` generado por
  `pnpm admin:hash-password` (script nuevo, usa `node:crypto`). Sin hash configurado →
  el panel responde 503 "admin panel disabled" (opt-in explícito).
- Cookie de sesión: payload `{ exp }` + HMAC-SHA256 con `ADMIN_SESSION_SECRET`.
  Sin estado server-side; logout = clear cookie; expiración 8 h.
- Rate-limit: contador en memoria por IP, 5 intentos / 15 min sobre `/login`.
- La UI y la API admin se sirven igual en HTTP interno del EC2; `Secure` se activa
  cuando `NODE_ENV=production`.

## UI (`apps/admin`)

React + Vite + TS, react-router, fetch nativo, CSS propio sobrio (sin librería de
componentes). Páginas:

1. **Login** — password única.
2. **Tenants** — tabla + alta.
3. **Tenant detail** — tabs:
   - **Integraciones:** tabla por proyecto con kind/secret_ref/settings por provider;
     form de upsert con validación; borrar.
   - **API keys:** tabla + generar (modal que muestra la key una única vez) + revocar.
   - **Flows:** tabla (title, status, fase, updated) → **Flow detail** con stories y
     timeline de eventos.

Build: `vite build` → `apps/admin/dist`; el server la sirve con `@fastify/static` bajo
`/admin` (fallback a `index.html` para las rutas del router). En dev, `vite dev` con
proxy de `/admin/api` al server.

## Errores y seguridad

- El endpoint MCP y su auth no cambian (solo se agrega el lookup DB de keys).
- Ningún valor de secreto viaja ni se renderiza; solo referencias.
- Validación zod en todos los bodies; 404 tenant/flow inexistente; 409 tenant duplicado.
- La creación de key devuelve plaintext una vez; recargar la lista nunca lo re-expone.

## Testing

- Vitest (server): login/sesión (ok, password mala, rate-limit, cookie expirada),
  generación/revocación de keys (hash en DB, plaintext solo en create, auth MCP acepta
  key de DB y rechaza revocada, fallback env), CRUD integraciones (upsert/parse zod),
  lecturas de flows/eventos. Stores in-memory.
- `apps/admin`: typecheck + build en CI (turbo). Sin e2e de browser en v1.
