# infra/terraform — la EC2 del deploy

Stack plano (un solo entorno), siguiendo las convenciones de infra de la casa: state
en `s3://sdlc-terraform-state` con locking nativo, tags por `default_tags`, naming
`<project>-<env>-<recurso>`, políticas IAM con `aws_iam_policy_document` y alcance por
ARN.

| Archivo | Qué hay |
|---|---|
| `versions.tf` | providers + backend S3 (`sdlc-mcp/terraform.tfstate`) |
| `providers.tf` | región y `default_tags` |
| `variables.tf` | entradas; sólo `domain` es obligatoria |
| `ecr.tf` | repo de la imagen, tags inmutables, retención |
| `iam.tf` | rol + instance profile: leer `sdlc/*` de Secrets Manager, pull de ECR, SSM |
| `network.tf` | security group (443, 80 para ACME, SSH opcional) + EIP |
| `secrets.tf` | los secretos del deploy (`sdlc/prod/db`, `/oauth`, `/oidc`) |
| `ec2.tf` | la instancia, IMDSv2, disco cifrado, `ignore_changes = [ami, user_data]` |
| `user-data.sh` | bootstrap: docker + compose plugin + jq + `/etc/sdlc` y `/opt/sdlc` |

## Cómo se corre

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # editar `domain`
terraform init
terraform plan -out=tfplan                     # esto va en la descripción del PR
# el apply lo corre una persona después de aprobar el PR:
terraform apply tfplan
```

**Nunca `apply` sin un plan revisado.** Y antes de empezar cualquier cambio, un
`plan` tiene que volver vacío: si hay drift, se explica primero y se cambia después.

## Lo que este stack NO hace

- **No deploya la aplicación.** `user-data.sh` deja Docker y los directorios, nada
  más. El deploy es `infra/scripts/deploy.sh` corriendo en la instancia, y así el
  primer deploy es idéntico a todos los siguientes.
- **No crea el registro DNS.** El dominio puede estar en otra cuenta o en otro
  proveedor; el `plan` no debería depender de eso. El `public_ip` del output es lo
  que hay que apuntar, y tiene que estar apuntando **antes** del primer arranque de
  Caddy: sin DNS resuelto no hay desafío ACME y no hay certificado.
- **No carga el client secret del OIDC.** Crea el contenedor `sdlc/prod/oidc` vacío;
  el valor lo pone una persona. Ver `docs/runbook-deploy-prod.md`.

## Dos cosas que muerden

1. **El security group es exclusivo de este stack.** Tiene las reglas inline, así que
   una regla agregada desde otro repo con `aws_security_group_rule` la borra el
   próximo `apply` de acá, en silencio.
2. **El AMI sale de un parámetro SSM que Amazon mueve solo.** Por eso
   `ignore_changes = [ami, user_data]`: sin eso, un parche de rutina de upstream hace
   que el próximo `plan` proponga destruir y recrear la instancia. Reemplazarla es una
   decisión explícita (`terraform taint`), no un efecto secundario de correr `plan`.
