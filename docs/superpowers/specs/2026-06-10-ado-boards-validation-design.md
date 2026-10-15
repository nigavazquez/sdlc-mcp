# Azure DevOps Boards — Integration Validation Design

**Fecha:** 2026-06-10
**Estado:** diseño aprobado, pendiente de plan de implementación

## Contexto

Los adapters reales (Slices 1–4) están en `main`: selección por tenant/proyecto vía
`IntegrationConfigStore` (tabla `tenant_integrations`) + providers resueltos en tiempo de
llamada, con `SecretResolver` (AWS Secrets Manager / env) detrás de `ctx.resolveSecret`.

Ahora queremos **empezar a probarlo contra servicios reales**. Primer hito acordado:
**validar Azure DevOps Boards end-to-end** (backlog), con el server corriendo local o en
una EC2 simple, tomando los secretos de AWS Secrets Manager. Google Drive y PRs quedan
para rondas posteriores.

### Decisiones tomadas
- **Hito:** validar integraciones primero (no IaC completa). Server local o contenedor mínimo → AWS SM para secretos → ADO real, un tenant/proyecto.
- **Alcance de esta ronda:** solo **Azure DevOps Boards** (`create_epic`, `create_stories`, `link_subtasks`, `claim_story`, `report_progress`, `block_story`, `submit_qa_results`). Doc store y PR provider siguen en **NoOp/in-memory** (default), así el flujo PRD→RFC→shaping→impl→QA corre sin Drive/PRs.
- **Deploy target (cuando vaya a AWS):** una **EC2 con docker compose** (server + Postgres juntos). Sin RDS. "No necesitamos tanta robustez."
- **Credenciales AWS:** cadena por defecto del SDK — local vía perfil/env del AWS CLI montado en el container; en EC2 vía **IAM instance role**. Sin claves estáticas.
- **Topología:** hoy **5 tribus / 5 squads → 5 proyectos (boards ADO)**. ~5 filas `task_system` en `tenant_integrations`, asumiendo **un org + un PAT** compartido (un secreto), variando `settings.project`. El seeding permite override de `secret_ref` por proyecto.
- **Mecanismo de seeding:** script de seed desde archivo de config versionado (Enfoque A). El `IntegrationConfigStore` queda solo-lectura; la escritura vive solo en el seed script (Drizzle `onConflictDoUpdate`).

### Estado del código relevante
- `infra/` tiene `docker/Dockerfile` (multi-stage, runtime `node dist/index.js`) y `compose.yml` (Postgres + server en modo fake: `API_KEYS` demo, sin `SECRETS_BACKEND`).
- `apps/server/.env.example` NO documenta `SECRETS_BACKEND` / `DATABASE_URL` / región AWS.
- `IntegrationConfigStore` (in-memory + Postgres) tiene solo getters — **no hay write path**.
- No existe seed ni admin para `tenant_integrations`.
- `AwsSecretsManagerResolver` usa `new SecretsManagerClient({})` (credential chain por defecto) — no requiere cambios para EC2 role o perfil local.

## Objetivo

Entregar lo necesario para poblar la config de integraciones y correr la validación de ADO
Boards de forma repetible:

1. Un **seed script** idempotente que aplica `tenant_integrations` desde un archivo de config.
2. **Wiring de AWS/secretos** en compose + `.env.example` (modo servicios reales).
3. Un **runbook** operativo de la validación ADO end-to-end.

Fuera de scope: IaC de AWS (Terraform/ECS), Google Drive, PRs, admin UI para credenciales.

## Componentes / archivos

| Archivo | Propósito | Acción |
|---|---|---|
| `apps/server/scripts/seed-integrations.ts` | Lee el archivo de config, valida con zod, hace upsert idempotente de `tenant_integrations` vía Drizzle (`onConflictDoUpdate` sobre `(tenant_id, project)`). Usa `DATABASE_URL`. Imprime filas creadas/actualizadas. | Crear |
| `apps/server/package.json` | script `"seed:integrations": "tsx scripts/seed-integrations.ts"` | Modificar |
| `infra/integrations.example.json` | Ejemplo versionado con los 5 proyectos (solo `secret_ref`, nunca el PAT). | Crear |
| `.gitignore` | Ignorar `infra/integrations.json` (el real). | Modificar |
| `apps/server/.env.example` | Documentar `SECRETS_BACKEND=aws`, `AWS_REGION`, `DATABASE_URL`, y cómo se toman las credenciales AWS. | Modificar |
| `infra/compose.aws.yml` | Compose "modo servicios reales": server con `SECRETS_BACKEND=aws` + región + passthrough de credenciales (local) / instance role (EC2). Reusa el servicio Postgres del `compose.yml`. | Crear |
| `docs/runbook-ado-validation.md` | Runbook operativo paso a paso. | Crear |

## Formato del archivo de config

`infra/integrations.json` (validado por zod en el script):

```json
{
  "tenants": [
    {
      "tenant_id": "acme",
      "projects": [
        {
          "project": "checkout",
          "task_system": {
            "kind": "azure-devops",
            "secret_ref": "aws-sm://sdlc/ado-pat#token",
            "settings": { "org": "acme", "project": "Checkout" }
          }
        }
      ]
    }
  ]
}
```

- Cada entry `project` → una fila `tenant_integrations` clave `(tenant_id, project)`.
- `project` = clave interna (medio del `flow_id`); `settings.project` = nombre del board en ADO (pueden diferir; explícito en el archivo).
- Los 5 proyectos comparten `secret_ref` (un PAT); override por proyecto permitido.
- `doc_store` / `pr_provider` opcionales (ausentes esta ronda → NoOp).
- Idempotente: re-correr actualiza, no duplica.

### Zod schema (resumen)
- `tenants[]`: `{ tenant_id: string≥1, projects[] }`.
- `projects[]`: `{ project: string≥1, task_system?: IntegrationRef, doc_store?: IntegrationRef, pr_provider?: IntegrationRef }`.
- `IntegrationRef`: `{ kind: string≥1, secret_ref?: string, settings: Record<string,unknown> (default {}) }`.
- Al menos uno de los tres refs por proyecto; error claro si falta `tenant_id`/`project`.

## AWS / secretos / compose

`SecretResolver` no cambia (credential chain por defecto). Solo el aprovisionamiento:
- **Local:** `AWS_PROFILE` + montar `~/.aws:ro`, o `AWS_ACCESS_KEY_ID`/`SECRET`/`SESSION_TOKEN`; siempre `AWS_REGION`. `SECRETS_BACKEND=aws`.
- **EC2:** IAM instance role con `secretsmanager:GetSecretValue` sobre `sdlc/*`. Compose sin credenciales.

`infra/compose.aws.yml` (server):
```yaml
environment:
  SECRETS_BACKEND: aws
  AWS_REGION: ${AWS_REGION:-us-east-1}
  DATABASE_URL: postgresql://sdlc:sdlc@postgres:5432/sdlc
  API_KEYS: ${API_KEYS}
  AWS_PROFILE: ${AWS_PROFILE:-}
volumes:
  - ${HOME}/.aws:/root/.aws:ro   # local; omitido en EC2 (instance role)
```
Postgres = el servicio del `compose.yml` (reusado). En EC2 corre todo junto, sin el volumen `~/.aws`.

Secreto en AWS SM (lo crea el operador, no se pega el PAT en ningún archivo versionado):
```bash
aws secretsmanager create-secret --name sdlc/ado-pat \
  --secret-string '{"token":"<PAT>"}' --region <region>
```

## Runbook (validación ADO Boards)

`docs/runbook-ado-validation.md`:
1. Crear PAT en ADO con scope **Work Items (read & write)**.
2. Guardarlo en AWS SM (comando de arriba).
3. Asegurar credenciales AWS (perfil local o instance role) + permiso IAM al secreto.
4. Completar `infra/integrations.json` con los 5 proyectos (org + nombres de board ADO).
5. `docker compose -f infra/compose.yml up -d postgres` → `DATABASE_URL=... pnpm --filter @sdlc/server db:migrate`.
6. `DATABASE_URL=... pnpm --filter @sdlc/server seed:integrations infra/integrations.json`.
7. Arrancar el server (`compose.aws.yml`) con `SECRETS_BACKEND=aws`; confirmar `GET /health` → `"store":"postgres"`.
8. Ejercer end-to-end contra UN proyecto real (doc store NoOp): `start_flow(project=checkout)` → `submit_prd` → `submit_rfc` → `create_epic` → `create_stories` → `claim_story` → `report_progress`.
9. **Verificar en ADO:** Epic/User Story creados, transiciones de estado (New→Active→Resolved), links padre/hijo; revisar `flow_events`.

Troubleshooting incluido: 401/403 (PAT inválido/sin scope o secreto inaccesible), `unknown task_system kind` (config mal seteada), `integration credential unavailable` (secret_ref no resuelve), cómo verificar `/health`.

## Manejo de errores
- Seed script: archivo inexistente / JSON inválido / zod falla → error claro y exit ≠ 0, sin escribir parcialmente (validar todo antes de la primera escritura).
- `DATABASE_URL` ausente → error explícito.
- Upsert respeta la PK `(tenant_id, project)`; nunca duplica.
- El seed nunca imprime ni almacena secretos (solo `secret_ref`).

## Testing
- **Unit:** validación zod del formato de `integrations.json` (rechaza kind/secret_ref/settings inválidos; exige al menos un ref).
- **Integración (gated en `TEST_DATABASE_URL`):** seed → `PostgresIntegrationConfigStore.getTaskSystemConfig` devuelve lo sembrado; segundo run idempotente (actualiza, no duplica).
- **Smoke manual:** el runbook es la prueba end-to-end contra ADO real.
- No se tocan los ~245 tests existentes.

## Fuera de scope (rondas siguientes)
- IaC de AWS (Terraform, ALB, autoscaling) — hoy: EC2 + docker compose a mano.
- Validación de Google Drive (service account, compartir la unidad `0APm8ey814gtwUk9PVA`).
- Validación de PRs (Azure DevOps Repos / GitHub).
- Admin UI / endpoint para credenciales y config de integraciones.
