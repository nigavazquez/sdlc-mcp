CREATE TABLE IF NOT EXISTS "stories" (
  "story_id" text PRIMARY KEY,
  "flow_id" text NOT NULL REFERENCES "flows"("flow_id") ON DELETE CASCADE,
  "external_id" text NOT NULL,
  "external_url" text NOT NULL,
  "title" text NOT NULL,
  "acceptance_criteria" jsonb NOT NULL,
  "status" text NOT NULL,
  "assignee" text,
  "pr_url" text,
  "qa_plan" jsonb,
  "qa_verdict" text,
  "qa_block_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "stories_flow_external_unique" UNIQUE ("flow_id", "external_id")
);

CREATE INDEX IF NOT EXISTS "stories_flow_status_idx" ON "stories" ("flow_id", "status");
