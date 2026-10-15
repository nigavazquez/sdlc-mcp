# Real Adapters — Slice 1: Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire real secret resolution (AWS Secrets Manager) and per-tenant/project adapter selection so that, from a tool handler, the right `TaskSystemAdapter` is chosen at call time — keeping the in-memory fake as the default.

**Architecture:** A `SecretResolver` (AWS SM + env impls) backs `ctx.resolveSecret`. An `IntegrationConfigStore` (Postgres + in-memory) holds per-`(tenant, project)` integration config. A `ConfigBackedTaskSystemProvider` reads that config and returns the in-memory fake (default) or, for real kinds, resolves the secret-ref and throws `NotImplementedError` (real adapters land in Slices 2–4). Tools resolve their adapter via the provider instead of receiving a fixed instance.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, Drizzle ORM + postgres-js, `@aws-sdk/client-secrets-manager`, `aws-sdk-client-mock` (tests).

**Spec:** `docs/superpowers/specs/2026-06-08-real-adapters-slice-1-foundations-design.md`

---

## File Structure

**Create:**
- `apps/server/src/secrets/types.ts` — `SecretResolver` interface, `SecretResolutionError`.
- `apps/server/src/secrets/env.ts` — `EnvSecretResolver`.
- `apps/server/src/secrets/aws.ts` — `AwsSecretsManagerResolver`.
- `apps/server/src/secrets/factory.ts` — `createSecretResolver`.
- `apps/server/src/secrets/index.ts` — barrel.
- `apps/server/src/integrations/types.ts` — `IntegrationRef`, `IntegrationConfigStore`.
- `apps/server/src/integrations/in-memory.ts` — `InMemoryIntegrationConfigStore`.
- `apps/server/src/integrations/postgres.ts` — `PostgresIntegrationConfigStore`.
- `apps/server/src/integrations/factory.ts` — `createIntegrationConfigStore`.
- `apps/server/src/integrations/index.ts` — barrel.
- `apps/server/src/adapters/task-system-provider.ts` — `TaskSystemProvider`, `ConfigBackedTaskSystemProvider`, `NotImplementedError`.
- `apps/server/migrations/0003_tenant_integrations.sql` — DDL for `tenant_integrations`.
- Test files (one per unit, see tasks).

**Modify:**
- `apps/server/src/state/schema.ts` — add `tenant_integrations` Drizzle table.
- `apps/server/src/adapters/index.ts` — export the provider module.
- `apps/server/src/config.ts` — add `secretsBackend`.
- `apps/server/src/auth/api-key.ts` — accept a `SecretResolver`, wire `resolveSecret`.
- `apps/server/src/mcp/tools/index.ts` — `BuildRegistryDeps.taskSystem` → `taskSystemProvider`.
- `apps/server/src/mcp/tools/{create-epic,create-stories,link-subtasks,claim-story,report-progress,submit-qa-results,block-story}.ts` — resolve adapter at call time.
- `apps/server/src/index.ts` and `apps/server/src/mcp-stdio.ts` — bootstrap wiring.
- Existing tests that build the registry: `apps/server/test/{shaping,implementation-qa,propose-breakdown,flow}.test.ts` (only those that actually call `buildToolRegistry` — confirm by grep in Task 8).

---

## Task 1: SecretResolver interface + EnvSecretResolver

**Files:**
- Create: `apps/server/src/secrets/types.ts`
- Create: `apps/server/src/secrets/env.ts`
- Test: `apps/server/test/secrets-env.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/secrets-env.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { EnvSecretResolver } from '../src/secrets/env.js';
import { SecretResolutionError } from '../src/secrets/types.js';

describe('EnvSecretResolver', () => {
  afterEach(() => {
    delete process.env.SECRET_ADO_PAT;
  });

  it('maps aws-sm://<name> to SECRET_<NAME> env var', async () => {
    process.env.SECRET_ADO_PAT = 'pat-123';
    const r = new EnvSecretResolver();
    expect(await r.resolve('aws-sm://ado-pat')).toBe('pat-123');
  });

  it('extracts #key from a JSON secret', async () => {
    process.env.SECRET_ADO_PAT = JSON.stringify({ token: 'tok-9', other: 'x' });
    const r = new EnvSecretResolver();
    expect(await r.resolve('aws-sm://ado-pat#token')).toBe('tok-9');
  });

  it('throws SecretResolutionError when the env var is missing', async () => {
    const r = new EnvSecretResolver();
    await expect(r.resolve('aws-sm://ado-pat')).rejects.toBeInstanceOf(SecretResolutionError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sdlc/server test secrets-env`
Expected: FAIL — cannot find `../src/secrets/env.js` / `../src/secrets/types.js`.

- [ ] **Step 3: Write `types.ts`**

Create `apps/server/src/secrets/types.ts`:

```ts
/** Resolves an opaque secret-ref (e.g. `aws-sm://ado-pat#token`) to a concrete string. */
export interface SecretResolver {
  resolve(ref: string): Promise<string>;
}

export class SecretResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretResolutionError';
  }
}

/**
 * Parses a secret-ref of the form `<scheme>://<name>[#<key>]`.
 * Returns the secret name and optional JSON key. The scheme is informational
 * only — every resolver decides how to fetch by `name`.
 */
export function parseSecretRef(ref: string): { name: string; key?: string } {
  const withoutScheme = ref.includes('://') ? ref.slice(ref.indexOf('://') + 3) : ref;
  const [name, key] = withoutScheme.split('#');
  if (!name) throw new SecretResolutionError(`Malformed secret-ref: "${ref}"`);
  return key ? { name, key } : { name };
}

/** Extracts `key` from a JSON secret string, or returns the raw value when no key. */
export function extractKey(raw: string, key: string | undefined, ref: string): string {
  if (!key) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SecretResolutionError(`Secret for "${ref}" is not JSON but a #key was requested`);
  }
  const value = (parsed as Record<string, unknown>)[key];
  if (typeof value !== 'string') {
    throw new SecretResolutionError(`Key "${key}" missing or non-string in secret for "${ref}"`);
  }
  return value;
}
```

- [ ] **Step 4: Write `env.ts`**

Create `apps/server/src/secrets/env.ts`:

```ts
import { extractKey, parseSecretRef, SecretResolutionError, type SecretResolver } from './types.js';

/**
 * Dev/test resolver. Maps a secret-ref name to an env var: the name is
 * uppercased, non-alphanumerics become `_`, and prefixed with `SECRET_`.
 * e.g. `aws-sm://ado-pat#token` → reads `SECRET_ADO_PAT`, then JSON key `token`.
 */
export class EnvSecretResolver implements SecretResolver {
  async resolve(ref: string): Promise<string> {
    const { name, key } = parseSecretRef(ref);
    const envName = `SECRET_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    const raw = process.env[envName];
    if (raw === undefined) {
      throw new SecretResolutionError(`Env var ${envName} not set for secret-ref "${ref}"`);
    }
    return extractKey(raw, key, ref);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @sdlc/server test secrets-env`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/secrets/types.ts apps/server/src/secrets/env.ts apps/server/test/secrets-env.test.ts
git commit -m "feat(secrets): SecretResolver interface + EnvSecretResolver"
```

---

## Task 2: AwsSecretsManagerResolver

**Files:**
- Modify: `apps/server/package.json` (add deps)
- Create: `apps/server/src/secrets/aws.ts`
- Test: `apps/server/test/secrets-aws.test.ts`

- [ ] **Step 1: Add dependencies**

Run:
```bash
pnpm --filter @sdlc/server add @aws-sdk/client-secrets-manager
pnpm --filter @sdlc/server add -D aws-sdk-client-mock
```
Expected: both appear in `apps/server/package.json` (`@aws-sdk/client-secrets-manager` under `dependencies`, `aws-sdk-client-mock` under `devDependencies`).

- [ ] **Step 2: Write the failing test**

Create `apps/server/test/secrets-aws.test.ts`:

```ts
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AwsSecretsManagerResolver } from '../src/secrets/aws.js';
import { SecretResolutionError } from '../src/secrets/types.js';

const smMock = mockClient(SecretsManagerClient);

describe('AwsSecretsManagerResolver', () => {
  beforeEach(() => smMock.reset());
  afterEach(() => smMock.reset());

  it('resolves a plain secret string', async () => {
    smMock.on(GetSecretValueCommand, { SecretId: 'ado-pat' }).resolves({ SecretString: 'pat-123' });
    const r = new AwsSecretsManagerResolver();
    expect(await r.resolve('aws-sm://ado-pat')).toBe('pat-123');
  });

  it('extracts a #key from a JSON secret', async () => {
    smMock.on(GetSecretValueCommand, { SecretId: 'ado-pat' }).resolves({
      SecretString: JSON.stringify({ token: 'tok-9' }),
    });
    const r = new AwsSecretsManagerResolver();
    expect(await r.resolve('aws-sm://ado-pat#token')).toBe('tok-9');
  });

  it('caches by secret name (one SDK call for two resolves)', async () => {
    smMock.on(GetSecretValueCommand, { SecretId: 'ado-pat' }).resolves({ SecretString: 'pat-123' });
    const r = new AwsSecretsManagerResolver({ ttlMs: 60_000 });
    await r.resolve('aws-sm://ado-pat');
    await r.resolve('aws-sm://ado-pat');
    expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
  });

  it('wraps SDK errors in SecretResolutionError and does not cache them', async () => {
    smMock.on(GetSecretValueCommand).rejects(new Error('AccessDenied'));
    const r = new AwsSecretsManagerResolver();
    await expect(r.resolve('aws-sm://ado-pat')).rejects.toBeInstanceOf(SecretResolutionError);
    expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @sdlc/server test secrets-aws`
Expected: FAIL — cannot find `../src/secrets/aws.js`.

- [ ] **Step 4: Write `aws.ts`**

Create `apps/server/src/secrets/aws.ts`:

```ts
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { extractKey, parseSecretRef, SecretResolutionError, type SecretResolver } from './types.js';

export interface AwsSecretsManagerResolverOptions {
  client?: SecretsManagerClient;
  /** Cache TTL for fetched secret strings, in ms. Default 60s. */
  ttlMs?: number;
}

interface CacheEntry {
  value: string;
  expiresAt: number;
}

/**
 * Resolves secret-refs against AWS Secrets Manager. Caches the raw secret
 * string by name with a short TTL so repeated tool calls don't hammer the API.
 * Errors are wrapped (never leaking the secret value) and never cached.
 */
export class AwsSecretsManagerResolver implements SecretResolver {
  private readonly client: SecretsManagerClient;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: AwsSecretsManagerResolverOptions = {}) {
    this.client = opts.client ?? new SecretsManagerClient({});
    this.ttlMs = opts.ttlMs ?? 60_000;
  }

  async resolve(ref: string): Promise<string> {
    const { name, key } = parseSecretRef(ref);
    const raw = await this.fetchRaw(name, ref);
    return extractKey(raw, key, ref);
  }

  private async fetchRaw(name: string, ref: string): Promise<string> {
    const now = Date.now();
    const cached = this.cache.get(name);
    if (cached && cached.expiresAt > now) return cached.value;

    let value: string | undefined;
    try {
      const out = await this.client.send(new GetSecretValueCommand({ SecretId: name }));
      value = out.SecretString;
    } catch (err) {
      throw new SecretResolutionError(
        `Failed to fetch secret for "${ref}": ${(err as Error).name}`,
      );
    }
    if (value === undefined) {
      throw new SecretResolutionError(`Secret "${name}" has no SecretString (binary not supported)`);
    }
    this.cache.set(name, { value, expiresAt: now + this.ttlMs });
    return value;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @sdlc/server test secrets-aws`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/server/package.json ../../pnpm-lock.yaml apps/server/src/secrets/aws.ts apps/server/test/secrets-aws.test.ts
git commit -m "feat(secrets): AwsSecretsManagerResolver with TTL cache"
```

---

## Task 3: createSecretResolver factory + barrel

**Files:**
- Create: `apps/server/src/secrets/factory.ts`
- Create: `apps/server/src/secrets/index.ts`
- Test: `apps/server/test/secrets-factory.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/secrets-factory.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createSecretResolver } from '../src/secrets/index.js';
import { AwsSecretsManagerResolver } from '../src/secrets/aws.js';
import { EnvSecretResolver } from '../src/secrets/env.js';

describe('createSecretResolver', () => {
  it('returns EnvSecretResolver for backend "env"', () => {
    expect(createSecretResolver('env')).toBeInstanceOf(EnvSecretResolver);
  });

  it('returns AwsSecretsManagerResolver for backend "aws"', () => {
    expect(createSecretResolver('aws')).toBeInstanceOf(AwsSecretsManagerResolver);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sdlc/server test secrets-factory`
Expected: FAIL — cannot find `../src/secrets/index.js`.

- [ ] **Step 3: Write `factory.ts`**

Create `apps/server/src/secrets/factory.ts`:

```ts
import { AwsSecretsManagerResolver } from './aws.js';
import { EnvSecretResolver } from './env.js';
import type { SecretResolver } from './types.js';

export type SecretsBackend = 'aws' | 'env';

export function createSecretResolver(backend: SecretsBackend): SecretResolver {
  return backend === 'aws' ? new AwsSecretsManagerResolver() : new EnvSecretResolver();
}
```

- [ ] **Step 4: Write `index.ts`**

Create `apps/server/src/secrets/index.ts`:

```ts
export * from './types.js';
export * from './env.js';
export * from './aws.js';
export * from './factory.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @sdlc/server test secrets-factory`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/secrets/factory.ts apps/server/src/secrets/index.ts apps/server/test/secrets-factory.test.ts
git commit -m "feat(secrets): createSecretResolver factory + barrel"
```

---

## Task 4: IntegrationRef type + InMemoryIntegrationConfigStore

**Files:**
- Create: `apps/server/src/integrations/types.ts`
- Create: `apps/server/src/integrations/in-memory.ts`
- Test: `apps/server/test/integration-config-store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/integration-config-store.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';

describe('InMemoryIntegrationConfigStore', () => {
  it('defaults to kind "in-memory" when no config exists', async () => {
    const store = new InMemoryIntegrationConfigStore();
    const cfg = await store.getTaskSystemConfig('t1', 'proj-a');
    expect(cfg).toEqual({ kind: 'in-memory', settings: {} });
  });

  it('returns the exact (tenant, project) match', async () => {
    const store = new InMemoryIntegrationConfigStore();
    store.seed('t1', 'proj-a', {
      task_system: { kind: 'azure-devops', secret_ref: 'aws-sm://ado#token', settings: { org: 'acme' } },
    });
    const cfg = await store.getTaskSystemConfig('t1', 'proj-a');
    expect(cfg.kind).toBe('azure-devops');
    expect(cfg.settings).toEqual({ org: 'acme' });
  });

  it('falls back to the tenant default row (project="")', async () => {
    const store = new InMemoryIntegrationConfigStore();
    store.seed('t1', '', { task_system: { kind: 'azure-devops', settings: {} } });
    const cfg = await store.getTaskSystemConfig('t1', 'proj-z');
    expect(cfg.kind).toBe('azure-devops');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sdlc/server test integration-config-store`
Expected: FAIL — cannot find `../src/integrations/in-memory.js`.

- [ ] **Step 3: Write `types.ts`**

Create `apps/server/src/integrations/types.ts`:

```ts
/** A single integration's config: which adapter kind, which secret, and adapter-specific settings. */
export interface IntegrationRef {
  kind: string;
  secret_ref?: string;
  settings: Record<string, unknown>;
}

/** Full per-(tenant, project) integration config. Each field is optional; unset → default. */
export interface IntegrationConfig {
  task_system?: IntegrationRef;
  doc_store?: IntegrationRef;
  pr_provider?: IntegrationRef;
}

export const DEFAULT_TASK_SYSTEM: IntegrationRef = { kind: 'in-memory', settings: {} };

/**
 * Per-(tenant, project) integration config. Resolution always succeeds:
 * exact match → tenant default (project="") → hard-coded default.
 */
export interface IntegrationConfigStore {
  getTaskSystemConfig(tenantId: string, project: string): Promise<IntegrationRef>;
  getDocStoreConfig(tenantId: string, project: string): Promise<IntegrationRef | undefined>;
  getPrProviderConfig(tenantId: string, project: string): Promise<IntegrationRef | undefined>;
}
```

- [ ] **Step 4: Write `in-memory.ts`**

Create `apps/server/src/integrations/in-memory.ts`:

```ts
import {
  DEFAULT_TASK_SYSTEM,
  type IntegrationConfig,
  type IntegrationConfigStore,
  type IntegrationRef,
} from './types.js';

/** In-memory config store for dev/tests. Empty by default → everything resolves to defaults. */
export class InMemoryIntegrationConfigStore implements IntegrationConfigStore {
  private readonly rows = new Map<string, IntegrationConfig>();

  private key(tenantId: string, project: string): string {
    return `${tenantId}::${project}`;
  }

  /** Test/seed helper: set the config for a (tenant, project). project="" is the tenant default. */
  seed(tenantId: string, project: string, config: IntegrationConfig): void {
    this.rows.set(this.key(tenantId, project), config);
  }

  private lookup(tenantId: string, project: string): IntegrationConfig | undefined {
    return this.rows.get(this.key(tenantId, project)) ?? this.rows.get(this.key(tenantId, ''));
  }

  async getTaskSystemConfig(tenantId: string, project: string): Promise<IntegrationRef> {
    return this.lookup(tenantId, project)?.task_system ?? DEFAULT_TASK_SYSTEM;
  }

  async getDocStoreConfig(tenantId: string, project: string): Promise<IntegrationRef | undefined> {
    return this.lookup(tenantId, project)?.doc_store;
  }

  async getPrProviderConfig(tenantId: string, project: string): Promise<IntegrationRef | undefined> {
    return this.lookup(tenantId, project)?.pr_provider;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @sdlc/server test integration-config-store`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/integrations/types.ts apps/server/src/integrations/in-memory.ts apps/server/test/integration-config-store.test.ts
git commit -m "feat(integrations): IntegrationConfigStore + in-memory impl"
```

---

## Task 5: tenant_integrations schema + migration + Postgres store

**Files:**
- Modify: `apps/server/src/state/schema.ts`
- Create: `apps/server/migrations/0003_tenant_integrations.sql`
- Create: `apps/server/src/integrations/postgres.ts`
- Test: `apps/server/test/integration-config-store.integration.test.ts`

- [ ] **Step 1: Add the Drizzle table**

In `apps/server/src/state/schema.ts`, append after the `stories` table:

```ts
export const tenant_integrations = pgTable(
  'tenant_integrations',
  {
    tenant_id: text('tenant_id').notNull(),
    project: text('project').notNull().default(''),
    task_system: jsonb('task_system'),
    doc_store: jsonb('doc_store'),
    pr_provider: jsonb('pr_provider'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenant_id, t.project] }),
  }),
);
```

- [ ] **Step 2: Write the migration**

Create `apps/server/migrations/0003_tenant_integrations.sql`:

```sql
CREATE TABLE IF NOT EXISTS "tenant_integrations" (
  "tenant_id" text NOT NULL,
  "project" text NOT NULL DEFAULT '',
  "task_system" jsonb,
  "doc_store" jsonb,
  "pr_provider" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tenant_integrations_pk" PRIMARY KEY ("tenant_id", "project")
);
```

- [ ] **Step 3: Write the failing integration test**

Create `apps/server/test/integration-config-store.integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { PostgresIntegrationConfigStore } from '../src/integrations/postgres.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe('PostgresIntegrationConfigStore', () => {
  const client = postgres(url!, { max: 2 });
  const store = new PostgresIntegrationConfigStore({ databaseUrl: url!, client });

  beforeAll(async () => {
    await client`DELETE FROM tenant_integrations WHERE tenant_id = 'it-tenant'`;
  });
  afterAll(async () => {
    await client`DELETE FROM tenant_integrations WHERE tenant_id = 'it-tenant'`;
    await client.end({ timeout: 5 });
  });

  it('defaults to in-memory when no row exists', async () => {
    const cfg = await store.getTaskSystemConfig('it-tenant', 'proj-a');
    expect(cfg).toEqual({ kind: 'in-memory', settings: {} });
  });

  it('reads an exact (tenant, project) row', async () => {
    await client`
      INSERT INTO tenant_integrations (tenant_id, project, task_system)
      VALUES ('it-tenant', 'proj-a', ${client.json({ kind: 'azure-devops', settings: { org: 'acme' } })})
    `;
    const cfg = await store.getTaskSystemConfig('it-tenant', 'proj-a');
    expect(cfg.kind).toBe('azure-devops');
    expect(cfg.settings).toEqual({ org: 'acme' });
  });

  it('falls back to the tenant default row (project="")', async () => {
    await client`
      INSERT INTO tenant_integrations (tenant_id, project, task_system)
      VALUES ('it-tenant', '', ${client.json({ kind: 'azure-devops', settings: {} })})
    `;
    const cfg = await store.getTaskSystemConfig('it-tenant', 'proj-unknown');
    expect(cfg.kind).toBe('azure-devops');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @sdlc/server test integration-config-store.integration`
Expected: FAIL — cannot find `../src/integrations/postgres.js` (or SKIP if `TEST_DATABASE_URL` unset — then verify after Step 5 with the DB env set).

- [ ] **Step 5: Write `postgres.ts`**

Create `apps/server/src/integrations/postgres.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import { tenant_integrations } from '../state/schema.js';
import {
  DEFAULT_TASK_SYSTEM,
  type IntegrationConfigStore,
  type IntegrationRef,
} from './types.js';

export interface PostgresIntegrationConfigStoreOptions {
  databaseUrl: string;
  client?: Sql;
}

export class PostgresIntegrationConfigStore implements IntegrationConfigStore {
  private readonly db: PostgresJsDatabase;
  private readonly client: Sql;

  constructor(opts: PostgresIntegrationConfigStoreOptions) {
    this.client = opts.client ?? postgres(opts.databaseUrl, { max: 5 });
    this.db = drizzle(this.client);
  }

  async close(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }

  private async row(tenantId: string, project: string) {
    const exact = await this.db
      .select()
      .from(tenant_integrations)
      .where(and(eq(tenant_integrations.tenant_id, tenantId), eq(tenant_integrations.project, project)))
      .limit(1);
    if (exact[0]) return exact[0];
    const fallback = await this.db
      .select()
      .from(tenant_integrations)
      .where(and(eq(tenant_integrations.tenant_id, tenantId), eq(tenant_integrations.project, '')))
      .limit(1);
    return fallback[0];
  }

  async getTaskSystemConfig(tenantId: string, project: string): Promise<IntegrationRef> {
    const r = await this.row(tenantId, project);
    return (r?.task_system as IntegrationRef | null) ?? DEFAULT_TASK_SYSTEM;
  }

  async getDocStoreConfig(tenantId: string, project: string): Promise<IntegrationRef | undefined> {
    const r = await this.row(tenantId, project);
    return (r?.doc_store as IntegrationRef | null) ?? undefined;
  }

  async getPrProviderConfig(tenantId: string, project: string): Promise<IntegrationRef | undefined> {
    const r = await this.row(tenantId, project);
    return (r?.pr_provider as IntegrationRef | null) ?? undefined;
  }
}
```

- [ ] **Step 6: Run the migration + test against a real DB**

Run:
```bash
docker compose -f infra/compose.yml up -d postgres
TEST_DATABASE_URL="postgres://sdlc:sdlc@localhost:5432/sdlc" \
  pnpm --filter @sdlc/server db:migrate
TEST_DATABASE_URL="postgres://sdlc:sdlc@localhost:5432/sdlc" \
  pnpm --filter @sdlc/server test integration-config-store.integration
```
Expected: migration applies `0003_tenant_integrations`; test PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/state/schema.ts apps/server/migrations/0003_tenant_integrations.sql apps/server/src/integrations/postgres.ts apps/server/test/integration-config-store.integration.test.ts
git commit -m "feat(integrations): tenant_integrations table + Postgres config store"
```

---

## Task 6: createIntegrationConfigStore factory + barrel

**Files:**
- Create: `apps/server/src/integrations/factory.ts`
- Create: `apps/server/src/integrations/index.ts`
- Test: `apps/server/test/integration-config-factory.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/integration-config-factory.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createIntegrationConfigStore } from '../src/integrations/index.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';

describe('createIntegrationConfigStore', () => {
  it('returns in-memory store when databaseUrl is undefined', () => {
    const handle = createIntegrationConfigStore({ databaseUrl: undefined });
    expect(handle.store).toBeInstanceOf(InMemoryIntegrationConfigStore);
    expect(handle.kind).toBe('in-memory');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sdlc/server test integration-config-factory`
Expected: FAIL — cannot find `../src/integrations/index.js`.

- [ ] **Step 3: Write `factory.ts`**

Create `apps/server/src/integrations/factory.ts`:

```ts
import { InMemoryIntegrationConfigStore } from './in-memory.js';
import { PostgresIntegrationConfigStore } from './postgres.js';
import type { IntegrationConfigStore } from './types.js';

export interface CreateIntegrationConfigStoreOptions {
  databaseUrl?: string | undefined;
}

export interface IntegrationConfigStoreHandle {
  store: IntegrationConfigStore;
  kind: 'in-memory' | 'postgres';
  close: () => Promise<void>;
}

/** Selects the config store impl based on DATABASE_URL (mirrors createFlowStore). */
export function createIntegrationConfigStore(
  opts: CreateIntegrationConfigStoreOptions,
): IntegrationConfigStoreHandle {
  if (opts.databaseUrl) {
    const pg = new PostgresIntegrationConfigStore({ databaseUrl: opts.databaseUrl });
    return { store: pg, kind: 'postgres', close: () => pg.close() };
  }
  return { store: new InMemoryIntegrationConfigStore(), kind: 'in-memory', close: async () => {} };
}
```

- [ ] **Step 4: Write `index.ts`**

Create `apps/server/src/integrations/index.ts`:

```ts
export * from './types.js';
export * from './in-memory.js';
export * from './postgres.js';
export * from './factory.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @sdlc/server test integration-config-factory`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/integrations/factory.ts apps/server/src/integrations/index.ts apps/server/test/integration-config-factory.test.ts
git commit -m "feat(integrations): config store factory + barrel"
```

---

## Task 7: TaskSystemProvider + ConfigBackedTaskSystemProvider

**Files:**
- Create: `apps/server/src/adapters/task-system-provider.ts`
- Modify: `apps/server/src/adapters/index.ts`
- Test: `apps/server/test/task-system-provider.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/task-system-provider.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Flow } from '@sdlc/core';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';
import {
  ConfigBackedTaskSystemProvider,
  NotImplementedError,
} from '../src/adapters/task-system-provider.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';

const FLOW = { flow_id: 't1:proj-a:slug', tenant_id: 't1', project: 'proj-a' } as Flow;

function ctx(resolveSecret: TenantCtx['resolveSecret']): TenantCtx {
  return { tenantId: 't1', userId: 'u', roles: [], resolveSecret };
}

describe('ConfigBackedTaskSystemProvider', () => {
  it('returns the shared in-memory adapter by default', async () => {
    const inMemory = new InMemoryTaskSystemAdapter();
    const provider = new ConfigBackedTaskSystemProvider({
      configStore: new InMemoryIntegrationConfigStore(),
      inMemory,
    });
    const resolved = await provider.resolve(ctx(async () => 'x'), FLOW);
    expect(resolved).toBe(inMemory);
  });

  it('resolves the secret-ref then throws NotImplementedError for azure-devops', async () => {
    const configStore = new InMemoryIntegrationConfigStore();
    configStore.seed('t1', 'proj-a', {
      task_system: { kind: 'azure-devops', secret_ref: 'aws-sm://ado#token', settings: {} },
    });
    const provider = new ConfigBackedTaskSystemProvider({
      configStore,
      inMemory: new InMemoryTaskSystemAdapter(),
    });
    const seen: string[] = [];
    await expect(
      provider.resolve(
        ctx(async (ref) => {
          seen.push(ref);
          return 'secret';
        }),
        FLOW,
      ),
    ).rejects.toBeInstanceOf(NotImplementedError);
    expect(seen).toEqual(['aws-sm://ado#token']);
  });

  it('throws on an unknown kind', async () => {
    const configStore = new InMemoryIntegrationConfigStore();
    configStore.seed('t1', 'proj-a', { task_system: { kind: 'jira', settings: {} } });
    const provider = new ConfigBackedTaskSystemProvider({
      configStore,
      inMemory: new InMemoryTaskSystemAdapter(),
    });
    await expect(provider.resolve(ctx(async () => 'x'), FLOW)).rejects.toThrow(/unknown task_system kind: jira/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sdlc/server test task-system-provider`
Expected: FAIL — cannot find `../src/adapters/task-system-provider.js`.

- [ ] **Step 3: Write `task-system-provider.ts`**

Create `apps/server/src/adapters/task-system-provider.ts`:

```ts
import type { Flow } from '@sdlc/core';
import type { TaskSystemAdapter, TenantCtx } from '@sdlc/adapters-contracts';
import type { IntegrationConfigStore } from '../integrations/types.js';
import type { InMemoryTaskSystemAdapter } from './in-memory-task-system.js';

/** Thrown when a configured adapter kind is recognised but not yet built (a later slice). */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

/** Selects + builds the TaskSystemAdapter for a given flow at call time. */
export interface TaskSystemProvider {
  resolve(ctx: TenantCtx, flow: Flow): Promise<TaskSystemAdapter>;
}

export interface ConfigBackedTaskSystemProviderDeps {
  configStore: IntegrationConfigStore;
  /** Shared fake used for the default `in-memory` kind (tests/dev). */
  inMemory: InMemoryTaskSystemAdapter;
}

export class ConfigBackedTaskSystemProvider implements TaskSystemProvider {
  constructor(private readonly deps: ConfigBackedTaskSystemProviderDeps) {}

  async resolve(ctx: TenantCtx, flow: Flow): Promise<TaskSystemAdapter> {
    const cfg = await this.deps.configStore.getTaskSystemConfig(ctx.tenantId, flow.project);
    switch (cfg.kind) {
      case 'in-memory':
        return this.deps.inMemory;
      case 'azure-devops': {
        // Prove the credential path now; the real adapter lands in Slice 2.
        if (cfg.secret_ref) await ctx.resolveSecret(cfg.secret_ref);
        throw new NotImplementedError('azure-devops task system arrives in Slice 2');
      }
      default:
        throw new Error(`unknown task_system kind: ${cfg.kind}`);
    }
  }
}
```

- [ ] **Step 4: Update the adapters barrel**

In `apps/server/src/adapters/index.ts`, add the export line:

```ts
export * from './in-memory-task-system.js';
export * from './factory.js';
export * from './task-system-provider.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @sdlc/server test task-system-provider`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/adapters/task-system-provider.ts apps/server/src/adapters/index.ts apps/server/test/task-system-provider.test.ts
git commit -m "feat(adapters): ConfigBackedTaskSystemProvider with call-time selection"
```

---

## Task 8: Refactor registry + 7 tools to resolve via provider

**Files:**
- Modify: `apps/server/src/mcp/tools/index.ts`
- Modify: `apps/server/src/mcp/tools/{create-epic,create-stories,link-subtasks,claim-story,report-progress,submit-qa-results,block-story}.ts`
- Modify: existing tests that call `buildToolRegistry`

- [ ] **Step 1: Find every call site of buildToolRegistry**

Run:
```bash
grep -rln "buildToolRegistry" apps/server/test apps/server/src
```
Expected: a list including `apps/server/src/index.ts`, `apps/server/src/mcp-stdio.ts`, and several `apps/server/test/*.test.ts`. Note them — every test call site is updated in Step 5; bootstrap call sites are handled in Task 9.

- [ ] **Step 2: Change `BuildRegistryDeps` and the 7 wirings**

In `apps/server/src/mcp/tools/index.ts`:

Replace the import:
```ts
import type { TenantCtx, TaskSystemAdapter } from '@sdlc/adapters-contracts';
```
with:
```ts
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { TaskSystemProvider } from '../../adapters/task-system-provider.js';
```

Replace the `BuildRegistryDeps` interface:
```ts
export interface BuildRegistryDeps {
  catalog: Catalog;
  store: FlowStore;
  taskSystemProvider: TaskSystemProvider;
}
```

Replace the destructure and the 7 tool wirings inside `buildToolRegistry`:
```ts
  const { catalog, store, taskSystemProvider } = deps;
```
and change these 7 lines to pass `taskSystemProvider` instead of `taskSystem`:
```ts
    makeCreateEpicTool(store, taskSystemProvider) as unknown as ToolDef,
    makeCreateStoriesTool(store, taskSystemProvider) as unknown as ToolDef,
    makeLinkSubtasksTool(store, taskSystemProvider) as unknown as ToolDef,
    makeClaimStoryTool(store, taskSystemProvider, catalog) as unknown as ToolDef,
    makeReportProgressTool(store, taskSystemProvider) as unknown as ToolDef,
    makeSubmitQaResultsTool(store, taskSystemProvider) as unknown as ToolDef,
    makeBlockStoryTool(store, taskSystemProvider) as unknown as ToolDef,
```
(The other 14 wirings are unchanged.)

- [ ] **Step 3: Refactor each of the 7 tools**

For each tool the change is identical in shape: (a) change the factory's second param type from `taskSystem: TaskSystemAdapter` to `taskSystemProvider: TaskSystemProvider`, (b) update the import, (c) inside the handler, after the `flow` variable is known and tenant-checked, add `const taskSystem = await taskSystemProvider.resolve(ctx, flow);` before the first `taskSystem.*` call. The body already references `taskSystem`, so no further edits.

**`create-epic.ts`** — replace import line:
```ts
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { TaskSystemProvider } from '../../adapters/task-system-provider.js';
```
Change signature:
```ts
export function makeCreateEpicTool(store: FlowStore, taskSystemProvider: TaskSystemProvider) {
```
Insert immediately before `const ref = await taskSystem.createEpic(`:
```ts
      const taskSystem = await taskSystemProvider.resolve(ctx, flow);
```

**`create-stories.ts`** — same import + signature change:
```ts
export function makeCreateStoriesTool(store: FlowStore, taskSystemProvider: TaskSystemProvider) {
```
Insert immediately after the `flow` fetch + tenant check (before the loop that calls `taskSystem.createStory`):
```ts
      const taskSystem = await taskSystemProvider.resolve(ctx, flow);
```

**`link-subtasks.ts`** — same import + signature change:
```ts
export function makeLinkSubtasksTool(store: FlowStore, taskSystemProvider: TaskSystemProvider) {
```
Insert after the `flow` fetch + tenant check (before the first `taskSystem.createSubtask`):
```ts
      const taskSystem = await taskSystemProvider.resolve(ctx, flow);
```

**`claim-story.ts`** — change signature (keep the `catalog` 3rd param):
```ts
export function makeClaimStoryTool(
  store: FlowStore,
  taskSystemProvider: TaskSystemProvider,
  catalog: Catalog,
) {
```
Update the import (replace `TaskSystemAdapter` with the provider import as above). Insert before `await taskSystem.transition(story.external_id, 'Active', ctx);`, after `flow` is fetched and validated:
```ts
      const taskSystem = await taskSystemProvider.resolve(ctx, flow);
```

**`report-progress.ts`** — signature:
```ts
export function makeReportProgressTool(store: FlowStore, taskSystemProvider: TaskSystemProvider) {
```
Insert before `await taskSystem.transition(story.external_id, adoStatus, ctx);`:
```ts
      const taskSystem = await taskSystemProvider.resolve(ctx, flow);
```

**`submit-qa-results.ts`** — signature:
```ts
export function makeSubmitQaResultsTool(store: FlowStore, taskSystemProvider: TaskSystemProvider) {
```
Insert before `await taskSystem.transition(story.external_id, adoStatus, ctx);`:
```ts
      const taskSystem = await taskSystemProvider.resolve(ctx, flow);
```

**`block-story.ts`** — signature:
```ts
export function makeBlockStoryTool(store: FlowStore, taskSystemProvider: TaskSystemProvider) {
```
Insert before `await taskSystem.transition(story.external_id, 'Active', ctx);`:
```ts
      const taskSystem = await taskSystemProvider.resolve(ctx, flow);
```

> For each tool, if `flow` could be `undefined` per existing guards, place the `resolve` call AFTER the existing `if (!flow) return ...` check so `flow` is narrowed to non-null. Every one of these 7 tools already has that guard before the `taskSystem.*` call.

- [ ] **Step 4: Update the import in each refactored tool**

In `create-stories.ts`, `link-subtasks.ts`, `claim-story.ts`, `report-progress.ts`, `submit-qa-results.ts`, `block-story.ts`, replace the `TaskSystemAdapter` import with:
```ts
import type { TaskSystemProvider } from '../../adapters/task-system-provider.js';
```
Keep `TenantCtx` (and, where present, `ExternalRef`) imports from `@sdlc/adapters-contracts`. For example `create-stories.ts`'s line:
```ts
import type { ExternalRef, TaskSystemAdapter, TenantCtx } from '@sdlc/adapters-contracts';
```
becomes:
```ts
import type { ExternalRef, TenantCtx } from '@sdlc/adapters-contracts';
import type { TaskSystemProvider } from '../../adapters/task-system-provider.js';
```

- [ ] **Step 5: Update every test call site**

For each test file found in Step 1 that calls `buildToolRegistry`, replace the adapter construction. Where a test currently has:
```ts
const taskSystem = new InMemoryTaskSystemAdapter();
const registry = buildToolRegistry({ catalog, store, taskSystem });
```
change it to:
```ts
const taskSystem = new InMemoryTaskSystemAdapter();
const taskSystemProvider = new ConfigBackedTaskSystemProvider({
  configStore: new InMemoryIntegrationConfigStore(),
  inMemory: taskSystem,
});
const registry = buildToolRegistry({ catalog, store, taskSystemProvider });
```
and add the imports at the top of each such test file:
```ts
import { ConfigBackedTaskSystemProvider } from '../src/adapters/task-system-provider.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
```
The empty config store resolves to `in-memory` → returns the same `taskSystem` instance, so existing assertions on adapter state still hold.

- [ ] **Step 6: Run the full server test suite**

Run: `pnpm --filter @sdlc/server test`
Expected: PASS — all pre-existing tests plus the new ones (Postgres integration tests SKIP without `TEST_DATABASE_URL`). If a test fails on `taskSystem` being undefined, that call site was missed in Step 5 — fix and re-run.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @sdlc/server typecheck`
Expected: no errors. (Catches any tool whose import or signature wasn't updated.)

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/mcp/tools apps/server/test
git commit -m "refactor(tools): resolve task-system adapter via provider at call time"
```

---

## Task 9: Bootstrap wiring (config + auth + entrypoints)

**Files:**
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/auth/api-key.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/mcp-stdio.ts`
- Test: `apps/server/test/config.test.ts` (create if absent)

- [ ] **Step 1: Add `secretsBackend` to config (failing test)**

Create/extend `apps/server/test/config.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig secretsBackend', () => {
  afterEach(() => {
    delete process.env.SECRETS_BACKEND;
  });

  it('defaults to "env"', () => {
    expect(loadConfig().secretsBackend).toBe('env');
  });

  it('reads SECRETS_BACKEND=aws', () => {
    process.env.SECRETS_BACKEND = 'aws';
    expect(loadConfig().secretsBackend).toBe('aws');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sdlc/server test config`
Expected: FAIL — `secretsBackend` is undefined.

- [ ] **Step 3: Extend `config.ts`**

In `apps/server/src/config.ts`, add to `ConfigSchema`:
```ts
  secretsBackend: z.enum(['aws', 'env']).default('env'),
```
and in `loadConfig()`'s parsed object:
```ts
    secretsBackend: process.env.SECRETS_BACKEND,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sdlc/server test config`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the resolver into auth**

In `apps/server/src/auth/api-key.ts`:

Add an import:
```ts
import type { SecretResolver } from '../secrets/index.js';
```
Change `createApiKeyAuth` to accept a resolver:
```ts
export function createApiKeyAuth(entries: ApiKeyEntry[], secretResolver: SecretResolver) {
  const byKey = new Map(entries.map((e) => [e.apiKey, e.tenantId] as const));

  return function authenticate(req: AuthRequestLike): TenantCtx {
    // ... unchanged header parsing ...
    return {
      tenantId,
      userId,
      roles,
      resolveSecret: (ref: string) => secretResolver.resolve(ref),
    };
  };
}
```
(Replace the old stub `async resolveSecret(_ref) { throw ... }` with the delegating line above.)

- [ ] **Step 6: Wire index.ts**

In `apps/server/src/index.ts`:

Add imports:
```ts
import { createSecretResolver } from './secrets/index.js';
import { createIntegrationConfigStore } from './integrations/index.js';
import { InMemoryTaskSystemAdapter, ConfigBackedTaskSystemProvider } from './adapters/index.js';
```
Replace the adapter + registry bootstrap (currently `const taskSystem = makeTaskSystemAdapter(); const registry = buildToolRegistry({ catalog, store: storeHandle.store, taskSystem });`) with:
```ts
  const secretResolver = createSecretResolver(config.secretsBackend);
  const integrationConfig = createIntegrationConfigStore({ databaseUrl: config.databaseUrl });
  const taskSystemProvider = new ConfigBackedTaskSystemProvider({
    configStore: integrationConfig.store,
    inMemory: new InMemoryTaskSystemAdapter(),
  });
  const registry = buildToolRegistry({
    catalog,
    store: storeHandle.store,
    taskSystemProvider,
  });
```
Update the `authenticate` construction to pass the resolver. Find where `createApiKeyAuth(...)` is called and add the second arg:
```ts
  const authenticate = createApiKeyAuth(parseApiKeys(config.apiKeys), secretResolver);
```
In the shutdown handler, also close the config store handle alongside the existing `storeHandle.close()`:
```ts
    await integrationConfig.close();
```

- [ ] **Step 7: Wire mcp-stdio.ts**

In `apps/server/src/mcp-stdio.ts`, mirror Step 6: build `secretResolver` (`createSecretResolver(config.secretsBackend)`), `integrationConfig`, and `taskSystemProvider`; pass `taskSystemProvider` into `buildToolRegistry`; and replace the inline `resolveSecret` stub in the `ctx` object with `resolveSecret: (ref) => secretResolver.resolve(ref)`.

- [ ] **Step 8: Typecheck + full build + test**

Run:
```bash
pnpm --filter @sdlc/server typecheck
pnpm turbo run build
pnpm --filter @sdlc/server test
```
Expected: typecheck clean, build succeeds, all tests pass (Postgres integration SKIP without `TEST_DATABASE_URL`).

- [ ] **Step 9: Smoke the dev server boots**

Run (no DATABASE_URL → in-memory everything):
```bash
API_KEYS="demo-tenant:dev-key-12345" pnpm --filter @sdlc/server dev &
sleep 3
curl -s localhost:3000/health
kill %1
```
Expected: `/health` returns JSON with `"store":"in-memory"`; no "Secret resolver not configured" error path remains.

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/config.ts apps/server/src/auth/api-key.ts apps/server/src/index.ts apps/server/src/mcp-stdio.ts apps/server/test/config.test.ts
git commit -m "feat(server): wire SecretResolver + TaskSystemProvider into bootstrap"
```

---

## Task 10: Docs touch-up

**Files:**
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Note the new selection layer**

In `docs/ARCHITECTURE.md`, under "Estado actual", add a bullet:
```markdown
- **Selección de adapters por tenant/proyecto** — `IntegrationConfigStore` (`tenant_integrations`) + `ConfigBackedTaskSystemProvider` resuelven el adapter en tiempo de llamada. `SecretResolver` (AWS Secrets Manager / env) respalda `ctx.resolveSecret`. Los adapters reales (ADO Boards / Drive / PRs) llegan en los Slices 2–4.
```

- [ ] **Step 2: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: note adapter selection + secret resolution layer (slice 1)"
```

---

## Self-Review Notes

- **Spec coverage:** SecretResolver/AWS SM (T1–T3) · IntegrationConfigStore Postgres+in-memory + table (T4–T6) · TaskSystemProvider w/ call-time selection, secret-path proof, NotImplementedError for real kinds (T7) · tool refactor to resolve via provider (T8) · `resolveSecret` wiring replacing the stub + `secretsBackend` config (T9) · default `in-memory` keeps the ~105 existing tests green (T8 Step 5–6). Error handling (SecretResolutionError, unknown kind, NotImplementedError) covered in T1/T2/T7. Out-of-scope items (ADO/Drive/PR adapters) intentionally not implemented.
- **Type consistency:** `IntegrationRef` ({kind, secret_ref?, settings}) used identically in types/in-memory/postgres/provider. `getTaskSystemConfig` signature stable across interface + both impls. `ConfigBackedTaskSystemProvider` deps `{ configStore, inMemory }` consistent in provider + tests + bootstrap. `createSecretResolver(backend)` returns `SecretResolver` used by auth.
- **No placeholders:** every code step shows full content; the 7-tool refactor spells out each signature + insertion point rather than "similar to above".
