# Admin Panel Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Panel web single-admin para gestionar tenants, API keys, integraciones y ver flows, servido por el mismo Fastify del MCP server.

**Architecture:** API REST `/admin/api/*` como módulo nuevo `apps/server/src/admin/` (session cookie HMAC + password scrypt en env), stores con impl in-memory y Postgres siguiendo el patrón existente, y SPA React+Vite en `apps/admin` servida como estáticos bajo `/admin`. La auth MCP gana lookup de API keys en DB con la env `API_KEYS` como fallback.

**Tech Stack:** Fastify 5, Drizzle + postgres-js, zod, vitest (server); React 18 + Vite 5 + react-router (admin UI). Única dependencia nueva del server: `@fastify/static`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-06-admin-panel-design.md`.
- El endpoint MCP (`/mcp/*`) no cambia de contrato; solo su auth acepta keys de DB además de la env.
- El panel nunca recibe ni devuelve valores de secretos — solo referencias (`aws-sm://...`).
- Las API keys se muestran en plaintext **solo** en la respuesta de creación; se persisten como sha256 hex.
- Sin `ADMIN_PASSWORD_HASH` configurado, toda la API admin responde 503 (panel deshabilitado).
- Todo test corre sin DB (stores in-memory); vitest en `apps/server/test/`.
- Convención de commits del repo: `feat(...)`, `test(...)`, `chore(...)` + trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Migración 0006 + schema Drizzle de `tenant_api_keys`

**Files:**
- Create: `apps/server/migrations/0006_tenant_api_keys.sql`
- Modify: `apps/server/src/state/schema.ts` (agregar tabla al final)

**Interfaces:**
- Produces: tabla Drizzle `tenant_api_keys` exportada desde `schema.ts` (columns: `id`, `tenant_id`, `key_hash`, `label`, `created_at`, `revoked_at`).

- [ ] **Step 1: Escribir la migración**

```sql
-- Admin panel: API keys por tenant, gestionadas desde el panel.
-- La key se persiste hasheada (sha256 hex); el plaintext solo se muestra al crearla.
CREATE TABLE IF NOT EXISTS "tenant_api_keys" (
  "id"         text PRIMARY KEY,
  "tenant_id"  text NOT NULL,
  "key_hash"   text NOT NULL UNIQUE,
  "label"      text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "tenant_api_keys_tenant_idx" ON "tenant_api_keys" ("tenant_id");
```

- [ ] **Step 2: Agregar la tabla a `schema.ts`** (después de `tenant_integrations`)

```ts
export const tenant_api_keys = pgTable('tenant_api_keys', {
  id: text('id').primaryKey(),
  tenant_id: text('tenant_id').notNull(),
  key_hash: text('key_hash').notNull().unique(),
  label: text('label').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revoked_at: timestamp('revoked_at', { withTimezone: true }),
});
```

(`unique()` requiere importar nada nuevo; `text().unique()` existe en drizzle pg-core.)

- [ ] **Step 3: Typecheck** — `cd apps/server && npx tsc -p tsconfig.json --noEmit` → sin errores.
- [ ] **Step 4: Commit** — `git add apps/server/migrations/0006_tenant_api_keys.sql apps/server/src/state/schema.ts && git commit -m "feat(admin): migration 0006 tenant_api_keys"`

---

### Task 2: AdminStore (interface + in-memory) con TDD

**Files:**
- Create: `apps/server/src/admin/store.ts`
- Create: `apps/server/src/admin/in-memory.ts`
- Create: `apps/server/src/admin/index.ts`
- Test: `apps/server/test/admin-store.test.ts`

**Interfaces:**
- Produces:

```ts
export interface TenantRecord { tenant_id: string; name: string; created_at: string }
export interface ApiKeyRecord {
  id: string; tenant_id: string; label: string; created_at: string; revoked_at: string | null;
}
export interface AdminStore {
  listTenants(): Promise<TenantRecord[]>;
  getTenant(tenantId: string): Promise<TenantRecord | undefined>;
  createTenant(input: { tenant_id: string; name: string }): Promise<TenantRecord>; // throws si existe
  listApiKeys(tenantId: string): Promise<ApiKeyRecord[]>;
  createApiKey(input: { tenant_id: string; label: string }): Promise<{ record: ApiKeyRecord; apiKey: string }>;
  revokeApiKey(tenantId: string, keyId: string): Promise<boolean>;
  /** Solo keys activas (revoked_at IS NULL). Devuelve tenant_id o undefined. */
  findTenantByApiKey(apiKey: string): Promise<string | undefined>;
}
export function generateApiKey(): string;          // 'sdlc_' + 32 bytes base64url
export function hashApiKey(apiKey: string): string; // sha256 hex
```

- [ ] **Step 1: Test que falla** — `apps/server/test/admin-store.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { InMemoryAdminStore } from '../src/admin/in-memory.js';
import { hashApiKey } from '../src/admin/store.js';

describe('InMemoryAdminStore', () => {
  it('creates and lists tenants; rejects duplicates', async () => {
    const s = new InMemoryAdminStore();
    const t = await s.createTenant({ tenant_id: 't1', name: 'Tribu Uno' });
    expect(t.tenant_id).toBe('t1');
    expect((await s.listTenants()).map((x) => x.tenant_id)).toEqual(['t1']);
    await expect(s.createTenant({ tenant_id: 't1', name: 'dup' })).rejects.toThrow(/exists/);
  });

  it('creates an api key: plaintext once, stored hashed, resolvable', async () => {
    const s = new InMemoryAdminStore();
    await s.createTenant({ tenant_id: 't1', name: 'T' });
    const { record, apiKey } = await s.createApiKey({ tenant_id: 't1', label: 'ci' });
    expect(apiKey).toMatch(/^sdlc_/);
    expect(record.label).toBe('ci');
    const listed = await s.listApiKeys('t1');
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(apiKey); // nunca re-expone plaintext
    expect(await s.findTenantByApiKey(apiKey)).toBe('t1');
    expect(await s.findTenantByApiKey('sdlc_nope')).toBeUndefined();
  });

  it('revoked keys stop resolving', async () => {
    const s = new InMemoryAdminStore();
    await s.createTenant({ tenant_id: 't1', name: 'T' });
    const { record, apiKey } = await s.createApiKey({ tenant_id: 't1', label: 'x' });
    expect(await s.revokeApiKey('t1', record.id)).toBe(true);
    expect(await s.findTenantByApiKey(apiKey)).toBeUndefined();
    expect((await s.listApiKeys('t1'))[0]?.revoked_at).not.toBeNull();
    expect(await s.revokeApiKey('t1', 'missing')).toBe(false);
  });

  it('hashApiKey is deterministic sha256 hex', () => {
    expect(hashApiKey('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey('abc')).toBe(hashApiKey('abc'));
  });
});
```

- [ ] **Step 2: Correr y ver FAIL** — `cd apps/server && npx vitest run test/admin-store.test.ts` → "Cannot find module '../src/admin/in-memory.js'".
- [ ] **Step 3: Implementar** — `store.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';

export interface TenantRecord { tenant_id: string; name: string; created_at: string }
export interface ApiKeyRecord {
  id: string; tenant_id: string; label: string; created_at: string; revoked_at: string | null;
}

export interface AdminStore {
  listTenants(): Promise<TenantRecord[]>;
  getTenant(tenantId: string): Promise<TenantRecord | undefined>;
  createTenant(input: { tenant_id: string; name: string }): Promise<TenantRecord>;
  listApiKeys(tenantId: string): Promise<ApiKeyRecord[]>;
  createApiKey(input: { tenant_id: string; label: string }): Promise<{ record: ApiKeyRecord; apiKey: string }>;
  revokeApiKey(tenantId: string, keyId: string): Promise<boolean>;
  findTenantByApiKey(apiKey: string): Promise<string | undefined>;
}

/** 'sdlc_' + 32 bytes url-safe. Se muestra una única vez al crearla. */
export function generateApiKey(): string {
  return `sdlc_${randomBytes(32).toString('base64url')}`;
}

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}
```

`in-memory.ts`:

```ts
import { randomUUID } from 'node:crypto';
import {
  generateApiKey,
  hashApiKey,
  type AdminStore,
  type ApiKeyRecord,
  type TenantRecord,
} from './store.js';

interface StoredKey extends ApiKeyRecord { key_hash: string }

export class InMemoryAdminStore implements AdminStore {
  private readonly tenants = new Map<string, TenantRecord>();
  private readonly keys = new Map<string, StoredKey>(); // by id

  async listTenants(): Promise<TenantRecord[]> {
    return [...this.tenants.values()];
  }

  async getTenant(tenantId: string): Promise<TenantRecord | undefined> {
    return this.tenants.get(tenantId);
  }

  async createTenant(input: { tenant_id: string; name: string }): Promise<TenantRecord> {
    if (this.tenants.has(input.tenant_id)) {
      throw new Error(`Tenant "${input.tenant_id}" already exists`);
    }
    const record: TenantRecord = { ...input, created_at: new Date().toISOString() };
    this.tenants.set(input.tenant_id, record);
    return record;
  }

  async listApiKeys(tenantId: string): Promise<ApiKeyRecord[]> {
    return [...this.keys.values()]
      .filter((k) => k.tenant_id === tenantId)
      .map(({ key_hash: _hash, ...record }) => record);
  }

  async createApiKey(input: { tenant_id: string; label: string }): Promise<{ record: ApiKeyRecord; apiKey: string }> {
    const apiKey = generateApiKey();
    const stored: StoredKey = {
      id: randomUUID(),
      tenant_id: input.tenant_id,
      label: input.label,
      created_at: new Date().toISOString(),
      revoked_at: null,
      key_hash: hashApiKey(apiKey),
    };
    this.keys.set(stored.id, stored);
    const { key_hash: _hash, ...record } = stored;
    return { record, apiKey };
  }

  async revokeApiKey(tenantId: string, keyId: string): Promise<boolean> {
    const key = this.keys.get(keyId);
    if (!key || key.tenant_id !== tenantId || key.revoked_at) return false;
    key.revoked_at = new Date().toISOString();
    return true;
  }

  async findTenantByApiKey(apiKey: string): Promise<string | undefined> {
    const hash = hashApiKey(apiKey);
    for (const key of this.keys.values()) {
      if (key.key_hash === hash && !key.revoked_at) return key.tenant_id;
    }
    return undefined;
  }
}
```

`index.ts`: `export * from './store.js'; export * from './in-memory.js';`

- [ ] **Step 4: Correr y ver PASS** — `npx vitest run test/admin-store.test.ts`.
- [ ] **Step 5: Commit** — `feat(admin): AdminStore interface + in-memory impl`

---

### Task 3: PostgresAdminStore + factory

**Files:**
- Create: `apps/server/src/admin/postgres.ts`
- Create: `apps/server/src/admin/factory.ts`
- Modify: `apps/server/src/admin/index.ts` (re-export)

**Interfaces:**
- Consumes: `AdminStore`, `generateApiKey`, `hashApiKey` (Task 2); tablas `tenants`, `tenant_api_keys` (Task 1).
- Produces: `createAdminStore({ databaseUrl? }): { store: AdminStore; kind: 'in-memory' | 'postgres'; close(): Promise<void> }` — mismo patrón que `createIntegrationConfigStore`.

- [ ] **Step 1: Implementar `postgres.ts`** (sin test unitario propio — el patrón del repo testea Postgres solo en integration tests gateados; la lógica compartida ya está cubierta por Task 2):

```ts
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { randomUUID } from 'node:crypto';
import { tenants, tenant_api_keys } from '../state/schema.js';
import {
  generateApiKey,
  hashApiKey,
  type AdminStore,
  type ApiKeyRecord,
  type TenantRecord,
} from './store.js';

export interface PostgresAdminStoreOptions { databaseUrl: string; client?: Sql }

export class PostgresAdminStore implements AdminStore {
  private readonly db: PostgresJsDatabase;
  private readonly client: Sql;

  constructor(opts: PostgresAdminStoreOptions) {
    this.client = opts.client ?? postgres(opts.databaseUrl, { max: 5 });
    this.db = drizzle(this.client);
  }

  async close(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }

  async listTenants(): Promise<TenantRecord[]> {
    const rows = await this.db.select().from(tenants);
    return rows.map((r) => ({ tenant_id: r.id, name: r.name, created_at: r.created_at.toISOString() }));
  }

  async getTenant(tenantId: string): Promise<TenantRecord | undefined> {
    const [r] = await this.db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    return r ? { tenant_id: r.id, name: r.name, created_at: r.created_at.toISOString() } : undefined;
  }

  async createTenant(input: { tenant_id: string; name: string }): Promise<TenantRecord> {
    if (await this.getTenant(input.tenant_id)) {
      throw new Error(`Tenant "${input.tenant_id}" already exists`);
    }
    const [r] = await this.db
      .insert(tenants)
      .values({ id: input.tenant_id, name: input.name })
      .returning();
    return { tenant_id: r!.id, name: r!.name, created_at: r!.created_at.toISOString() };
  }

  async listApiKeys(tenantId: string): Promise<ApiKeyRecord[]> {
    const rows = await this.db
      .select()
      .from(tenant_api_keys)
      .where(eq(tenant_api_keys.tenant_id, tenantId));
    return rows.map((r) => ({
      id: r.id,
      tenant_id: r.tenant_id,
      label: r.label,
      created_at: r.created_at.toISOString(),
      revoked_at: r.revoked_at ? r.revoked_at.toISOString() : null,
    }));
  }

  async createApiKey(input: { tenant_id: string; label: string }): Promise<{ record: ApiKeyRecord; apiKey: string }> {
    const apiKey = generateApiKey();
    const [r] = await this.db
      .insert(tenant_api_keys)
      .values({ id: randomUUID(), tenant_id: input.tenant_id, key_hash: hashApiKey(apiKey), label: input.label })
      .returning();
    return {
      record: {
        id: r!.id,
        tenant_id: r!.tenant_id,
        label: r!.label,
        created_at: r!.created_at.toISOString(),
        revoked_at: null,
      },
      apiKey,
    };
  }

  async revokeApiKey(tenantId: string, keyId: string): Promise<boolean> {
    const updated = await this.db
      .update(tenant_api_keys)
      .set({ revoked_at: new Date() })
      .where(
        and(
          eq(tenant_api_keys.id, keyId),
          eq(tenant_api_keys.tenant_id, tenantId),
          isNull(tenant_api_keys.revoked_at),
        ),
      )
      .returning({ id: tenant_api_keys.id });
    return updated.length > 0;
  }

  async findTenantByApiKey(apiKey: string): Promise<string | undefined> {
    const [r] = await this.db
      .select({ tenant_id: tenant_api_keys.tenant_id })
      .from(tenant_api_keys)
      .where(and(eq(tenant_api_keys.key_hash, hashApiKey(apiKey)), isNull(tenant_api_keys.revoked_at)))
      .limit(1);
    return r?.tenant_id;
  }
}
```

- [ ] **Step 2: `factory.ts`**

```ts
import { InMemoryAdminStore } from './in-memory.js';
import { PostgresAdminStore } from './postgres.js';
import type { AdminStore } from './store.js';

export interface AdminStoreHandle {
  store: AdminStore;
  kind: 'in-memory' | 'postgres';
  close: () => Promise<void>;
}

export function createAdminStore(opts: { databaseUrl?: string | undefined }): AdminStoreHandle {
  if (opts.databaseUrl) {
    const pg = new PostgresAdminStore({ databaseUrl: opts.databaseUrl });
    return { store: pg, kind: 'postgres', close: () => pg.close() };
  }
  return { store: new InMemoryAdminStore(), kind: 'in-memory', close: async () => {} };
}
```

`index.ts` agrega `export * from './postgres.js'; export * from './factory.js';`

- [ ] **Step 3: Typecheck + suite** — `npx tsc --noEmit` y `npx vitest run` → verde.
- [ ] **Step 4: Commit** — `feat(admin): PostgresAdminStore + createAdminStore factory`

---

### Task 4: Auth MCP con lookup de keys en DB (fallback env)

**Files:**
- Modify: `apps/server/src/auth/api-key.ts`
- Modify: `apps/server/src/index.ts:79` (`ctx = await authenticate(req)`)
- Test: `apps/server/test/api-key-auth.test.ts` (nuevo)

**Interfaces:**
- Consumes: `AdminStore.findTenantByApiKey` (Task 2).
- Produces: `createApiKeyAuth(entries, secretResolver, adminStore?)` → `authenticate(req): Promise<TenantCtx>` (pasa a ser **async**).

- [ ] **Step 1: Test que falla**

```ts
import { describe, expect, it } from 'vitest';
import { createApiKeyAuth, AuthError } from '../src/auth/api-key.js';
import { InMemoryAdminStore } from '../src/admin/in-memory.js';
import type { SecretResolver } from '../src/secrets/index.js';

const secrets: SecretResolver = { resolve: async () => 'x' };
const req = (auth?: string, extra: Record<string, string> = {}) => ({
  headers: { ...(auth ? { authorization: auth } : {}), ...extra },
});

describe('createApiKeyAuth with AdminStore', () => {
  it('accepts a DB-issued key and maps to its tenant', async () => {
    const admin = new InMemoryAdminStore();
    await admin.createTenant({ tenant_id: 't-db', name: 'T' });
    const { apiKey } = await admin.createApiKey({ tenant_id: 't-db', label: 'l' });
    const auth = createApiKeyAuth([], secrets, admin);
    const ctx = await auth(req(`Bearer ${apiKey}`, { 'x-user-id': 'alice' }));
    expect(ctx.tenantId).toBe('t-db');
    expect(ctx.userId).toBe('alice');
  });

  it('rejects a revoked DB key', async () => {
    const admin = new InMemoryAdminStore();
    await admin.createTenant({ tenant_id: 't-db', name: 'T' });
    const { record, apiKey } = await admin.createApiKey({ tenant_id: 't-db', label: 'l' });
    await admin.revokeApiKey('t-db', record.id);
    const auth = createApiKeyAuth([], secrets, admin);
    await expect(auth(req(`Bearer ${apiKey}`))).rejects.toThrow(AuthError);
  });

  it('falls back to env entries when the key is not in DB', async () => {
    const auth = createApiKeyAuth([{ tenantId: 't-env', apiKey: 'legacy' }], secrets, new InMemoryAdminStore());
    const ctx = await auth(req('Bearer legacy'));
    expect(ctx.tenantId).toBe('t-env');
  });

  it('still works without AdminStore (env only)', async () => {
    const auth = createApiKeyAuth([{ tenantId: 't-env', apiKey: 'legacy' }], secrets);
    await expect(auth(req('Bearer nope'))).rejects.toThrow(/Unknown API key/);
  });
});
```

- [ ] **Step 2: FAIL** — la firma actual es sync y de 2 args.
- [ ] **Step 3: Implementar** — en `api-key.ts`, cambiar la factory (mantener `AuthError`/`AuthRequestLike`):

```ts
import type { AdminStore } from '../admin/store.js';

export function createApiKeyAuth(
  entries: ApiKeyEntry[],
  secretResolver: SecretResolver,
  adminStore?: AdminStore,
) {
  const byKey = new Map(entries.map((e) => [e.apiKey, e.tenantId] as const));

  return async function authenticate(req: AuthRequestLike): Promise<TenantCtx> {
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new AuthError('Missing or malformed Authorization header');
    }
    const apiKey = header.slice('Bearer '.length).trim();
    // DB primero (keys emitidas por el panel), env como bootstrap/fallback.
    const tenantId = (await adminStore?.findTenantByApiKey(apiKey)) ?? byKey.get(apiKey);
    if (!tenantId) throw new AuthError('Unknown API key');
    // ... resto idéntico (userId, roles, resolveSecret)
  };
}
```

En `index.ts`, el handler ya es async: `ctx = await authenticate(req);` y pasar el adminStore al crearlo (queda cableado del todo en Task 8).

- [ ] **Step 4: PASS + suite completa** — `npx vitest run` (ningún otro test usa `authenticate` directamente; verificar con `grep -rn createApiKeyAuth apps/server/test`).
- [ ] **Step 5: Commit** — `feat(auth): API keys desde AdminStore con fallback a env`

---

### Task 5: Password scrypt + sesión HMAC + rate limiter (+ script hash-password)

**Files:**
- Create: `apps/server/src/admin/auth.ts`
- Create: `apps/server/scripts/hash-password.ts`
- Modify: `apps/server/package.json` (script `"admin:hash-password": "tsx scripts/hash-password.ts"`)
- Test: `apps/server/test/admin-auth.test.ts`

**Interfaces:**
- Produces:

```ts
export function hashPassword(password: string): string;                 // scrypt$N$r$p$saltB64$hashB64
export function verifyPassword(password: string, stored: string): boolean;
export function createSession(secret: string, ttlMs: number, now?: number): string;
export function verifySession(secret: string, token: string, now?: number): boolean;
export class LoginRateLimiter {
  constructor(maxAttempts?: number, windowMs?: number);                  // default 5 / 15min
  isBlocked(ip: string, now?: number): boolean;
  recordFailure(ip: string, now?: number): void;
  reset(ip: string): void;
}
export const SESSION_TTL_MS: number;                                     // 8h
export const SESSION_COOKIE = 'sdlc_admin';
export function parseCookies(header: string | undefined): Record<string, string>;
export function serializeSessionCookie(token: string, secure: boolean): string;
export function clearSessionCookie(): string;
```

- [ ] **Step 1: Test que falla**

```ts
import { describe, expect, it } from 'vitest';
import {
  hashPassword, verifyPassword, createSession, verifySession,
  LoginRateLimiter, parseCookies,
} from '../src/admin/auth.js';

describe('admin auth primitives', () => {
  it('hashPassword/verifyPassword roundtrip; wrong password fails', () => {
    const stored = hashPassword('s3cret');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('s3cret', stored)).toBe(true);
    expect(verifyPassword('nope', stored)).toBe(false);
  });

  it('verifyPassword rejects malformed stored hashes without throwing', () => {
    expect(verifyPassword('x', 'garbage')).toBe(false);
  });

  it('session roundtrip, expiry, wrong secret, tampering', () => {
    const t0 = 1_000_000;
    const token = createSession('sec', 1000, t0);
    expect(verifySession('sec', token, t0 + 500)).toBe(true);
    expect(verifySession('sec', token, t0 + 1500)).toBe(false); // expirada
    expect(verifySession('other', token, t0 + 500)).toBe(false);
    expect(verifySession('sec', token + 'x', t0 + 500)).toBe(false);
    expect(verifySession('sec', 'not-a-token', t0 + 500)).toBe(false);
  });

  it('rate limiter blocks after N failures within the window and resets', () => {
    const rl = new LoginRateLimiter(3, 1000);
    const t0 = 0;
    expect(rl.isBlocked('ip', t0)).toBe(false);
    rl.recordFailure('ip', t0); rl.recordFailure('ip', t0); rl.recordFailure('ip', t0);
    expect(rl.isBlocked('ip', t0 + 10)).toBe(true);
    expect(rl.isBlocked('ip', t0 + 2000)).toBe(false); // ventana vencida
    rl.reset('ip');
    expect(rl.isBlocked('ip', t0 + 10)).toBe(false);
  });

  it('parseCookies handles absent header and multiple cookies', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('a=1; sdlc_admin=tok; b=2')).toEqual({ a: '1', sdlc_admin: 'tok', b: '2' });
  });
});
```

- [ ] **Step 2: FAIL** — módulo inexistente.
- [ ] **Step 3: Implementar `auth.ts`**

```ts
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'sdlc_admin';

const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 32 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keyLen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, nStr, rStr, pStr, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt' || !nStr || !rStr || !pStr || !saltB64 || !hashB64) return false;
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = scryptSync(password, Buffer.from(saltB64, 'base64url'), expected.length, {
      N: Number(nStr), r: Number(rStr), p: Number(pStr),
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Token sin estado: base64url({exp}) + '.' + HMAC. Logout = borrar cookie. */
export function createSession(secret: string, ttlMs: number = SESSION_TTL_MS, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ exp: now + ttlMs })).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

export function verifySession(secret: string, token: string, now = Date.now()): boolean {
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return false;
  const expected = sign(secret, payload);
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(expected);
  if (macBuf.length !== expBuf.length || !timingSafeEqual(macBuf, expBuf)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp: number };
    return typeof exp === 'number' && now < exp;
  } catch {
    return false;
  }
}

export class LoginRateLimiter {
  private readonly failures = new Map<string, number[]>();
  constructor(
    private readonly maxAttempts = 5,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  isBlocked(ip: string, now = Date.now()): boolean {
    const recent = (this.failures.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    this.failures.set(ip, recent);
    return recent.length >= this.maxAttempts;
  }

  recordFailure(ip: string, now = Date.now()): void {
    this.failures.set(ip, [...(this.failures.get(ip) ?? []), now]);
  }

  reset(ip: string): void {
    this.failures.delete(ip);
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

export function serializeSessionCookie(token: string, secure: boolean): string {
  const attrs = ['Path=/admin', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (secure) attrs.push('Secure');
  return `${SESSION_COOKIE}=${token}; ${attrs.join('; ')}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`;
}
```

- [ ] **Step 4: PASS.**
- [ ] **Step 5: Script `scripts/hash-password.ts`**

```ts
import { hashPassword } from '../src/admin/auth.js';

const password = process.argv[2];
if (!password) {
  console.error('Usage: pnpm admin:hash-password <password>');
  process.exit(1);
}
console.log(hashPassword(password));
```

y en `apps/server/package.json` → `"admin:hash-password": "tsx scripts/hash-password.ts"`.

- [ ] **Step 6: Commit** — `feat(admin): password scrypt + sesión HMAC + rate limiter`

---

### Task 6: Write path de integraciones (in-memory + Postgres)

**Files:**
- Modify: `apps/server/src/integrations/types.ts`
- Modify: `apps/server/src/integrations/in-memory.ts`
- Modify: `apps/server/src/integrations/postgres.ts`
- Modify: `apps/server/src/integrations/seed.ts` (exportar `IntegrationRefSchema`)
- Test: `apps/server/test/integration-config-admin.test.ts`

**Interfaces:**
- Produces (en `types.ts`):

```ts
export interface IntegrationRow { tenant_id: string; project: string; config: IntegrationConfig }
export interface IntegrationConfigAdmin {
  listIntegrations(tenantId: string): Promise<IntegrationRow[]>;
  upsertIntegration(row: IntegrationRow): Promise<void>;
  deleteIntegration(tenantId: string, project: string): Promise<boolean>;
}
```

Ambas impls (`InMemoryIntegrationConfigStore`, `PostgresIntegrationConfigStore`) implementan `IntegrationConfigStore & IntegrationConfigAdmin`. `seed.ts` exporta `IntegrationRefSchema` (ya existe como const local) para reusar en las rutas.

- [ ] **Step 1: Test que falla**

```ts
import { describe, expect, it } from 'vitest';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';

describe('integration config admin write path (in-memory)', () => {
  it('upsert + list + resolution', async () => {
    const s = new InMemoryIntegrationConfigStore();
    await s.upsertIntegration({
      tenant_id: 't1',
      project: 'demo',
      config: { task_system: { kind: 'azure-devops', secret_ref: 'aws-sm://pat', settings: { project: 'Demo' } } },
    });
    const rows = await s.listIntegrations('t1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.config.task_system?.kind).toBe('azure-devops');
    expect((await s.getTaskSystemConfig('t1', 'demo')).kind).toBe('azure-devops');
  });

  it('upsert replaces the whole row; delete removes it', async () => {
    const s = new InMemoryIntegrationConfigStore();
    await s.upsertIntegration({ tenant_id: 't1', project: 'demo', config: { pr_provider: { kind: 'github', settings: {} } } });
    await s.upsertIntegration({ tenant_id: 't1', project: 'demo', config: { doc_store: { kind: 'gdrive', settings: {} } } });
    const [row] = await s.listIntegrations('t1');
    expect(row?.config.pr_provider).toBeUndefined(); // fila canónica, no merge
    expect(row?.config.doc_store?.kind).toBe('gdrive');
    expect(await s.deleteIntegration('t1', 'demo')).toBe(true);
    expect(await s.deleteIntegration('t1', 'demo')).toBe(false);
    expect(await s.listIntegrations('t1')).toEqual([]);
  });
});
```

- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implementar.** In-memory (agrega a la clase existente; `seed()` queda como alias de compat):

```ts
async listIntegrations(tenantId: string): Promise<IntegrationRow[]> {
  return [...this.rows.entries()]
    .filter(([k]) => k.startsWith(`${tenantId}::`))
    .map(([k, config]) => ({ tenant_id: tenantId, project: k.split('::')[1] ?? '', config }));
}

async upsertIntegration(row: IntegrationRow): Promise<void> {
  this.rows.set(this.key(row.tenant_id, row.project), row.config);
}

async deleteIntegration(tenantId: string, project: string): Promise<boolean> {
  return this.rows.delete(this.key(tenantId, project));
}
```

Postgres (mismo `onConflictDoUpdate` que `seedIntegrations`, refs omitidos → NULL):

```ts
async listIntegrations(tenantId: string): Promise<IntegrationRow[]> {
  const rows = await this.db
    .select()
    .from(tenant_integrations)
    .where(eq(tenant_integrations.tenant_id, tenantId));
  return rows.map((r) => ({
    tenant_id: r.tenant_id,
    project: r.project,
    config: {
      ...(r.task_system ? { task_system: r.task_system as IntegrationRef } : {}),
      ...(r.doc_store ? { doc_store: r.doc_store as IntegrationRef } : {}),
      ...(r.pr_provider ? { pr_provider: r.pr_provider as IntegrationRef } : {}),
    },
  }));
}

async upsertIntegration(row: IntegrationRow): Promise<void> {
  const values = {
    tenant_id: row.tenant_id,
    project: row.project,
    task_system: row.config.task_system ?? null,
    doc_store: row.config.doc_store ?? null,
    pr_provider: row.config.pr_provider ?? null,
    updated_at: new Date(),
  };
  await this.db
    .insert(tenant_integrations)
    .values(values)
    .onConflictDoUpdate({ target: [tenant_integrations.tenant_id, tenant_integrations.project], set: values });
}

async deleteIntegration(tenantId: string, project: string): Promise<boolean> {
  const deleted = await this.db
    .delete(tenant_integrations)
    .where(and(eq(tenant_integrations.tenant_id, tenantId), eq(tenant_integrations.project, project)))
    .returning({ p: tenant_integrations.project });
  return deleted.length > 0;
}
```

En `seed.ts`: `export const IntegrationRefSchema = z.object({...})` (ya existe; solo agregar `export`).

- [ ] **Step 4: PASS + suite.**
- [ ] **Step 5: Commit** — `feat(integrations): write path (list/upsert/delete) para el panel admin`

---

### Task 7: Rutas admin — login/logout + guard + recursos

**Files:**
- Create: `apps/server/src/admin/routes.ts`
- Test: `apps/server/test/admin-routes.test.ts`

**Interfaces:**
- Consumes: Tasks 2–6 (`AdminStore`, auth primitives, `IntegrationConfigAdmin`, `IntegrationRefSchema`, `FlowStore.listFlows/getFlow/listStoriesByFlow/listEvents`).
- Produces:

```ts
export interface AdminRoutesDeps {
  adminStore: AdminStore;
  flowStore: FlowStore;
  integrations: IntegrationConfigStore & IntegrationConfigAdmin;
  passwordHash: string | undefined;   // ADMIN_PASSWORD_HASH
  sessionSecret: string;              // ADMIN_SESSION_SECRET
  secureCookies: boolean;             // NODE_ENV === 'production'
}
export function registerAdminRoutes(app: FastifyInstance, deps: AdminRoutesDeps): void;
```

- [ ] **Step 1: Tests que fallan** (los principales; usar `app.inject`):

```ts
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerAdminRoutes } from '../src/admin/routes.js';
import { InMemoryAdminStore } from '../src/admin/in-memory.js';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import { hashPassword } from '../src/admin/auth.js';

async function makeApp(passwordHash: string | undefined = hashPassword('pw')) {
  const app = Fastify();
  const adminStore = new InMemoryAdminStore();
  const flowStore = new InMemoryFlowStore();
  const integrations = new InMemoryIntegrationConfigStore();
  registerAdminRoutes(app, {
    adminStore, flowStore, integrations,
    passwordHash, sessionSecret: 'test-secret', secureCookies: false,
  });
  await app.ready();
  return { app, adminStore, flowStore, integrations };
}

async function login(app: Awaited<ReturnType<typeof makeApp>>['app']) {
  const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'pw' } });
  const cookie = res.headers['set-cookie'] as string;
  return { cookie: cookie.split(';')[0]! };
}

describe('admin routes', () => {
  it('503 when no ADMIN_PASSWORD_HASH configured', async () => {
    const { app } = await makeApp(undefined);
    const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'x' } });
    expect(res.statusCode).toBe(503);
  });

  it('login ok sets session cookie; wrong password 401; guard rejects without cookie', async () => {
    const { app } = await makeApp();
    const bad = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'no' } });
    expect(bad.statusCode).toBe(401);
    const { cookie } = await login(app);
    expect(cookie).toMatch(/^sdlc_admin=/);
    const noAuth = await app.inject({ method: 'GET', url: '/admin/api/tenants' });
    expect(noAuth.statusCode).toBe(401);
    const ok = await app.inject({ method: 'GET', url: '/admin/api/tenants', headers: { cookie } });
    expect(ok.statusCode).toBe(200);
  });

  it('rate-limits login after 5 failures', async () => {
    const { app } = await makeApp();
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'no' }, remoteAddress: '9.9.9.9' });
    }
    const blocked = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { password: 'pw' }, remoteAddress: '9.9.9.9' });
    expect(blocked.statusCode).toBe(429);
  });

  it('tenants: create + list + 409 duplicate', async () => {
    const { app } = await makeApp();
    const { cookie } = await login(app);
    const created = await app.inject({ method: 'POST', url: '/admin/api/tenants', headers: { cookie }, payload: { tenant_id: 't1', name: 'Tribu 1' } });
    expect(created.statusCode).toBe(201);
    const dup = await app.inject({ method: 'POST', url: '/admin/api/tenants', headers: { cookie }, payload: { tenant_id: 't1', name: 'x' } });
    expect(dup.statusCode).toBe(409);
    const list = await app.inject({ method: 'GET', url: '/admin/api/tenants', headers: { cookie } });
    expect(list.json().tenants).toHaveLength(1);
  });

  it('api keys: create returns plaintext once; list never; revoke works; 404 unknown tenant', async () => {
    const { app } = await makeApp();
    const { cookie } = await login(app);
    await app.inject({ method: 'POST', url: '/admin/api/tenants', headers: { cookie }, payload: { tenant_id: 't1', name: 'T' } });
    const created = await app.inject({ method: 'POST', url: '/admin/api/tenants/t1/api-keys', headers: { cookie }, payload: { label: 'ci' } });
    expect(created.statusCode).toBe(201);
    const { api_key, record } = created.json();
    expect(api_key).toMatch(/^sdlc_/);
    const list = await app.inject({ method: 'GET', url: '/admin/api/tenants/t1/api-keys', headers: { cookie } });
    expect(list.body).not.toContain(api_key);
    const revoked = await app.inject({ method: 'DELETE', url: `/admin/api/tenants/t1/api-keys/${record.id}`, headers: { cookie } });
    expect(revoked.statusCode).toBe(200);
    const missing = await app.inject({ method: 'POST', url: '/admin/api/tenants/nope/api-keys', headers: { cookie }, payload: { label: 'x' } });
    expect(missing.statusCode).toBe(404);
  });

  it('integrations: put validates with zod, get lists, delete removes', async () => {
    const { app } = await makeApp();
    const { cookie } = await login(app);
    await app.inject({ method: 'POST', url: '/admin/api/tenants', headers: { cookie }, payload: { tenant_id: 't1', name: 'T' } });
    const bad = await app.inject({
      method: 'PUT', url: '/admin/api/tenants/t1/integrations/demo', headers: { cookie },
      payload: { task_system: { settings: {} } }, // sin kind → 400
    });
    expect(bad.statusCode).toBe(400);
    const put = await app.inject({
      method: 'PUT', url: '/admin/api/tenants/t1/integrations/demo', headers: { cookie },
      payload: { task_system: { kind: 'azure-devops', secret_ref: 'aws-sm://pat', settings: { project: 'Demo' } } },
    });
    expect(put.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/admin/api/tenants/t1/integrations', headers: { cookie } });
    expect(list.json().integrations[0].project).toBe('demo');
    const del = await app.inject({ method: 'DELETE', url: '/admin/api/tenants/t1/integrations/demo', headers: { cookie } });
    expect(del.statusCode).toBe(200);
  });

  it('flows: list by tenant and detail with stories + events; 404 unknown flow', async () => {
    const { app, flowStore } = await makeApp();
    const { cookie } = await login(app);
    const flow = await flowStore.createFlow({ tenant_id: 't1', project: 'demo', slug: 's', title: 'Epic' });
    await flowStore.appendEvent({ flow_id: flow.flow_id, type: 'flow.started', actor: 'pam', payload: {} });
    const list = await app.inject({ method: 'GET', url: '/admin/api/tenants/t1/flows', headers: { cookie } });
    expect(list.json().flows).toHaveLength(1);
    const detail = await app.inject({ method: 'GET', url: `/admin/api/flows/${flow.flow_id}`, headers: { cookie } });
    expect(detail.json().events).toHaveLength(1);
    expect(detail.json().stories).toEqual([]);
    const missing = await app.inject({ method: 'GET', url: '/admin/api/flows/nope', headers: { cookie } });
    expect(missing.statusCode).toBe(404);
  });

  it('logout clears the cookie', async () => {
    const { app } = await makeApp();
    const { cookie } = await login(app);
    const out = await app.inject({ method: 'POST', url: '/admin/api/logout', headers: { cookie } });
    expect(out.headers['set-cookie']).toMatch(/Max-Age=0/);
  });
});
```

- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implementar `routes.ts`**

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { FlowStore } from '../state/index.js';
import type { AdminStore } from './store.js';
import type { IntegrationConfigAdmin, IntegrationConfigStore } from '../integrations/types.js';
import { IntegrationRefSchema } from '../integrations/seed.js';
import {
  LoginRateLimiter, SESSION_COOKIE, clearSessionCookie, createSession,
  parseCookies, serializeSessionCookie, verifyPassword, verifySession,
} from './auth.js';

export interface AdminRoutesDeps {
  adminStore: AdminStore;
  flowStore: FlowStore;
  integrations: IntegrationConfigStore & IntegrationConfigAdmin;
  passwordHash: string | undefined;
  sessionSecret: string;
  secureCookies: boolean;
}

const LoginBody = z.object({ password: z.string().min(1) });
const CreateTenantBody = z.object({ tenant_id: z.string().min(1).regex(/^[a-z0-9_-]+$/), name: z.string().min(1) });
const CreateKeyBody = z.object({ label: z.string().min(1) });
const IntegrationBody = z
  .object({
    task_system: IntegrationRefSchema.optional(),
    doc_store: IntegrationRefSchema.optional(),
    pr_provider: IntegrationRefSchema.optional(),
  })
  .refine((c) => c.task_system ?? c.doc_store ?? c.pr_provider, {
    message: 'at least one of task_system, doc_store, pr_provider is required',
  });

export function registerAdminRoutes(app: FastifyInstance, deps: AdminRoutesDeps): void {
  const rateLimiter = new LoginRateLimiter();

  const guard = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!deps.passwordHash) {
      reply.code(503).send({ error: 'admin panel disabled: ADMIN_PASSWORD_HASH not configured' });
      return false;
    }
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token || !verifySession(deps.sessionSecret, token)) {
      reply.code(401).send({ error: 'not authenticated' });
      return false;
    }
    return true;
  };

  app.post('/admin/api/login', async (req, reply) => {
    if (!deps.passwordHash) {
      return reply.code(503).send({ error: 'admin panel disabled: ADMIN_PASSWORD_HASH not configured' });
    }
    const ip = req.ip;
    if (rateLimiter.isBlocked(ip)) {
      return reply.code(429).send({ error: 'too many attempts; retry later' });
    }
    const parsed = LoginBody.safeParse(req.body ?? {});
    if (!parsed.success || !verifyPassword(parsed.data.password, deps.passwordHash)) {
      rateLimiter.recordFailure(ip);
      return reply.code(401).send({ error: 'invalid password' });
    }
    rateLimiter.reset(ip);
    const token = createSession(deps.sessionSecret);
    return reply
      .header('set-cookie', serializeSessionCookie(token, deps.secureCookies))
      .send({ ok: true });
  });

  app.post('/admin/api/logout', async (_req, reply) =>
    reply.header('set-cookie', clearSessionCookie()).send({ ok: true }),
  );

  app.get('/admin/api/tenants', async (req, reply) => {
    if (!guard(req, reply)) return;
    const tenants = await deps.adminStore.listTenants();
    const enriched = await Promise.all(
      tenants.map(async (t) => ({
        ...t,
        active_keys: (await deps.adminStore.listApiKeys(t.tenant_id)).filter((k) => !k.revoked_at).length,
        integrations: (await deps.integrations.listIntegrations(t.tenant_id)).length,
      })),
    );
    return { tenants: enriched };
  });

  app.post('/admin/api/tenants', async (req, reply) => {
    if (!guard(req, reply)) return;
    const parsed = CreateTenantBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    if (await deps.adminStore.getTenant(parsed.data.tenant_id)) {
      return reply.code(409).send({ error: `tenant "${parsed.data.tenant_id}" already exists` });
    }
    return reply.code(201).send({ tenant: await deps.adminStore.createTenant(parsed.data) });
  });

  app.get('/admin/api/tenants/:id/api-keys', async (req, reply) => {
    if (!guard(req, reply)) return;
    const { id } = req.params as { id: string };
    return { api_keys: await deps.adminStore.listApiKeys(id) };
  });

  app.post('/admin/api/tenants/:id/api-keys', async (req, reply) => {
    if (!guard(req, reply)) return;
    const { id } = req.params as { id: string };
    if (!(await deps.adminStore.getTenant(id))) return reply.code(404).send({ error: `unknown tenant: ${id}` });
    const parsed = CreateKeyBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    const { record, apiKey } = await deps.adminStore.createApiKey({ tenant_id: id, label: parsed.data.label });
    // Única respuesta que incluye el plaintext.
    return reply.code(201).send({ record, api_key: apiKey });
  });

  app.delete('/admin/api/tenants/:id/api-keys/:keyId', async (req, reply) => {
    if (!guard(req, reply)) return;
    const { id, keyId } = req.params as { id: string; keyId: string };
    const revoked = await deps.adminStore.revokeApiKey(id, keyId);
    if (!revoked) return reply.code(404).send({ error: 'key not found or already revoked' });
    return { ok: true };
  });

  app.get('/admin/api/tenants/:id/integrations', async (req, reply) => {
    if (!guard(req, reply)) return;
    const { id } = req.params as { id: string };
    return { integrations: await deps.integrations.listIntegrations(id) };
  });

  app.put('/admin/api/tenants/:id/integrations/:project', async (req, reply) => {
    if (!guard(req, reply)) return;
    const { id, project } = req.params as { id: string; project: string };
    const parsed = IntegrationBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });
    await deps.integrations.upsertIntegration({ tenant_id: id, project, config: parsed.data });
    return { ok: true };
  });

  app.delete('/admin/api/tenants/:id/integrations/:project', async (req, reply) => {
    if (!guard(req, reply)) return;
    const { id, project } = req.params as { id: string; project: string };
    const deleted = await deps.integrations.deleteIntegration(id, project);
    if (!deleted) return reply.code(404).send({ error: 'integration not found' });
    return { ok: true };
  });

  app.get('/admin/api/tenants/:id/flows', async (req, reply) => {
    if (!guard(req, reply)) return;
    const { id } = req.params as { id: string };
    const { project } = req.query as { project?: string };
    const flows = await deps.flowStore.listFlows(id, project);
    return {
      flows: flows.map((f) => ({
        flow_id: f.flow_id, project: f.project, title: f.title,
        status: f.status, current_phase: f.current_phase, updated_at: f.updated_at,
      })),
    };
  });

  app.get('/admin/api/flows/:flowId', async (req, reply) => {
    if (!guard(req, reply)) return;
    const { flowId } = req.params as { flowId: string };
    const flow = await deps.flowStore.getFlow(flowId);
    if (!flow) return reply.code(404).send({ error: `unknown flow: ${flowId}` });
    const [stories, events] = await Promise.all([
      deps.flowStore.listStoriesByFlow(flowId),
      deps.flowStore.listEvents(flowId),
    ]);
    return { flow, stories, events };
  });
}
```

- [ ] **Step 4: PASS + suite completa.**
- [ ] **Step 5: Commit** — `feat(admin): rutas /admin/api (login, tenants, keys, integraciones, flows)`

---

### Task 8: Wiring en `index.ts` + config + estáticos del SPA

**Files:**
- Modify: `apps/server/src/config.ts` (agregar `adminPasswordHash`, `adminSessionSecret`, `adminUiDir`)
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/package.json` (dep `@fastify/static@^8`)
- Modify: `apps/server/.env.example`

**Interfaces:**
- Consumes: `createAdminStore` (Task 3), `registerAdminRoutes` (Task 7), auth async (Task 4).

- [ ] **Step 1: Config** — en `ConfigSchema`:

```ts
/** Hash scrypt del password del panel admin (pnpm admin:hash-password). Sin esto el panel responde 503. */
adminPasswordHash: z.string().optional(),
/** Secreto HMAC de la cookie de sesión. Si falta, se genera uno random por proceso (las sesiones no sobreviven reinicios). */
adminSessionSecret: z.string().optional(),
/** Directorio del build del SPA admin. Default: ../admin/dist relativo al server. */
adminUiDir: z.string().optional(),
```

y en `loadConfig()`: `adminPasswordHash: process.env.ADMIN_PASSWORD_HASH`, `adminSessionSecret: process.env.ADMIN_SESSION_SECRET`, `adminUiDir: process.env.ADMIN_UI_DIR`.

- [ ] **Step 2: `index.ts`** — después de crear `integrationConfig`:

```ts
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { createAdminStore } from './admin/index.js';
import { registerAdminRoutes } from './admin/routes.js';
import type { IntegrationConfigAdmin, IntegrationConfigStore } from './integrations/types.js';

// ...
const adminStoreHandle = createAdminStore({ databaseUrl: config.databaseUrl });
const authenticate = createApiKeyAuth(parseApiKeys(config.apiKeys), secretResolver, adminStoreHandle.store);
// (mover la creación de authenticate debajo de adminStoreHandle)

registerAdminRoutes(app, {
  adminStore: adminStoreHandle.store,
  flowStore: storeHandle.store,
  integrations: integrationConfig.store as IntegrationConfigStore & IntegrationConfigAdmin,
  passwordHash: config.adminPasswordHash,
  sessionSecret: config.adminSessionSecret ?? randomBytes(32).toString('hex'),
  secureCookies: process.env.NODE_ENV === 'production',
});

// SPA estática: solo si el build existe.
const adminUiDir =
  config.adminUiDir ?? resolvePath(dirname(fileURLToPath(import.meta.url)), '../../admin/dist');
if (existsSync(adminUiDir)) {
  await app.register(fastifyStatic, { root: adminUiDir, prefix: '/admin/', decorateReply: false });
  // Fallback del router del SPA: cualquier GET /admin/* que no sea api ni archivo → index.html.
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && req.url.startsWith('/admin') && !req.url.startsWith('/admin/api')) {
      return reply.sendFile
        ? reply.sendFile('index.html')
        : reply.type('text/html').send(readFileSync(join(adminUiDir, 'index.html')));
    }
    return reply.code(404).send({ ok: false, error: 'Not found' });
  });
}
```

Nota: con `decorateReply: false` no hay `reply.sendFile`; usar directamente `readFileSync` (import `node:fs`) y `join` (`node:path`) — dejar solo esa rama. Cerrar `adminStoreHandle` en el hook `onClose`. En el handler `/mcp/tools/:name`: `ctx = await authenticate(req);`.

- [ ] **Step 3: `.env.example`** — documentar:

```bash
# --- Admin panel (opcional; sin ADMIN_PASSWORD_HASH el panel responde 503) ---
# Generar con: pnpm --filter @sdlc/server admin:hash-password <password>
ADMIN_PASSWORD_HASH=
# Secreto HMAC de sesión (si falta se genera por proceso y las sesiones caen al reiniciar)
ADMIN_SESSION_SECRET=
# Override del directorio del build del SPA (default: apps/admin/dist)
# ADMIN_UI_DIR=
```

- [ ] **Step 4: `pnpm install` (dep nueva) + typecheck + suite completa** → verde.
- [ ] **Step 5: Commit** — `feat(server): wiring del panel admin (config, rutas, estáticos, auth DB)`

---

### Task 9: SPA `apps/admin` — scaffold + páginas

**Files:**
- Create: `apps/admin/package.json`, `apps/admin/tsconfig.json`, `apps/admin/vite.config.ts`, `apps/admin/index.html`
- Create: `apps/admin/src/main.tsx`, `apps/admin/src/App.tsx`, `apps/admin/src/api.ts`, `apps/admin/src/styles.css`
- Create: `apps/admin/src/pages/Login.tsx`, `Tenants.tsx`, `TenantDetail.tsx`, `FlowDetail.tsx`

**Interfaces:**
- Consumes: la API `/admin/api/*` (Task 7). Contratos exactos: ver los JSON de las rutas.

- [ ] **Step 1: Scaffold.** `package.json`:

```json
{
  "name": "@sdlc/admin",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json --noEmit && vite build",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.28.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.6.3",
    "vite": "^5.4.11"
  }
}
```

`vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  server: { proxy: { '/admin/api': 'http://localhost:3000' } },
});
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`index.html`: html mínimo con `<div id="root">` y `<script type="module" src="/src/main.tsx">`; title "SDLC Admin".

- [ ] **Step 2: `api.ts`** — helper fetch con manejo de 401:

```ts
export class ApiError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'content-type': 'application/json' } : {},
    ...init,
  });
  if (res.status === 401 && !path.endsWith('/login')) {
    window.location.hash = '#/login';
    throw new ApiError('not authenticated', 401);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? res.statusText, res.status);
  return body as T;
}

export const api = {
  login: (password: string) => request<{ ok: true }>('/admin/api/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request<{ ok: true }>('/admin/api/logout', { method: 'POST' }),
  tenants: () => request<{ tenants: Array<{ tenant_id: string; name: string; active_keys: number; integrations: number }> }>('/admin/api/tenants'),
  createTenant: (tenant_id: string, name: string) => request('/admin/api/tenants', { method: 'POST', body: JSON.stringify({ tenant_id, name }) }),
  apiKeys: (t: string) => request<{ api_keys: Array<{ id: string; label: string; created_at: string; revoked_at: string | null }> }>(`/admin/api/tenants/${t}/api-keys`),
  createApiKey: (t: string, label: string) => request<{ api_key: string }>(`/admin/api/tenants/${t}/api-keys`, { method: 'POST', body: JSON.stringify({ label }) }),
  revokeApiKey: (t: string, id: string) => request(`/admin/api/tenants/${t}/api-keys/${id}`, { method: 'DELETE' }),
  integrations: (t: string) => request<{ integrations: Array<{ project: string; config: Record<string, { kind: string; secret_ref?: string; settings: Record<string, unknown> }> }> }>(`/admin/api/tenants/${t}/integrations`),
  putIntegration: (t: string, project: string, config: unknown) => request(`/admin/api/tenants/${t}/integrations/${project}`, { method: 'PUT', body: JSON.stringify(config) }),
  deleteIntegration: (t: string, project: string) => request(`/admin/api/tenants/${t}/integrations/${project}`, { method: 'DELETE' }),
  flows: (t: string) => request<{ flows: Array<{ flow_id: string; project: string; title: string; status: string; current_phase: string; updated_at: string }> }>(`/admin/api/tenants/${t}/flows`),
  flow: (id: string) => request<{ flow: Record<string, unknown>; stories: Array<Record<string, unknown>>; events: Array<{ type: string; actor: string; ts: string; payload: Record<string, unknown> }> }>(`/admin/api/flows/${id}`),
};
```

- [ ] **Step 3: Router + páginas.** Usar `HashRouter` (evita configurar history fallback más allá del index.html). `App.tsx` define rutas: `#/login`, `#/` (Tenants), `#/tenants/:id` (tabs), `#/flows/:flowId`. Páginas con `useState`/`useEffect` + `api`, tablas HTML planas, clases CSS propias (`.card`, `.table`, `.btn`, `.tabs`). Comportamientos clave:
  - `Login.tsx`: input password + submit → `api.login` → navigate `#/`. Error 401/429 visible.
  - `Tenants.tsx`: tabla (tenant, name, keys activas, integraciones) + form inline de alta.
  - `TenantDetail.tsx`: tabs Integraciones / API keys / Flows.
    - Integraciones: tabla por project mostrando kind + secret_ref por provider; form upsert con `<textarea>` JSON por provider (validación en server) y botón borrar con `confirm()`.
    - API keys: tabla label/created/revoked + botón "Generate" (prompt de label) que muestra la key devuelta **una sola vez** en un `<code>` copiable con aviso; botón revoke.
    - Flows: tabla title/status/fase/updated con link a detalle.
  - `FlowDetail.tsx`: metadata del flow, tabla de stories (title/status/component/pr_url), timeline de events (`ts — type — actor` + payload `<details>`).
- [ ] **Step 4: Build local** — `pnpm --filter @sdlc/admin build` → genera `apps/admin/dist`. `pnpm --filter @sdlc/admin typecheck` verde.
- [ ] **Step 5: Commit** — `feat(admin-ui): SPA React del panel (login, tenants, keys, integraciones, flows)`

---

### Task 10: Build pipeline + Docker

**Files:**
- Modify: `infra/docker/Dockerfile` (buildear y copiar el SPA)
- Modify: `turbo.json` solo si `build` no cubre `apps/admin` (la task `build` global ya corre por workspace; verificar con `pnpm turbo run build --dry-run`)

- [ ] **Step 1: Dockerfile** — en la stage `deps` agregar `COPY apps/admin/package.json apps/admin/`; en la stage `build` cambiar el filtro: `RUN pnpm turbo run build --filter=@sdlc/server --filter=@sdlc/admin`; en `runtime` agregar `COPY --from=build /app/apps/admin/dist ./apps/admin/dist`.
- [ ] **Step 2: Verificación local** — `pnpm turbo run build` verde en todos los workspaces; levantar el server local con `ADMIN_PASSWORD_HASH` seteado y verificar a mano: `curl -s localhost:3000/admin/api/login -X POST -H 'content-type: application/json' -d '{"password":"..."}' -i` devuelve cookie; `GET /admin/` devuelve el index.html.
- [ ] **Step 3: Commit** — `chore(infra): build + serve del admin SPA en la imagen Docker`

---

### Task 11: Docs

**Files:**
- Modify: `docs/ARCHITECTURE.md` (sección "Auth y multi-tenancy" + roadmap: marcar panel admin ✅ en Fase 4; documentar keys en DB con fallback env)
- Modify: `README.md` (sección corta "Panel admin": cómo generar el hash, URL `/admin`, qué gestiona)

- [ ] **Step 1: Editar ambos docs.**
- [ ] **Step 2: Commit** — `docs: panel admin (setup, auth, alcance)`

---

## Self-Review (hecho al escribir el plan)

- **Cobertura del spec:** migración ✔ (T1), keys DB + fallback env ✔ (T2–T4), login/sesión/rate-limit/503 ✔ (T5, T7), CRUD integraciones ✔ (T6, T7), flows read-only ✔ (T7), SPA + estáticos ✔ (T8, T9), compose/Docker ✔ (T10), docs ✔ (T11).
- **Placeholders:** el detalle de las páginas React (T9 Step 3) se especifica por comportamiento, no por código completo — decisión consciente para mantener el plan manejable; los contratos de datos están completos en `api.ts`.
- **Consistencia de tipos:** `AdminStore`/`IntegrationConfigAdmin`/`registerAdminRoutes` usan los mismos nombres en T2/T3/T6/T7/T8.
