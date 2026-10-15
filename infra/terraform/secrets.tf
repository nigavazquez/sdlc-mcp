# Los secretos del deploy. Lo que Terraform crea acá es el **contenedor** y, cuando
# el valor es puro azar, también el valor. Lo que viene de afuera (el client secret
# del proveedor OIDC, los PAT de los adapters) se carga a mano: no tiene por qué
# pasar por el state.
#
# Los nombres son parte del contrato con el runtime: `compose.prod.yml` referencia
# `aws-sm://sdlc/prod/db#url` y `aws-sm://sdlc/prod/oauth#signing_secret`.

# ── Postgres ────────────────────────────────────────────────────────────────
resource "random_password" "db" {
  length  = 40
  special = false # el valor viaja dentro de una URL; sin special no hay que escapar nada
}

resource "aws_secretsmanager_secret" "db" {
  name        = "${var.secret_name_prefix}${var.env}/db"
  description = "sdlc-mcp: credenciales del Postgres del compose"
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    username = "sdlc"
    password = random_password.db.result
    # El host es el nombre del servicio en la red del compose, no un DNS de la VPC.
    url = "postgresql://sdlc:${random_password.db.result}@postgres:5432/sdlc"
  })

  lifecycle {
    # Una rotación hecha a mano no se revierte en el próximo apply.
    ignore_changes = [secret_string]
  }
}

# ── Firmas del server ───────────────────────────────────────────────────────
# OJO: rotar `signing_secret` invalida TODOS los access y refresh tokens vigentes,
# así que cada cliente MCP vuelve a pasar por el login. No es una rotación gratis;
# ver docs/runbook-deploy-prod.md.
resource "random_password" "oauth_signing" {
  length  = 64
  special = false
}

resource "random_password" "admin_session" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "oauth" {
  name        = "${var.secret_name_prefix}${var.env}/oauth"
  description = "sdlc-mcp: firma de los access tokens propios y de la cookie del panel"
}

resource "aws_secretsmanager_secret_version" "oauth" {
  secret_id = aws_secretsmanager_secret.oauth.id
  secret_string = jsonencode({
    signing_secret       = random_password.oauth_signing.result
    admin_session_secret = random_password.admin_session.result
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ── Client secret del proveedor OIDC ────────────────────────────────────────
# Sólo el contenedor: el valor lo emite Google/Entra/Okta y lo carga una persona con
# `aws secretsmanager put-secret-value`. Que no pase por el state es deliberado.
resource "aws_secretsmanager_secret" "oidc" {
  name        = "${var.secret_name_prefix}${var.env}/oidc"
  description = "sdlc-mcp: client secret del proveedor OIDC. Cargar a mano: {\"client_secret\":\"...\"}"
}
