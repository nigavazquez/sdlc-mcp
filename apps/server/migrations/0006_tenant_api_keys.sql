-- Admin panel: API keys por tenant, gestionadas desde el panel.
-- La key se persiste hasheada (sha256 hex); el plaintext solo se muestra al crearla.
CREATE TABLE IF NOT EXISTS "tenant_api_keys" (
  "id"         text PRIMARY KEY,
  "tenant_id"  text NOT NULL,
  "key_hash"   text NOT NULL UNIQUE,
  "label"      text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "tenant_api_keys_tenant_idx" ON "tenant_api_keys" ("tenant_id");
