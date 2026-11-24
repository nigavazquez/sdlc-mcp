-- 0014: tablas del gate de repos habilitados (RFC sdlc-repo-onboarding, épica #5).
--
-- gate_leases: permisos que el gate valida antes de dejar editar o commitear. El
-- secreto nunca se persiste: la PK es su sha256. repo y branch se fijan en el primer
-- check (TOFU), por eso nacen NULL.
-- gate_events: registro central de commits permitidos/bloqueados, ediciones bloqueadas
-- y bypass, para medir la North Star por workspace.
--
-- Aditiva: no toca tablas existentes. Rollback: DROP de las dos tablas.
CREATE TABLE IF NOT EXISTS "gate_leases" (
  "lease_hash" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('story', 'bypass')),
  "story_id" text,
  "flow_id" text,
  "user_id" text NOT NULL,
  "repo" text,
  "branch" text,
  "reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  CHECK ("kind" <> 'story' OR "story_id" IS NOT NULL),
  CHECK ("kind" <> 'bypass' OR "reason" IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS "gate_leases_story" ON "gate_leases" ("story_id") WHERE "revoked_at" IS NULL;

CREATE TABLE IF NOT EXISTS "gate_events" (
  "id" bigserial PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "user_id" text NOT NULL,
  "repo" text NOT NULL,
  "branch" text,
  "kind" text NOT NULL CHECK ("kind" IN
    ('commit.allowed', 'commit.blocked', 'edit.blocked', 'bypass.created', 'protected.blocked')),
  "lease_kind" text,
  "story_id" text,
  "reason" text,
  "detail" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "gate_events_ws_time" ON "gate_events" ("tenant_id", "workspace_id", "created_at");
