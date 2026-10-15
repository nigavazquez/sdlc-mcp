CREATE TABLE IF NOT EXISTS "tenant_integrations" (
  "tenant_id" text NOT NULL,
  "project" text NOT NULL DEFAULT '',
  "task_system" jsonb,
  "doc_store" jsonb,
  "pr_provider" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_integrations_pk" PRIMARY KEY ("tenant_id", "project")
);
