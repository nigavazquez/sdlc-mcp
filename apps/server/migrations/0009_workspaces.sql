-- 0009_workspaces.sql — squads → workspaces + groups (config-driven, sin seed).
ALTER TABLE "squads" RENAME TO "workspaces";
ALTER TABLE "workspaces" RENAME COLUMN "squad_id" TO "workspace_id";
ALTER TABLE "squad_members" RENAME TO "workspace_members";
ALTER TABLE "workspace_members" RENAME COLUMN "squad_id" TO "workspace_id";
ALTER INDEX IF EXISTS "squad_members_squad_idx" RENAME TO "workspace_members_workspace_idx";

ALTER TABLE "oauth_codes" RENAME COLUMN "squads" TO "workspaces";
ALTER TABLE "oauth_refresh_tokens" RENAME COLUMN "squads" TO "workspaces";

CREATE TABLE IF NOT EXISTS "groups" (
  "group_id"   text PRIMARY KEY,
  "name"       text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "group_id" text;
