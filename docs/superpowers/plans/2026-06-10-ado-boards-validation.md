# Azure DevOps Boards — Integration Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it possible to populate `tenant_integrations` from a versioned config file and run the Azure DevOps Boards integration end-to-end against real ADO, with secrets in AWS Secrets Manager.

**Architecture:** A pure config parser + a Drizzle upsert in `apps/server/src/integrations/seed.ts`, driven by a thin CLI `apps/server/scripts/seed-integrations.ts` (`pnpm seed:integrations <file>`). Plus infra wiring: an example config, a `.env.example` update, an AWS-mode compose file, and an operational runbook. No code changes to the running server (the `SecretResolver` already uses the default AWS credential chain).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, Drizzle ORM + postgres-js, zod, tsx (CLI runner, same as `db:migrate`), docker compose.

**Spec:** `docs/superpowers/specs/2026-06-10-ado-boards-validation-design.md`

---

## File Structure

**Create:**
- `apps/server/src/integrations/seed.ts` — `IntegrationsConfigSchema` (zod), `parseIntegrationsConfig(raw)`, `seedIntegrations(db, config)`. Pure + DB logic, importable/testable (no top-level side effects).
- `apps/server/scripts/seed-integrations.ts` — CLI: read file path arg + `DATABASE_URL`, parse, connect, seed, print, exit. Mirrors `scripts/migrate.ts`.
- `apps/server/test/seed-integrations.test.ts` — unit tests for `parseIntegrationsConfig`.
- `apps/server/test/seed-integrations.integration.test.ts` — gated on `TEST_DATABASE_URL`: upsert + read-back + idempotency.
- `infra/integrations.example.json` — example with 5 projects (only `secret_ref`, never a PAT).
- `infra/compose.aws.yml` — AWS-mode server (SECRETS_BACKEND=aws), reuses the `compose.yml` Postgres.
- `docs/runbook-ado-validation.md` — operational runbook.

**Modify:**
- `apps/server/package.json` — add `"seed:integrations": "tsx scripts/seed-integrations.ts"`.
- `.gitignore` — ignore `infra/integrations.json`.
- `apps/server/.env.example` — document `SECRETS_BACKEND`, `AWS_REGION`, `DATABASE_URL`, AWS creds.

**No DB migration.** `tenant_integrations` (migration `0003`) already exists with columns `tenant_id`, `project` (default `''`), `task_system`/`doc_store`/`pr_provider` (nullable jsonb), `created_at`/`updated_at`, PK `(tenant_id, project)`.

---

## Task 1: Config parser (zod) + unit tests

**Files:**
- Create: `apps/server/src/integrations/seed.ts` (parser portion)
- Test: `apps/server/test/seed-integrations.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/seed-integrations.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseIntegrationsConfig } from '../src/integrations/seed.js';

const VALID = {
  tenants: [
    {
      tenant_id: 'acme',
      projects: [
        {
          project: 'checkout',
          task_system: {
            kind: 'azure-devops',
            secret_ref: 'aws-sm://sdlc/ado-pat#token',
            settings: { org: 'acme', project: 'Checkout' },
          },
        },
      ],
    },
  ],
};

describe('parseIntegrationsConfig', () => {
  it('accepts a valid config and defaults settings to {}', () => {
    const cfg = parseIntegrationsConfig(VALID);
    expect(cfg.tenants[0]!.projects[0]!.task_system!.settings).toEqual({
      org: 'acme',
      project: 'Checkout',
    });
  });

  it('defaults missing settings to {}', () => {
    const cfg = parseIntegrationsConfig({
      tenants: [
        { tenant_id: 't', projects: [{ project: 'p', task_system: { kind: 'azure-devops' } }] },
      ],
    });
    expect(cfg.tenants[0]!.projects[0]!.task_system!.settings).toEqual({});
  });

  it('rejects a project with no integration refs', () => {
    expect(() =>
      parseIntegrationsConfig({ tenants: [{ tenant_id: 't', projects: [{ project: 'p' }] }] }),
    ).toThrow(/at least one/i);
  });

  it('rejects a ref with an empty kind', () => {
    expect(() =>
      parseIntegrationsConfig({
        tenants: [{ tenant_id: 't', projects: [{ project: 'p', task_system: { kind: '' } }] }],
      }),
    ).toThrow();
  });

  it('rejects a missing tenant_id', () => {
    expect(() =>
      parseIntegrationsConfig({ tenants: [{ projects: [{ project: 'p' }] }] }),
    ).toThrow();
  });

  it('rejects an empty tenants array', () => {
    expect(() => parseIntegrationsConfig({ tenants: [] })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sdlc/server test seed-integrations`
Expected: FAIL — cannot find `../src/integrations/seed.js`.

- [ ] **Step 3: Write the parser**

Create `apps/server/src/integrations/seed.ts`:

```ts
import { z } from 'zod';

const IntegrationRefSchema = z.object({
  kind: z.string().min(1),
  secret_ref: z.string().min(1).optional(),
  settings: z.record(z.unknown()).default({}),
});

const ProjectSchema = z
  .object({
    project: z.string().min(1),
    task_system: IntegrationRefSchema.optional(),
    doc_store: IntegrationRefSchema.optional(),
    pr_provider: IntegrationRefSchema.optional(),
  })
  .refine((p) => p.task_system ?? p.doc_store ?? p.pr_provider, {
    message: 'project must define at least one of task_system, doc_store, or pr_provider',
  });

export const IntegrationsConfigSchema = z.object({
  tenants: z
    .array(
      z.object({
        tenant_id: z.string().min(1),
        projects: z.array(ProjectSchema).min(1),
      }),
    )
    .min(1),
});

export type IntegrationsConfig = z.infer<typeof IntegrationsConfigSchema>;

/** Validates raw (parsed-JSON) input. Throws ZodError on any problem. */
export function parseIntegrationsConfig(raw: unknown): IntegrationsConfig {
  return IntegrationsConfigSchema.parse(raw);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @sdlc/server test seed-integrations`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/integrations/seed.ts apps/server/test/seed-integrations.test.ts
git commit -m "feat(integrations): config parser for tenant_integrations seeding"
```

---

## Task 2: Upsert logic + integration test + CLI

**Files:**
- Modify: `apps/server/src/integrations/seed.ts` (add `seedIntegrations`)
- Create: `apps/server/test/seed-integrations.integration.test.ts`
- Create: `apps/server/scripts/seed-integrations.ts`
- Modify: `apps/server/package.json`

- [ ] **Step 1: Write the failing integration test**

Create `apps/server/test/seed-integrations.integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { seedIntegrations } from '../src/integrations/seed.js';
import { PostgresIntegrationConfigStore } from '../src/integrations/postgres.js';

const url = process.env.TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe('seedIntegrations (integration)', () => {
  const client = postgres(url!, { max: 2 });
  const db = drizzle(client);
  const store = new PostgresIntegrationConfigStore({ databaseUrl: url!, client });

  beforeAll(async () => {
    await client`DELETE FROM tenant_integrations WHERE tenant_id = 'seed-it'`;
  });
  afterAll(async () => {
    await client`DELETE FROM tenant_integrations WHERE tenant_id = 'seed-it'`;
    await client.end({ timeout: 5 });
  });

  const cfg = {
    tenants: [
      {
        tenant_id: 'seed-it',
        projects: [
          {
            project: 'checkout',
            task_system: {
              kind: 'azure-devops',
              secret_ref: 'aws-sm://sdlc/ado-pat#token',
              settings: { org: 'acme', project: 'Checkout' },
            },
          },
        ],
      },
    ],
  };

  it('upserts a row that the config store then reads back', async () => {
    const res = await seedIntegrations(db, cfg);
    expect(res.created).toContain('seed-it/checkout');
    const ref = await store.getTaskSystemConfig('seed-it', 'checkout');
    expect(ref.kind).toBe('azure-devops');
    expect(ref.settings).toEqual({ org: 'acme', project: 'Checkout' });
  });

  it('is idempotent — second run updates, does not duplicate', async () => {
    const updated = {
      tenants: [
        {
          tenant_id: 'seed-it',
          projects: [
            {
              project: 'checkout',
              task_system: {
                kind: 'azure-devops',
                secret_ref: 'aws-sm://sdlc/ado-pat#token',
                settings: { org: 'acme', project: 'CheckoutV2' },
              },
            },
          ],
        },
      ],
    };
    const res = await seedIntegrations(db, updated);
    expect(res.updated).toContain('seed-it/checkout');
    const rows = await client`
      SELECT count(*)::int AS n FROM tenant_integrations
      WHERE tenant_id = 'seed-it' AND project = 'checkout'
    `;
    expect(rows[0]!.n).toBe(1);
    const ref = await store.getTaskSystemConfig('seed-it', 'checkout');
    expect(ref.settings).toEqual({ org: 'acme', project: 'CheckoutV2' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @sdlc/server test seed-integrations.integration`
Expected: FAIL — `seedIntegrations` is not exported (or SKIP without `TEST_DATABASE_URL`; verify against a DB after Step 3).

- [ ] **Step 3: Add `seedIntegrations` to `apps/server/src/integrations/seed.ts`**

Append these imports at the top of `seed.ts` (keep the existing `import { z }`):

```ts
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { tenant_integrations } from '../state/schema.js';
import type { IntegrationRef } from './types.js';
```

Append at the end of `seed.ts`:

```ts
export interface SeedResult {
  created: string[];
  updated: string[];
}

/**
 * Upserts one `tenant_integrations` row per (tenant, project) in the config.
 * The file is canonical for each row: omitted refs are written as NULL.
 * Returns which `tenant/project` labels were created vs updated.
 */
export async function seedIntegrations(
  db: PostgresJsDatabase,
  config: IntegrationsConfig,
): Promise<SeedResult> {
  const created: string[] = [];
  const updated: string[] = [];

  // Classify created vs updated by checking existing keys first.
  for (const tenant of config.tenants) {
    for (const proj of tenant.projects) {
      const label = `${tenant.tenant_id}/${proj.project}`;
      const existing = await db
        .select({ p: tenant_integrations.project })
        .from(tenant_integrations)
        .where(
          and(
            eq(tenant_integrations.tenant_id, tenant.tenant_id),
            eq(tenant_integrations.project, proj.project),
          ),
        )
        .limit(1);

      const values = {
        tenant_id: tenant.tenant_id,
        project: proj.project,
        task_system: (proj.task_system as IntegrationRef | undefined) ?? null,
        doc_store: (proj.doc_store as IntegrationRef | undefined) ?? null,
        pr_provider: (proj.pr_provider as IntegrationRef | undefined) ?? null,
      };

      await db
        .insert(tenant_integrations)
        .values(values)
        .onConflictDoUpdate({
          target: [tenant_integrations.tenant_id, tenant_integrations.project],
          set: {
            task_system: values.task_system,
            doc_store: values.doc_store,
            pr_provider: values.pr_provider,
            updated_at: new Date(),
          },
        });

      if (existing[0]) updated.push(label);
      else created.push(label);
    }
  }

  return { created, updated };
}
```

Also add `and, eq` to the imports — change the top of `seed.ts` so the drizzle helpers are imported:

```ts
import { and, eq } from 'drizzle-orm';
```

(Final `seed.ts` import block: `import { z } from 'zod';`, `import { and, eq } from 'drizzle-orm';`, `import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';`, `import { tenant_integrations } from '../state/schema.js';`, `import type { IntegrationRef } from './types.js';`.)

- [ ] **Step 4: Run the integration test against a real DB**

Run:
```bash
docker compose -f infra/compose.yml up -d postgres
DATABASE_URL="postgres://sdlc:sdlc@localhost:5432/sdlc" pnpm --filter @sdlc/server db:migrate
TEST_DATABASE_URL="postgres://sdlc:sdlc@localhost:5432/sdlc" \
  pnpm --filter @sdlc/server test seed-integrations.integration
```
Expected: PASS (2 tests). (Without `TEST_DATABASE_URL` it SKIPs.)

- [ ] **Step 5: Write the CLI**

Create `apps/server/scripts/seed-integrations.ts`:

```ts
#!/usr/bin/env tsx
/**
 * Upserts tenant_integrations rows from a JSON config file.
 * Usage: DATABASE_URL=... tsx scripts/seed-integrations.ts <path-to-config.json>
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { parseIntegrationsConfig, seedIntegrations } from '../src/integrations/seed.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required to seed integrations.');
  process.exit(1);
}

const fileArg = process.argv[2];
if (!fileArg) {
  console.error('Usage: pnpm --filter @sdlc/server seed:integrations <path-to-config.json>');
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });

async function run() {
  const raw = await readFile(resolve(fileArg!), 'utf8');
  const config = parseIntegrationsConfig(JSON.parse(raw));
  const db = drizzle(sql);
  const { created, updated } = await seedIntegrations(db, config);
  for (const c of created) console.log(`+ created ${c}`);
  for (const u of updated) console.log(`~ updated ${u}`);
  console.log(`done — ${created.length} created, ${updated.length} updated.`);
}

try {
  await run();
} catch (err) {
  console.error('seed failed:', err);
  process.exit(1);
} finally {
  await sql.end({ timeout: 5 });
}
```

- [ ] **Step 6: Add the package.json script**

In `apps/server/package.json`, add to `"scripts"` (next to `"db:migrate"`):

```json
    "seed:integrations": "tsx scripts/seed-integrations.ts",
```

- [ ] **Step 7: Typecheck + full suite**

Run:
```bash
pnpm --filter @sdlc/server typecheck
pnpm --filter @sdlc/server test
```
Expected: typecheck clean; full suite green (the new integration test SKIPs without `TEST_DATABASE_URL`).

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/integrations/seed.ts apps/server/scripts/seed-integrations.ts apps/server/package.json apps/server/test/seed-integrations.integration.test.ts
git commit -m "feat(integrations): seedIntegrations upsert + seed:integrations CLI"
```

---

## Task 3: Example config + gitignore

**Files:**
- Create: `infra/integrations.example.json`
- Modify: `.gitignore`

- [ ] **Step 1: Create the example config**

Create `infra/integrations.example.json` (5 projects, one ADO org + one PAT secret; copy to `infra/integrations.json` and edit the real org/board names):

```json
{
  "tenants": [
    {
      "tenant_id": "acme",
      "projects": [
        {
          "project": "tribu-1",
          "task_system": {
            "kind": "azure-devops",
            "secret_ref": "aws-sm://sdlc/ado-pat#token",
            "settings": { "org": "acme", "project": "Tribu 1 Board" }
          }
        },
        {
          "project": "tribu-2",
          "task_system": {
            "kind": "azure-devops",
            "secret_ref": "aws-sm://sdlc/ado-pat#token",
            "settings": { "org": "acme", "project": "Tribu 2 Board" }
          }
        },
        {
          "project": "tribu-3",
          "task_system": {
            "kind": "azure-devops",
            "secret_ref": "aws-sm://sdlc/ado-pat#token",
            "settings": { "org": "acme", "project": "Tribu 3 Board" }
          }
        },
        {
          "project": "tribu-4",
          "task_system": {
            "kind": "azure-devops",
            "secret_ref": "aws-sm://sdlc/ado-pat#token",
            "settings": { "org": "acme", "project": "Tribu 4 Board" }
          }
        },
        {
          "project": "tribu-5",
          "task_system": {
            "kind": "azure-devops",
            "secret_ref": "aws-sm://sdlc/ado-pat#token",
            "settings": { "org": "acme", "project": "Tribu 5 Board" }
          }
        }
      ]
    }
  ]
}
```

- [ ] **Step 2: Ignore the real config**

Append to `.gitignore`:

```
# Real integration config (holds org/board names; secrets stay in AWS SM)
infra/integrations.json
```

- [ ] **Step 3: Smoke-validate the example parses**

Run:
```bash
DATABASE_URL="postgres://sdlc:sdlc@localhost:5432/sdlc" \
  pnpm --filter @sdlc/server seed:integrations infra/integrations.example.json
```
Expected: with Postgres up + migrated, prints `+ created acme/tribu-1 … tribu-5` then `done — 5 created, 0 updated.` (Re-running prints 5 updated.) If you don't want these demo rows, delete them: `psql "$DATABASE_URL" -c "DELETE FROM tenant_integrations WHERE tenant_id='acme';"`.

- [ ] **Step 4: Commit**

```bash
git add infra/integrations.example.json .gitignore
git commit -m "chore(infra): example integrations config + ignore the real one"
```

---

## Task 4: .env.example + AWS-mode compose

**Files:**
- Modify: `apps/server/.env.example`
- Create: `infra/compose.aws.yml`

- [ ] **Step 1: Update `.env.example`**

Replace the contents of `apps/server/.env.example` with:

```dotenv
# Server runtime
PORT=3000
HOST=0.0.0.0
LOG_LEVEL=info

# Catalog override (defaults to the bundled @sdlc/catalog package).
# CATALOG_ROOT=/abs/path/to/packages/catalog

# Bootstrap auth: comma-separated tenant_id:api_key pairs.
# Example: corp-team-a:dev-key-aaaa,corp-team-b:dev-key-bbbb
API_KEYS=demo-tenant:dev-key-12345

# Persistence: if set, PostgresFlowStore is used (run migrations first: pnpm db:migrate).
# Unset => InMemoryFlowStore (state lost on restart).
DATABASE_URL=postgresql://sdlc:sdlc@localhost:5432/sdlc

# Secrets backend for resolving secret-refs (aws-sm://name#key).
#   env  => read from SECRET_<NAME> env vars (dev/tests). Default.
#   aws  => AWS Secrets Manager via the default AWS credential chain.
SECRETS_BACKEND=aws

# Required when SECRETS_BACKEND=aws.
AWS_REGION=us-east-1
# AWS credentials are taken from the default SDK chain:
#   - locally: AWS_PROFILE (with ~/.aws mounted) or AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN
#   - on EC2:  the instance IAM role (nothing to set here)
# AWS_PROFILE=default
```

- [ ] **Step 2: Create `infra/compose.aws.yml`**

Create `infra/compose.aws.yml`:

```yaml
# Real-services mode: server resolves secrets from AWS Secrets Manager.
# Local:  AWS_PROFILE + ~/.aws mounted (read-only).  EC2: drop the volume, use the instance role.
# Usage:  docker compose -f infra/compose.yml -f infra/compose.aws.yml up -d
services:
  server:
    environment:
      PORT: 3000
      HOST: 0.0.0.0
      LOG_LEVEL: info
      DATABASE_URL: postgresql://sdlc:sdlc@postgres:5432/sdlc
      API_KEYS: ${API_KEYS:-demo-tenant:dev-key-12345}
      SECRETS_BACKEND: aws
      AWS_REGION: ${AWS_REGION:-us-east-1}
      AWS_PROFILE: ${AWS_PROFILE:-}
    volumes:
      - ${HOME}/.aws:/root/.aws:ro
```

(Note for EC2: omit the `volumes:` block — the instance IAM role supplies credentials. The Dockerfile runtime runs as root, so `/root/.aws` is the correct mount target locally.)

- [ ] **Step 3: Verify the compose merges and the server boots**

Run:
```bash
docker compose -f infra/compose.yml -f infra/compose.aws.yml config >/dev/null && echo "compose OK"
```
Expected: prints `compose OK` (valid merged config). (Full boot is exercised in the runbook with real AWS creds.)

- [ ] **Step 4: Commit**

```bash
git add apps/server/.env.example infra/compose.aws.yml
git commit -m "chore(infra): document AWS secrets env + add compose.aws.yml (real-services mode)"
```

---

## Task 5: Runbook

**Files:**
- Create: `docs/runbook-ado-validation.md`

- [ ] **Step 1: Write the runbook**

Create `docs/runbook-ado-validation.md`:

```markdown
# Runbook — Validar Azure DevOps Boards (integración real)

Valida el adapter de ADO Boards end-to-end con secretos en AWS Secrets Manager.
Doc store y PRs siguen en modo NoOp en esta ronda.

## Prerrequisitos
- Azure DevOps: una org y al menos un proyecto (process template **Agile**).
- Un PAT de ADO con scope **Work Items (Read & Write)**.
- Credenciales AWS: perfil local (`aws sso login` / `~/.aws`) o, en EC2, un IAM instance role
  con `secretsmanager:GetSecretValue` sobre `sdlc/*`.
- Node 20+, pnpm 9+, Docker.

## 1. Guardar el PAT en AWS Secrets Manager
```bash
aws secretsmanager create-secret --name sdlc/ado-pat \
  --secret-string '{"token":"<TU_PAT>"}' --region <region>
```
(El `secret_ref` `aws-sm://sdlc/ado-pat#token` resuelve el campo `token`.)

## 2. Configurar los proyectos
```bash
cp infra/integrations.example.json infra/integrations.json
# editar: tenant_id, los 5 `project` (clave interna) y `settings.project` (nombre del board en ADO) + `settings.org`
```

## 3. Postgres + migraciones + seed
```bash
docker compose -f infra/compose.yml up -d postgres
export DATABASE_URL="postgres://sdlc:sdlc@localhost:5432/sdlc"
pnpm --filter @sdlc/server db:migrate
pnpm --filter @sdlc/server seed:integrations infra/integrations.json
```

## 4. Arrancar el server en modo AWS
```bash
export AWS_REGION=<region>
export AWS_PROFILE=<perfil>            # local; en EC2 se omite (instance role)
export API_KEYS="acme:<api-key>"
docker compose -f infra/compose.yml -f infra/compose.aws.yml up -d server
curl -s localhost:3000/health          # debe devolver "store":"postgres"
```

## 5. Ejercer el flow contra un proyecto real
Con un cliente MCP o vía el endpoint JSON-over-HTTP (`POST /mcp/tools/:name`,
header `Authorization: Bearer <api-key>`, `X-User-Id`, `X-User-Roles`):
1. `start_flow` con `project` = uno de los 5 (ej. `tribu-1`).
2. `submit_prd` → `submit_rfc` (doc store NoOp: guardan sha + avanzan estado).
3. `create_epic` → `create_stories` → `claim_story` → `report_progress`.

## 6. Verificar
- En el board de ADO: se crearon Epic / User Story; estados transicionan
  (New → Active → Resolved); links padre/hijo correctos.
- En la DB: `SELECT type, actor, ts FROM flow_events WHERE flow_id = '<flow>' ORDER BY seq;`

## Troubleshooting
- **401 / 403** al crear work items → PAT inválido, sin scope Work Items, o el rol/perfil
  AWS no puede leer el secreto. Verificá el PAT y `aws secretsmanager get-secret-value --secret-id sdlc/ado-pat`.
- **`integration credential unavailable`** → `secret_ref` no resuelve (nombre/región/permisos).
- **`unknown task_system kind: X`** → la fila de `tenant_integrations` quedó con un kind mal escrito; re-corré el seed con el archivo corregido.
- **Adapter in-memory en vez de ADO** → no hay fila para `(tenant, project)`; confirmá que el `project` del `start_flow` coincide con una clave del archivo y re-seedeá.
- **`/health` con `"store":"in-memory"`** → falta `DATABASE_URL` en el entorno del server.
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbook-ado-validation.md
git commit -m "docs: runbook for Azure DevOps Boards integration validation"
```

---

## Self-Review Notes

- **Spec coverage:** seed script + config file format (T1–T2) · example config + gitignore (T3) · `.env.example` + `compose.aws.yml` AWS wiring (T4) · runbook with the 9 operational steps + troubleshooting (T5). Idempotent upsert respecting PK `(tenant_id, project)` and "file is canonical (omitted refs → NULL)" (T2 Step 3). Unit (zod) + gated integration (upsert/read-back/idempotency) tests present (T1, T2). No DB migration (table exists from `0003`). Out-of-scope items (IaC, Drive, PRs, admin UI) intentionally excluded.
- **Type consistency:** `parseIntegrationsConfig` / `IntegrationsConfig` / `seedIntegrations(db, config) → SeedResult {created,updated}` are used identically across `seed.ts`, the CLI, and both tests. `IntegrationRef` shape matches `src/integrations/types.ts`. Upsert columns match the `tenant_integrations` schema (`tenant_id`, `project`, `task_system`, `doc_store`, `pr_provider`, `updated_at`).
- **No placeholders:** every step has full code/commands; the runbook is complete prose, not a stub.
