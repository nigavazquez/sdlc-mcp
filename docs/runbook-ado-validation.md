# Runbook — Validar Azure DevOps Boards (integración real)

Valida el adapter de ADO Boards end-to-end con secretos en AWS Secrets Manager.
Doc store y PRs siguen en modo NoOp en esta ronda.

## Prerrequisitos
- Azure DevOps: una org y al menos un proyecto (process template **Agile**).
- Un PAT de ADO con scope **Work Items (Read & Write)**.
- Credenciales AWS: perfil local (`aws sso login` / `~/.aws`) o, en EC2, un IAM instance role
  con `secretsmanager:GetSecretValue` sobre `sdlc/*`.
- Node 20+, pnpm 9+, Docker.

## 1. Guardar el PAT en AWS Secrets Manager
```bash
aws secretsmanager create-secret --name sdlc/ado-pat \
  --secret-string '{"token":"<TU_PAT>"}' --region <region>
```
(El `secret_ref` `aws-sm://sdlc/ado-pat#token` resuelve el campo `token`.)

## 2. Configurar los proyectos
```bash
cp infra/integrations.example.json infra/integrations.json
# editar: tenant_id, los 5 `project` (clave interna) y `settings.project` (nombre del board en ADO) + `settings.org`
```

## 3. Postgres + migraciones + seed
```bash
docker compose -f infra/compose.yml up -d postgres
export DATABASE_URL="postgres://sdlc:sdlc@localhost:5432/sdlc"
pnpm --filter @sdlc/server db:migrate
pnpm --filter @sdlc/server seed:integrations infra/integrations.json
```

## 4. Arrancar el server en modo AWS
```bash
export AWS_REGION=<region>
export AWS_PROFILE=<perfil>            # local; en EC2 se omite (instance role)
export OAUTH_SIGNING_SECRET=<secreto>   # sin él los tokens no sobreviven un restart
docker compose -f infra/compose.yml -f infra/compose.aws.yml up -d server
curl -s localhost:3000/health          # debe devolver "store":"postgres"
```

## 5. Ejercer el flow contra un proyecto real
Con un cliente MCP apuntado a `<PUBLIC_URL>/mcp`, o vía el endpoint de debug
`POST /mcp/tools/:name` con `Authorization: Bearer <access token>`. El token se obtiene con el
flujo OAuth; los pasos a mano están en [`runbook-deploy-prod.md` § 6.3](./runbook-deploy-prod.md).
Las API keys y los headers `X-User-*` ya no existen:
1. `start_flow` con `project` = uno de los 5 (ej. `tribu-1`).
2. `submit_prd` → `submit_rfc` (doc store NoOp: guardan sha + avanzan estado).
3. `create_epic` → `create_stories` → `claim_story` → `report_progress`.

## 6. Verificar
- En el board de ADO: se crearon Epic / User Story; estados transicionan
  (New → Active → Resolved); links padre/hijo correctos.
- En la DB: `SELECT type, actor, ts FROM flow_events WHERE flow_id = '<flow>' ORDER BY seq;`

## Troubleshooting
- **401 / 403** al crear work items → PAT inválido, sin scope Work Items, o el rol/perfil
  AWS no puede leer el secreto. Verificá el PAT y `aws secretsmanager get-secret-value --secret-id sdlc/ado-pat`.
- **`integration credential unavailable`** → `secret_ref` no resuelve (nombre/región/permisos).
- **`unknown task_system kind: X`** → la fila de `tenant_integrations` quedó con un kind mal escrito; re-corré el seed con el archivo corregido.
- **Adapter in-memory en vez de ADO** → no hay fila para `(tenant, project)`; confirmá que el `project` del `start_flow` coincide con una clave del archivo y re-seedeá.
- **`/health` con `"store":"in-memory"`** → falta `DATABASE_URL` en el entorno del server.
