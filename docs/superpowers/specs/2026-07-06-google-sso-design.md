# Google SSO end-to-end (Fase 4) — Design

**Fecha:** 2026-07-06
**Estado:** diseño aprobado

## Contexto

El panel admin (recién mergeado) se loguea con password scrypt; el endpoint MCP autentica
con API keys por tenant y confía en headers `X-User-Id`/`X-User-Roles` sin verificar.
La organización usa Google Workspace (`@example.com`). Se decidió reemplazar **ambas** superficies
por Google SSO en una sola entrega, con auth MCP **solo Google** (las API keys se retiran).

### Decisiones tomadas

- **Alcance:** panel admin **y** clientes MCP (Claude Code de los devs) con Google SSO.
- **User → tenant/roles:** directorio `tenant_members` administrado desde el panel
  (email → tenant + roles). Una persona pertenece a un solo tenant (PK email).
- **API keys:** se eliminan de la auth MCP (breaking para CI/headless — fuera de alcance
  un flujo de service accounts). La solapa del panel y la env `API_KEYS` se retiran;
  `tenant_api_keys` queda en la DB sin uso (sin drop).
- **Panel:** login = "Sign in with Google" gateado por env `ADMIN_EMAILS`;
  `ADMIN_PASSWORD_HASH` se elimina. La sesión cookie HMAC existente se mantiene.
- **Arquitectura AS (enfoque A):** el MCP server actúa como OAuth 2.1 Authorization
  Server brokereando Google, porque Google no soporta DCR ni resource indicators.
  Emite tokens propios con claims `tenant_id`/`sub`/`roles`.

## Componentes

### Datos (migración 0007)

```sql
tenant_members(email text PK, tenant_id text NOT NULL, roles jsonb NOT NULL, created_at)
oauth_clients(client_id text PK, client_name text, redirect_uris jsonb NOT NULL, created_at)
oauth_codes(code_hash text PK, client_id, redirect_uri, code_challenge, email, tenant_id,
            roles jsonb, expires_at, used_at)
oauth_refresh_tokens(id text PK, token_hash text UNIQUE, email, tenant_id, roles jsonb,
                     client_id, expires_at, revoked_at)
```

### Authorization Server (`apps/server/src/oauth/`)

- `GET /.well-known/oauth-protected-resource` (RFC 9728) y
  `GET /.well-known/oauth-authorization-server` (RFC 8414), construidos desde `PUBLIC_URL`.
- `POST /oauth/register` (RFC 7591): DCR abierto; persiste client_id + redirect_uris.
- `GET /oauth/authorize`: valida client + redirect_uri + PKCE S256 obligatorio; empaqueta
  el request en un **state firmado con HMAC** (stateless, TTL 10 min) y redirige a Google
  (`hd=example.com`, scope `openid email`). El mismo mecanismo con `mode=admin` sirve para
  el login del panel — un único redirect URI en Google.
- `GET /oauth/callback`: canjea el code con Google (via `GoogleIdentityProvider`), verifica
  `hd` + email; **mode mcp:** busca en `tenant_members` (sin fila → página de error
  "pedile el alta al admin"), emite nuestro authorization code (single-use, 60 s, hasheado)
  y redirige al cliente; **mode admin:** chequea `ADMIN_EMAILS`, setea la cookie de sesión
  del panel y redirige a `/admin/`.
- `POST /oauth/token`: `authorization_code` (verifica PKCE + single-use + expiry) y
  `refresh_token` (rotación: el usado se revoca y se emite uno nuevo). Devuelve access
  token JWT **HS256** (`OAUTH_SIGNING_SECRET`, 1 h; claims `iss`=PUBLIC_URL, `aud`=sdlc-mcp,
  `sub`=email, `tenant_id`, `roles`, `iat`/`exp`) + refresh token opaco (30 días, hasheado).

### Broker de Google

Interfaz `GoogleIdentityProvider { authUrl(state, redirectUri): string; exchangeCode(code, redirectUri): Promise<{ email, hostedDomain }> }`.
Impl real con `googleapis` (`google.auth.OAuth2`, ya es dependencia); impl fake para tests.
Todo el flujo AS se testea vía `app.inject` sin Google real.

### Auth MCP

`Authorization: Bearer <JWT propio>` es el único esquema: se verifica firma/exp/iss/aud y
se construye `TenantCtx { tenantId, userId: sub, roles }` desde los claims. Los headers
`X-User-*` se ignoran y `createApiKeyAuth`/`API_KEYS` se eliminan. El 401 incluye
`WWW-Authenticate: Bearer resource_metadata="<PUBLIC_URL>/.well-known/oauth-protected-resource"`,
que dispara el flujo OAuth automático en Claude Code.

### Panel

- Login: botón "Sign in with Google" → `/oauth/authorize?...&mode=admin`. Guard actual sin
  cambios (cookie HMAC). Se elimina el login por password y el rate-limiter asociado.
- Nueva solapa **Miembros** por tenant: alta/edición/baja de `tenant_members`
  (email + roles del catálogo). Se retira la solapa API keys y sus endpoints.

### Config nueva

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_SIGNING_SECRET` (requerido para MCP),
`PUBLIC_URL`, `ADMIN_EMAILS` (CSV), `GOOGLE_HOSTED_DOMAIN` (default `example.com`).
Sin `GOOGLE_CLIENT_ID/SECRET` configurados, `/oauth/*` responde 503 y el MCP queda
inaccesible (sin fallback) — el runbook cubre el setup del client en Google Cloud console
("Web application", redirect URI `<PUBLIC_URL>/oauth/callback`).

## Riesgos

- **Breaking:** al deployar, los clientes MCP con API key dejan de autenticar. Coordinar
  con las 5 squads: crear el client de Google, setear envs, dar de alta miembros en el
  directorio, y recién entonces switchear.
- Single-instance: state firmado y codes en DB toleran reinicios; el rate-limit de login
  desaparece con el password (Google absorbe el brute-force).

## Testing

- Unit: JWT sign/verify (exp/iss/aud/tamper), PKCE S256, state firmado (TTL/tamper).
- Stores: directory + oauth (codes single-use/expiry, refresh rotation/revocación).
- E2E inject con Google fake: register → authorize → callback → token → tool call MCP con
  el JWT → refresh → refresh reusado falla. Panel: callback admin setea cookie; email fuera
  de `ADMIN_EMAILS` → 403; miembro inexistente en flujo MCP → error de alta.
