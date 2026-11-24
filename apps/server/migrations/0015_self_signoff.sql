-- 0015: firma propia (QA y review) por workspace (RFC self-qa-single-member, épica #20).
--
-- self_signoff nace en true para todos los workspaces, existentes y nuevos: por decisión
-- de producto cada persona puede ser un equipo completo, y un admin lo desactiva en los
-- proyectos con equipo. Cada cambio queda en workspace_settings_audit.
--
-- Aditiva. Rollback: DROP de la columna y de la tabla.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "self_signoff" boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS "workspace_settings_audit" (
  "id" bigserial PRIMARY KEY,
  "workspace_id" text NOT NULL,
  "setting" text NOT NULL,
  "old_value" jsonb NOT NULL,
  "new_value" jsonb NOT NULL,
  "actor" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "workspace_settings_audit_ws" ON "workspace_settings_audit" ("workspace_id", "created_at");
