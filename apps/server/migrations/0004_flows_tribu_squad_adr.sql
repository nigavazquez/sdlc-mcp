-- Slice 3: add Tribu/Squad/ADR columns to flows
-- NOTE: Slice 4 must use migration 0005 to avoid numbering collision.
ALTER TABLE "flows"
  ADD COLUMN IF NOT EXISTS "tribu"      text,
  ADD COLUMN IF NOT EXISTS "squad"      text,
  ADD COLUMN IF NOT EXISTS "adr_refs"   jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "adr_count"  smallint NOT NULL DEFAULT 0;
