-- Google SSO (Fase 4): directorio de miembros + estado del Authorization Server.
-- tenant_members: email -> tenant/roles, administrado desde el panel. Autoriza el
-- login MCP de cada dev. Una persona pertenece a un solo tenant (PK email).
CREATE TABLE IF NOT EXISTS "tenant_members" (
  "email"      text PRIMARY KEY,
  "tenant_id"  text NOT NULL,
  "roles"      jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "tenant_members_tenant_idx" ON "tenant_members" ("tenant_id");

-- Clients registrados por Dynamic Client Registration (RFC 7591).
CREATE TABLE IF NOT EXISTS "oauth_clients" (
  "client_id"     text PRIMARY KEY,
  "client_name"   text NOT NULL,
  "redirect_uris" jsonb NOT NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now()
);

-- Authorization codes propios (single-use, TTL 60s, hasheados).
CREATE TABLE IF NOT EXISTS "oauth_codes" (
  "code_hash"      text PRIMARY KEY,
  "client_id"      text NOT NULL,
  "redirect_uri"   text NOT NULL,
  "code_challenge" text NOT NULL,
  "email"          text NOT NULL,
  "tenant_id"      text NOT NULL,
  "roles"          jsonb NOT NULL,
  "expires_at"     timestamptz NOT NULL,
  "used_at"        timestamptz
);

-- Refresh tokens opacos (30 días, hasheados, rotados en cada uso).
CREATE TABLE IF NOT EXISTS "oauth_refresh_tokens" (
  "id"         text PRIMARY KEY,
  "token_hash" text NOT NULL UNIQUE,
  "email"      text NOT NULL,
  "tenant_id"  text NOT NULL,
  "roles"      jsonb NOT NULL,
  "client_id"  text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz
);
