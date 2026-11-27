-- 0016: aprobación humana de fases (RFC aprobacion-de-fases, épica #63).
--
-- flow_approvals: cada aprobación de un PRD, un RFC o unos criterios, atada al sha256
-- exacto que se aprobó. No se borra: invalidarla la marca con invalidated_at y el motivo,
-- así el historial queda completo. Vigente = sin invalidated_at y con el mismo sha256 que
-- la referencia actual del flow (eso lo decide el código, no la base).
--
-- approval_requests: los links de aprobación. Sólo guarda el hash del token; el token
-- viaja únicamente en el link. Un uso (used_at) y vencimiento (expires_at).
--
-- flows.status es text: los estados nuevos prd_in_review y rfc_in_review no cambian el schema.
--
-- Aditiva. Rollback: DROP TABLE approval_requests; DROP TABLE flow_approvals;
CREATE TABLE IF NOT EXISTS "flow_approvals" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "flow_id" text NOT NULL,
  "artifact" text NOT NULL CHECK ("artifact" IN ('prd', 'rfc', 'acceptance_criteria')),
  "sha256" text NOT NULL,
  "approved_by" text NOT NULL,
  "approver_roles" text[] NOT NULL,
  "self_signed" boolean NOT NULL,
  "approved_at" timestamptz NOT NULL DEFAULT now(),
  "invalidated_at" timestamptz,
  "invalidated_reason" text CHECK ("invalidated_reason" IN ('content_changed', 'upstream_resubmitted'))
);
CREATE INDEX IF NOT EXISTS "flow_approvals_flow" ON "flow_approvals" ("tenant_id", "flow_id", "artifact");

CREATE TABLE IF NOT EXISTS "approval_requests" (
  "token_hash" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "flow_id" text NOT NULL,
  "artifact" text NOT NULL CHECK ("artifact" IN ('prd', 'rfc', 'acceptance_criteria')),
  "sha256" text NOT NULL,
  "requested_by" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "approval_requests_flow" ON "approval_requests" ("tenant_id", "flow_id", "artifact");
