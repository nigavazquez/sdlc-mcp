CREATE TABLE IF NOT EXISTS "tenants" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "task_system" text,
  "doc_system" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "flows" (
  "flow_id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "project" text NOT NULL,
  "slug" text NOT NULL,
  "title" text NOT NULL,
  "status" text NOT NULL,
  "current_phase" text NOT NULL,
  "prd_ref" jsonb,
  "rfc_ref" jsonb,
  "epic_external_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_flows_tenant_project" ON "flows" ("tenant_id", "project");
CREATE INDEX IF NOT EXISTS "idx_flows_status" ON "flows" ("status");

CREATE TABLE IF NOT EXISTS "flow_events" (
  "flow_id" text NOT NULL,
  "seq" smallint NOT NULL,
  "type" text NOT NULL,
  "actor" text NOT NULL,
  "payload" jsonb NOT NULL,
  "ts" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "flow_events_pk" PRIMARY KEY ("flow_id", "seq")
);

CREATE INDEX IF NOT EXISTS "idx_flow_events_ts" ON "flow_events" ("ts");
