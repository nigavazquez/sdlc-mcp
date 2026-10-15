-- Squads como eje del modelo: un tenant fijo (default), squads de primera clase,
-- membresía N:M con roles por squad, e iniciativas tipadas.
-- La estructura real (grupos/workspaces) se reconcilia al boot desde sdlc.config.yaml;
-- este seed sólo deja un workspace de ejemplo para arrancar sin configuración.
CREATE TABLE IF NOT EXISTS "squads" (
  "squad_id"   text PRIMARY KEY,
  "name"       text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

INSERT INTO "squads" ("squad_id", "name") VALUES
  ('platform', 'Platform')
ON CONFLICT ("squad_id") DO NOTHING;

-- Una persona puede aportar a varios squads, con roles distintos en cada uno.
-- Reemplaza a tenant_members (deprecada; nunca llegó a prod).
CREATE TABLE IF NOT EXISTS "squad_members" (
  "email"      text NOT NULL,
  "squad_id"   text NOT NULL,
  "roles"      jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("email", "squad_id")
);
CREATE INDEX IF NOT EXISTS "squad_members_squad_idx" ON "squad_members" ("squad_id");

-- Los proyectos son iniciativas tipadas.
ALTER TABLE "flows" ADD COLUMN IF NOT EXISTS "initiative_type" text;

-- Los grants OAuth llevan el mapa squad -> roles (el JWT lo emite como claim `squads`).
ALTER TABLE "oauth_codes"          ADD COLUMN IF NOT EXISTS "squads" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN IF NOT EXISTS "squads" jsonb NOT NULL DEFAULT '{}'::jsonb;
