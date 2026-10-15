# Google SSO end-to-end Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Google SSO para el panel admin y para los clientes MCP, con el server actuando como OAuth 2.1 Authorization Server broker de Google y directorio email→tenant/roles en el panel.

**Architecture:** Módulo nuevo `apps/server/src/oauth/` (JWT HS256, PKCE, state firmado, stores de clients/codes/refresh, broker Google fakeable, rutas AS + metadata). La auth MCP pasa de API keys a verificación de JWT propio. El panel reemplaza password por SSO y gana la solapa Miembros (`tenant_members`).

**Tech Stack:** Fastify 5, Drizzle, zod, `node:crypto` (sin deps nuevas de crypto), `googleapis` (ya presente) para el broker real, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-06-google-sso-design.md` (decisiones y contratos).
- Tests corren sin DB ni Google real (stores in-memory + `FakeGoogleIdentityProvider`).
- Claims del access token: `iss`=PUBLIC_URL, `aud`="sdlc-mcp", `sub`=email, `tenant_id`, `roles[]`, `iat`, `exp` (1 h). Refresh opaco 30 días, hasheado sha256, rotado en cada uso.
- Breaking asumido: se eliminan `API_KEYS`, `ADMIN_PASSWORD_HASH`, headers `X-User-*`, endpoints y UI de API keys.
- Commits frecuentes con el trailer del repo.

---

### Task 1: Migración 0007 + schema Drizzle

**Files:** Create `apps/server/migrations/0007_google_sso.sql`; Modify `apps/server/src/state/schema.ts`.

Tablas exactas del spec: `tenant_members` (email PK, tenant_id, roles jsonb, created_at), `oauth_clients` (client_id PK, client_name, redirect_uris jsonb, created_at), `oauth_codes` (code_hash PK, client_id, redirect_uri, code_challenge, email, tenant_id, roles jsonb, expires_at, used_at), `oauth_refresh_tokens` (id PK, token_hash UNIQUE, email, tenant_id, roles jsonb, client_id, expires_at, revoked_at). Typecheck + commit.

### Task 2: Crypto OAuth — JWT HS256 + PKCE + state firmado (TDD)

**Files:** Create `apps/server/src/oauth/crypto.ts`; Test `apps/server/test/oauth-crypto.test.ts`.

**Produces:**
```ts
signJwt(payload: object, secret: string): string
verifyJwt(token: string, secret: string, opts: { iss: string; aud: string }, now?: number):
  | { ok: true; payload: Record<string, unknown> } | { ok: false; error: string }
verifyPkceS256(verifier: string, challenge: string): boolean
signState(data: object, secret: string, ttlMs: number, now?: number): string   // base64url(json).hmac
verifyState(state: string, secret: string, now?: number): Record<string, unknown> | null
sha256hex(input: string): string
randomToken(prefix: string): string   // prefix + 32 bytes base64url
```
Tests: roundtrip, exp vencida, iss/aud incorrectos, firma alterada, PKCE con vector RFC 7636 (verifier `dBjftJeZ...` → challenge `E9Melhoa...`), state TTL/tamper.

### Task 3: DirectoryStore (tenant_members) — TDD

**Files:** Create `apps/server/src/oauth/directory-store.ts`, `directory-in-memory.ts`, `directory-postgres.ts`; Test `apps/server/test/directory-store.test.ts`.

**Produces:**
```ts
interface MemberRecord { email: string; tenant_id: string; roles: string[]; created_at: string }
interface DirectoryStore {
  getMember(email: string): Promise<MemberRecord | undefined>;
  listMembers(tenantId: string): Promise<MemberRecord[]>;
  upsertMember(input: { email: string; tenant_id: string; roles: string[] }): Promise<MemberRecord>;
  removeMember(email: string): Promise<boolean>;
}
```
Emails normalizados a lowercase en ambas impls. Postgres con `onConflictDoUpdate` sobre email.

### Task 4: OAuthStore (clients + codes + refresh) — TDD

**Files:** Create `apps/server/src/oauth/oauth-store.ts`, `oauth-in-memory.ts`, `oauth-postgres.ts`, `factory.ts` (createDirectoryStore + createOAuthStore, patrón handle existente), `index.ts`; Test `apps/server/test/oauth-store.test.ts`.

**Produces:**
```ts
interface OAuthClient { client_id: string; client_name: string; redirect_uris: string[] }
interface GrantClaims { email: string; tenant_id: string; roles: string[] }
interface OAuthStore {
  registerClient(input: { client_name: string; redirect_uris: string[] }): Promise<OAuthClient>;
  getClient(clientId: string): Promise<OAuthClient | undefined>;
  /** Persiste el code hasheado con TTL 60s. Devuelve el code plaintext. */
  issueCode(input: GrantClaims & { client_id: string; redirect_uri: string; code_challenge: string }): Promise<string>;
  /** Single-use: marca used_at; null si no existe, expiró o ya se usó. */
  consumeCode(code: string): Promise<(GrantClaims & { client_id: string; redirect_uri: string; code_challenge: string }) | null>;
  issueRefreshToken(input: GrantClaims & { client_id: string }): Promise<string>;   // 30 días
  /** Rota: revoca el usado y devuelve claims; null si inválido/expirado/revocado. */
  consumeRefreshToken(token: string): Promise<(GrantClaims & { client_id: string }) | null>;
}
```
Tests: code single-use y expiry (inyectar `now`), refresh rotation (el viejo deja de servir), revocado no sirve.

### Task 5: GoogleIdentityProvider (real + fake)

**Files:** Create `apps/server/src/oauth/google.ts`; el fake vive en `apps/server/test/helpers/fake-google.ts`.

```ts
interface GoogleIdentity { email: string; hostedDomain: string | undefined }
interface GoogleIdentityProvider {
  authUrl(input: { state: string; redirectUri: string; hostedDomain: string }): string;
  exchangeCode(input: { code: string; redirectUri: string }): Promise<GoogleIdentity>;
}
class RealGoogleIdentityProvider // google.auth.OAuth2 + verifyIdToken (googleapis)
class FakeGoogleIdentityProvider // authUrl determinística; exchangeCode lee de un Map code→identity
```

### Task 6: Rutas AS `/oauth/*` + metadata (TDD, e2e con fake)

**Files:** Create `apps/server/src/oauth/routes.ts`; Test `apps/server/test/oauth-flow.test.ts`.

**Produces:** `registerOAuthRoutes(app, deps)` con deps `{ oauthStore, directory, google, config: { publicUrl, signingSecret, stateSecret?, hostedDomain, adminEmails, adminSessionSecret, secureCookies } }`. Rutas del spec; mode admin reutiliza `serializeSessionCookie`/`createSession` de `admin/auth.ts`. Errores OAuth con `error`/`error_description` estándar. Sin `GOOGLE_CLIENT_ID/SECRET` → 503 en `/oauth/*` (metadata sigue sirviendo).

Tests e2e (inject): flujo completo feliz MCP (register → authorize sigue redirect → callback con fake → code → token → JWT con claims correctos → refresh → refresh viejo falla), PKCE incorrecto → `invalid_grant`, code reusado → `invalid_grant`, email sin membership → redirect a página de error, mode admin → set-cookie y redirect `/admin/`, admin fuera de allowlist → 403.

### Task 7: Auth MCP por JWT (reemplaza API keys)

**Files:** Create `apps/server/src/auth/oauth-bearer.ts`; Delete `apps/server/src/auth/api-key.ts` y `apps/server/test/api-key-auth.test.ts`; Modify `apps/server/src/index.ts`, `apps/server/src/config.ts`; Test `apps/server/test/oauth-bearer.test.ts`.

```ts
createOAuthBearerAuth(opts: { signingSecret: string; publicUrl: string }, secretResolver: SecretResolver):
  (req: AuthRequestLike) => Promise<TenantCtx>
// AuthError gana wwwAuthenticate; index.ts agrega el header en 401.
```
Config: quitar `apiKeys`/`adminPasswordHash`; agregar `googleClientId/Secret`, `oauthSigningSecret`, `publicUrl`, `adminEmails`, `googleHostedDomain` (default example.com). AdminStore pierde las API keys? — **no**: `AdminStore` conserva tenants; los métodos de keys quedan sin rutas (se limpian de la interface y ambas impls). Actualizar tests afectados.

### Task 8: Panel — API de miembros + retiro de keys/password

**Files:** Modify `apps/server/src/admin/routes.ts` (quitar login por password y endpoints api-keys; agregar `GET/PUT/DELETE /admin/api/tenants/:id/members`), `apps/server/src/admin/store.ts`/impls (quitar keys), tests `admin-routes.test.ts` (login ahora se testea seteando cookie con `createSession` directo; miembros CRUD; keys endpoints → 404).

`PUT /admin/api/tenants/:id/members/:email` body `{ roles: string[] }` (roles validados contra el catálogo: developer, qa, tech-lead, pmo, product-manager, reviewer). `GET /admin/api/me` → `{ email }` de la sesión (la cookie pasa a incluir email en el payload firmado).

### Task 9: SPA — login Google + solapa Miembros

**Files:** Modify `apps/admin/src/pages/Login.tsx` (botón → `location.href = '/oauth/authorize?mode=admin'` — el server arma el resto), `TenantDetail.tsx` (tab Miembros con tabla email/roles + form alta con checkboxes de roles; se elimina ApiKeysTab), `api.ts`. Build verde.

### Task 10: Wiring, docs y runbook

**Files:** Modify `apps/server/src/index.ts` (crear stores/broker/rutas OAuth), `.env.example`, `infra/compose.aws.yml` (envs nuevas), `docs/ARCHITECTURE.md` (auth Fase 4 ✅), `README.md` (sección conexión: quitar API key, explicar OAuth automático), Create `docs/runbook-google-sso.md` (client en Google Cloud console, redirect URI, primer admin, alta de miembros, coordinación del switch con las squads).

### Task 11: Verificación final + PR

`pnpm turbo run build typecheck test --force` verde; smoke manual: server local con fake deshabilitado → `/oauth/*` 503, metadata 200, 401 MCP con WWW-Authenticate. PR con summary y test plan.

## Self-Review

- Cobertura del spec: datos ✔ (T1), crypto ✔ (T2), directorio ✔ (T3, T8, T9), AS ✔ (T4-T6), MCP ✔ (T7), panel ✔ (T8-T9), config/docs/runbook ✔ (T10). Breaking documentado en runbook (T10).
- Tipos consistentes entre T2-T7 (GrantClaims, deps de routes).
- Los detalles de UI (T9) se especifican por comportamiento; contratos completos en T8.
