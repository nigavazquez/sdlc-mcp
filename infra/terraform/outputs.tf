output "ecr_repository_url" {
  description = "Repo de la imagen. El SDLC_IMAGE del deploy es este valor + ':' + el sha del commit."
  value       = aws_ecr_repository.app.repository_url
}

output "instance_id" {
  description = "Id de la EC2. Para entrar: aws ssm start-session --target <id>"
  value       = aws_instance.app.id
}

output "public_ip" {
  description = "IP elástica. El registro A del dominio tiene que apuntar acá antes del primer arranque de Caddy."
  value       = aws_eip.instance.public_ip
}

output "security_group_id" {
  description = "Security group del stack. Es exclusivo de este repo: no agregarle reglas desde otro lado."
  value       = aws_security_group.instance.id
}

output "instance_role_arn" {
  description = "Rol de la instancia. Es quien resuelve las referencias aws-sm:// del deploy y de los adapters."
  value       = aws_iam_role.instance.arn
}

output "secret_names" {
  description = "Nombres de los secretos del deploy, en el orden en que los pide el runbook."
  value = {
    db    = aws_secretsmanager_secret.db.name
    oauth = aws_secretsmanager_secret.oauth.name
    oidc  = aws_secretsmanager_secret.oidc.name
  }
}

output "domain" {
  description = "Host público configurado. PUBLIC_URL es https://<esto>."
  value       = var.domain
}
