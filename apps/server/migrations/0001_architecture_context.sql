ALTER TABLE "flows" ADD COLUMN IF NOT EXISTS "architecture_mode" text;
ALTER TABLE "flows" ADD COLUMN IF NOT EXISTS "codebase_status" text;
ALTER TABLE "flows" ADD COLUMN IF NOT EXISTS "existing_repo" text;
