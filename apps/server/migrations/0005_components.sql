-- Slice 5: multi-repo + Terraform components.
-- Flows gain a component registry (declared in the RFC frontmatter); each
-- story targets exactly one component (1 story = 1 repo = 1 PR).
ALTER TABLE "flows"
  ADD COLUMN IF NOT EXISTS "components" jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "stories"
  ADD COLUMN IF NOT EXISTS "target_repo"    text,
  ADD COLUMN IF NOT EXISTS "component"      text,
  ADD COLUMN IF NOT EXISTS "component_kind" text;
