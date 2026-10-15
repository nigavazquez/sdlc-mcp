---
id: skill-terraform-implementation
version: 0.1.1
description: "En historias con component_kind=infra, al implementar y al verificar: partir de un plan vacío, cambiar el módulo correcto y dejar el plan como evidencia."
---

# Skill: Implementación de infraestructura con Terraform

Aplicable cuando el componente de la historia tiene `component_kind = infra`. El código vive en el repo del componente (`target_repo`), que puede ser distinto al de las historias de aplicación de la misma épica. Una historia de infra = un repo = un PR, igual que cualquier otra.

Antes de escribir HCL:

1. **Ubicá el módulo correcto.** Cloná `target_repo`. Identificá el módulo/stack al que pertenece el componente. Si el repo usa workspaces o múltiples backends, confirmá cuál corresponde.
2. **Leé el state actual.** Corré `terraform init` + `terraform plan` sobre el estado vigente antes de tocar nada. Tu punto de partida es un plan **vacío** (sin drift); si hay drift, paralizá y avisá al Tech Lead antes de seguir.

Durante la implementación:

- **Plan, nunca apply desde el flujo del PR.** El `terraform apply` lo ejecuta el pipeline/owner de infra tras la aprobación, no vos manualmente ni el CI del PR.
- **Adjuntá el `terraform plan` en la descripción del PR.** El reviewer y QA validan sobre ese output: recursos a crear/modificar/destruir explícitos. Un `plan` con `destroy` inesperado bloquea el PR.
- **State y locking.** No edites el state a mano. No corras comandos que tomen lock largo sobre el backend compartido sin coordinar. Nunca commitees archivos de state ni `.tfvars` con secretos.
- **Variables y secretos.** Secretos vía el secret manager / backend, nunca hardcodeados en HCL ni en `.tfvars` versionados. Variables con `description` y `type` explícitos.
- **Módulos reusables.** Si un recurso ya está modelado en un módulo existente, reusalo y parametrizá; no copies bloques de recursos entre stacks.

Orden cross-repo (coordinación, no automático):

- Si historias de **app** consumen recursos que crea esta historia de **infra** (una cola, un bucket, un rol IAM, un endpoint), **la infra se mergea y aplica primero**. Dejá esto explícito en la descripción del PR de app (link a la historia de infra) y, si hace falta, marcá la dependencia con el PMO. El MCP no fuerza el orden — es tu responsabilidad coordinarlo.

Antes de abrir el PR:

- `terraform fmt` + `terraform validate` pasan.
- El `plan` adjunto refleja exactamente el cambio descrito en los acceptance criteria; sin recursos destruidos por accidente.
- Outputs nuevos documentados para que los consumidores (otras historias/repos) sepan qué referenciar.
