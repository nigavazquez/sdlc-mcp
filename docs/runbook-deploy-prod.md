# Runbook — Deploy a producción (EC2 + docker compose)

Cómo poner `sdlc-mcp` en producción de punta a punta: una sola EC2, docker compose,
los secretos en AWS Secrets Manager resueltos con el **instance role**. Ninguna
credencial se escribe en un archivo: lo que viaja en el compose son **referencias**
(`aws-sm://<name>#<key>`).

Todo lo que dice "corré" acá lo corre una persona. Las partes que necesitan
credenciales de AWS están marcadas con 🔑.

---

## 0. Prerrequisitos

- Cuenta de AWS con permisos para EC2, IAM, ECR y Secrets Manager. 🔑
- Terraform ≥ 1.10 y acceso al bucket de state `s3://sdlc-terraform-state`. 🔑
- Docker en la máquina desde la que se buildea la imagen.
- Un dominio con el que se pueda crear un registro A (ej. `sdlc-mcp.example.com`).
- Un client OAuth en el proveedor OIDC (Google Workspace, Entra ID, Okta…) — el
  procedimiento está en [`runbook-google-sso.md`](./runbook-google-sso.md). El
  redirect URI tiene que ser `https://<dominio>/oauth/callback`.
- La estructura de la organización decidida (groups y workspaces): es lo que va en
  `sdlc.config.yaml` y lo que el server reconcilia al boot.

### Qué queda arriba de la instancia

| Archivo en la EC2 | De dónde sale | Qué es |
|---|---|---|
| `/etc/sdlc/sdlc.env` | `infra/sdlc.env.example` | variables **no secretas**: imagen, dominio, región, y las perillas de rate limit y traces |
| `/etc/sdlc/sdlc.config.yaml` | `sdlc.config.example.yaml` | tenant, labels, admins, OIDC, groups y workspaces |
| `/etc/sdlc/Caddyfile` | `infra/caddy/Caddyfile` | terminación TLS |
| `/opt/sdlc/compose.prod.yml` | `infra/compose.prod.yml` | el stack |
| `/opt/sdlc/deploy.sh` | `infra/scripts/deploy.sh` | el deploy |

---

## 1. Infraestructura (Terraform)

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # editar `domain`
terraform init                                  # 🔑
terraform plan -out=tfplan                      # 🔑 — esto va en la descripción del PR
terraform apply tfplan                          # 🔑 — después de que el PR esté aprobado
```

El `plan` tiene que salir **vacío** antes de empezar cualquier cambio posterior. Si
aparece drift, se explica primero y se cambia después. Nunca `apply` sin un plan
revisado; ver `infra/terraform/README.md`.

Outputs que se usan en el resto del runbook:

```bash
terraform output ecr_repository_url   # → <account>.dkr.ecr.us-east-1.amazonaws.com/sdlc-mcp-prod
terraform output public_ip            # → la IP del registro A
terraform output instance_id          # → para aws ssm start-session
terraform output secret_names
```

**Apuntá el DNS ahora.** El registro A del dominio tiene que resolver a `public_ip`
**antes** del primer arranque de Caddy: el certificado se emite con el desafío
HTTP-01 de Let's Encrypt, que entra por el puerto 80 al nombre del dominio. Sin DNS
resuelto no hay certificado, y Let's Encrypt tiene rate limits para los reintentos.

---

## 2. Los secretos

Terraform crea tres. Dos quedan completos; el tercero lo llenás vos.

| Nombre | Claves | Quién lo carga |
|---|---|---|
| `sdlc/prod/db` | `username`, `password`, `url` | Terraform (`random_password`) |
| `sdlc/prod/oauth` | `signing_secret`, `admin_session_secret` | Terraform (`random_password`) |
| `sdlc/prod/oidc` | `client_secret` | **vos** 🔑 |

```bash
# 🔑 El client secret que emitió el proveedor OIDC.
aws secretsmanager put-secret-value \
  --secret-id sdlc/prod/oidc \
  --secret-string '{"client_secret":"<el-valor>"}' \
  --region us-east-1
```

Además, **uno por credencial de adapter** que vaya a usar algún workspace. Estos no
los crea Terraform porque aparecen a medida que se conectan boards y repos, y se
cargan igual (`create-secret`). Los nombres son libres mientras cuelguen de `sdlc/`
— es el prefijo que el instance role puede leer:

```bash
# 🔑 Ejemplos (sólo los que necesites)
aws secretsmanager create-secret --name sdlc/ado-pat \
  --secret-string '{"token":"<PAT de Azure DevOps>"}' --region us-east-1

aws secretsmanager create-secret --name sdlc/gdrive-sa \
  --secret-string "$(cat service-account.json)" --region us-east-1

aws secretsmanager create-secret --name sdlc/github-token \
  --secret-string '{"token":"<token>"}' --region us-east-1
```

Después, en el panel admin, la integración de cada workspace referencia estos
secretos por nombre (`aws-sm://sdlc/ado-pat#token`). El valor nunca se copia a
ningún lado. Ver `docs/ARCHITECTURE.md` § Modelo de adapters.

> **Rotar `signing_secret` invalida todos los tokens vigentes** — access y refresh —
> así que cada persona vuelve a pasar por el login. No es una rotación gratis:
> avisá antes.

---

## 3. Buildear y publicar la imagen

Desde un checkout limpio del commit que se va a deployar:

```bash
SHA=$(git rev-parse --short HEAD)
ECR=$(cd infra/terraform && terraform output -raw ecr_repository_url)

docker build -f infra/docker/Dockerfile -t "$ECR:$SHA" .

# 🔑
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin "${ECR%%/*}"
docker push "$ECR:$SHA"
```

El tag es el sha del commit y en ECR es **inmutable**. Nunca `latest`: el tag es lo
único que hace que un rollback sea "poné el anterior" y no "buildeá de nuevo y rezá".

La imagen lleva el server, el SPA del panel ya buildeado y las migraciones. Es una
sola para los tres usos, así que es imposible migrar con un build y arrancar con otro.

---

## 4. Preparar la instancia

Entrar (sin SSH, sin puerto abierto):

```bash
# 🔑
aws ssm start-session --target "$(cd infra/terraform && terraform output -raw instance_id)"
sudo -i
```

Copiar los cuatro archivos del repo a la instancia. Con `scp` si habilitaste SSH, o
pegándolos con un heredoc dentro de la sesión SSM:

```bash
# en la instancia
install -d -m 0755 /etc/sdlc /opt/sdlc
# /opt/sdlc/compose.prod.yml   ← infra/compose.prod.yml
# /opt/sdlc/deploy.sh          ← infra/scripts/deploy.sh   (chmod +x)
# /etc/sdlc/Caddyfile          ← infra/caddy/Caddyfile
# /etc/sdlc/sdlc.env           ← infra/sdlc.env.example, editado
# /etc/sdlc/sdlc.config.yaml   ← sdlc.config.example.yaml, editado
```

`/etc/sdlc/sdlc.env` — sin un solo valor de credencial:

```bash
SDLC_IMAGE=<account>.dkr.ecr.us-east-1.amazonaws.com/sdlc-mcp-prod:<sha>
SDLC_DOMAIN=sdlc-mcp.example.com
PUBLIC_URL=https://sdlc-mcp.example.com
SDLC_TLS_EMAIL=infra@example.com
AWS_REGION=us-east-1
SDLC_DB_SECRET_NAME=sdlc/prod/db
```

`/etc/sdlc/sdlc.config.yaml` — lo importante es el bloque `auth.oidc`, que **gana
sobre las env vars** y toma el client secret por referencia:

```yaml
tenantId: default
adminEmails:
  - vos@example.com
auth:
  allowedEmailDomains: [example.com]
  oidc:
    discoveryUrl: https://accounts.google.com/.well-known/openid-configuration
    clientId: <client-id>.apps.googleusercontent.com
    clientSecretRef: aws-sm://sdlc/prod/oidc#client_secret
    scopes: [openid, email]
groups:
  - { id: product, name: Product }
workspaces:
  - { id: platform, name: Platform, group: product }
```

`PUBLIC_URL` tiene que coincidir **exacto** con lo registrado en el proveedor OIDC:
es el issuer del Authorization Server y la base de los redirect URIs.

---

## 5. Deploy

```bash
# en la instancia, como root
/opt/sdlc/deploy.sh <sha>
```

El script hace, en este orden: login a ECR → `docker pull` → levanta Postgres →
**corre las migraciones** → levanta server y Caddy → espera el health check. La
password de Postgres la lee de Secrets Manager con el instance role y la pasa por el
entorno del comando; no toca el disco.

Las migraciones van **antes** del `up` del server a propósito: el server nuevo espera
el schema nuevo.

### Las migraciones a mano

Si necesitás correrlas sueltas (o verificar que no falta ninguna):

```bash
docker compose -f /opt/sdlc/compose.prod.yml --profile migrate run --rm migrate
```

Es idempotente: las ya aplicadas se saltean. La salida termina en
`done — applied N new migration(s); M total.` — con `N=0` en una segunda corrida.

---

## 6. Verificar que quedó bien

### 6.1 Health

```bash
curl -s https://sdlc-mcp.example.com/health
# → {"ok":true,"catalog_version":"0.9.0","store":"postgres"}
```

`"store":"postgres"` es la parte que importa: si dice `"in-memory"`, el server no
tomó `DATABASE_URL` y todo lo que escriba se pierde en el próximo restart.

El certificado: `curl` sin `-k` ya lo valida. Si querés verlo,
`openssl s_client -connect sdlc-mcp.example.com:443 -servername sdlc-mcp.example.com`.

### 6.2 Login del panel

1. Abrí `https://sdlc-mcp.example.com/admin` en el browser.
2. "Sign in with Google" (o el proveedor que sea). Tu email tiene que estar en
   `adminEmails`.
3. Tienen que aparecer los groups y workspaces del `sdlc.config.yaml` — eso prueba
   que el reconcile del boot escribió en Postgres.
4. Entrá a un workspace → **Miembros** → dale de alta a alguien con sus roles. Sin
   membresía en al menos un workspace, esa persona no puede loguearse al MCP.
5. En el mismo workspace → **Integración** → cargá el `secret_ref` del adapter. Ahí
   se prueba de verdad que el instance role lee Secrets Manager.

### 6.3 Una llamada MCP real

Primero, que el resource server esté anunciando el Authorization Server:

```bash
curl -s -i -X POST https://sdlc-mcp.example.com/mcp/tools/whoami | head -3
# → HTTP/1.1 401
# → www-authenticate: Bearer resource_metadata="https://sdlc-mcp.example.com/.well-known/oauth-protected-resource"
```

Ese 401 con `WWW-Authenticate` es lo que dispara el login automático en el cliente.
Ahora una llamada autenticada de punta a punta, haciendo a mano lo que hace el
cliente (DCR → PKCE → authorize → token):

```bash
BASE=https://sdlc-mcp.example.com

# 1. Registrar un cliente (DCR). El redirect no tiene que existir: alcanza con
#    poder leer el `code` de la barra del browser.
CLIENT=$(curl -s -X POST "$BASE/oauth/register" -H 'content-type: application/json' \
  -d '{"client_name":"verificacion-deploy","redirect_uris":["http://localhost:8765/callback"]}' \
  | jq -r .client_id)

# 2. PKCE S256
VERIFIER=$(openssl rand -hex 32)
CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -binary -sha256 | openssl base64 | tr '+/' '-_' | tr -d '=')

# 3. Abrí esto en el browser y logueate:
echo "$BASE/oauth/authorize?response_type=code&client_id=$CLIENT&redirect_uri=http://localhost:8765/callback&code_challenge=$CHALLENGE&code_challenge_method=S256"
#    Termina en una página que no carga (localhost:8765). El `code=...` está en la URL.

# 4. Canjear el code por un access token
CODE=<el code de la barra>
TOKEN=$(curl -s -X POST "$BASE/oauth/token" \
  -d grant_type=authorization_code -d code="$CODE" \
  -d client_id="$CLIENT" -d redirect_uri=http://localhost:8765/callback \
  -d code_verifier="$VERIFIER" | jq -r .access_token)

# 5. La llamada
curl -s -X POST "$BASE/mcp/tools/whoami" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{}'
# → {"ok":true,"data":{"tenant_id":"default","user_id":"vos@example.com","roles":["tech-lead",…]}}

# 6. Y que la membresía por workspace haya llegado al token (es lo que autoriza
#    cada tool). El claim `workspaces` se lee del payload del JWT:
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq .workspaces
# → {"platform":["tech-lead"]}
```

Si `roles` viene poblado y `workspaces` trae el workspace donde diste de alta a esa
persona en 6.2, el circuito completo —OIDC, membresía, emisión del token, resource
server— está cerrado.

### 6.4 Un cliente MCP de verdad

6.3 prueba el circuito de auth por la superficie de debug (`/mcp/tools/:name`). Falta el
transport que usan los clientes, `POST /mcp`. Con el mismo `$TOKEN`:

```bash
curl -s -X POST "$BASE/mcp" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq '.result.tools | length'
# → 28
```

Y el cliente que va a usar el equipo, desde tu máquina:

```bash
claude mcp add --transport http sdlc https://sdlc-mcp.example.com/mcp
claude mcp list
# → sdlc: https://sdlc-mcp.example.com/mcp (HTTP) - ✓ Connected
```

La primera vez abre el browser para el login OAuth; después, `/mcp` en una sesión de Claude
Code tiene que listar las tools y `whoami` devolver lo mismo que en 6.3. Esa es la URL que se
reparte a las squads (`runbook-google-sso.md` § 4).

---

## 7. Logs

```bash
# todo el stack
docker compose -f /opt/sdlc/compose.prod.yml logs -f

# sólo el server, últimas 200 líneas
docker compose -f /opt/sdlc/compose.prod.yml logs --tail 200 server
```

El server loguea JSON (pino) a stdout; Docker lo rota a 10 MB × 5 archivos, así que
no llena el disco. Las líneas que valen al arrancar:

| Mensaje | Qué confirma |
|---|---|
| `effective config resolved` | de qué fuente salió cada valor (`sources`) y qué secret-refs se resolvieron (`secretRefsResolved`, sólo nombres) |
| `reconciling org structure from config` / `reconcile complete` | leyó el `sdlc.config.yaml` y creó lo que faltaba |
| `admin UI enabled` | encontró el SPA buildeado |
| `sdlc-mcp ready` | escuchando, con `store` y la cantidad de tools |

Estado de los contenedores y del health check:

```bash
docker compose -f /opt/sdlc/compose.prod.yml ps
docker inspect --format '{{.State.Health.Status}}' sdlc-mcp-server-1
```

---

## 8. Rollback

El tag de la imagen es inmutable, así que volver atrás es apuntar al anterior:

```bash
# en la instancia
/opt/sdlc/deploy.sh <sha-anterior>
```

**Dos cosas que hay que mirar antes:**

1. **Las migraciones no se desaplican.** El runner sólo va hacia adelante. Si el
   deploy que estás revirtiendo trajo una migración destructiva (una columna borrada,
   un tipo cambiado), volver la imagen atrás no vuelve el schema atrás, y el binario
   viejo puede no entenderse con el schema nuevo. Antes de revertir, mirá qué
   migraciones entraron:
   ```bash
   docker compose -f /opt/sdlc/compose.prod.yml exec postgres \
     psql -U sdlc -d sdlc -c 'SELECT id, applied_at FROM _sdlc_migrations ORDER BY id DESC LIMIT 5;'
   ```
   Si hay una destructiva en el medio, el rollback es un fix hacia adelante, no un
   tag anterior.
2. **No toques `OAUTH_SIGNING_SECRET`.** Un rollback no lo cambia y está bien así:
   cambiarlo invalidaría todos los tokens vigentes.

Para bajar todo sin perder datos: `docker compose -f /opt/sdlc/compose.prod.yml down`
(sin `-v`; `-v` borra el volumen de Postgres y el certificado de Caddy).

---

## 9. Modos de falla conocidos

| Síntoma | Causa |
|---|---|
| `/health` responde `"store":"in-memory"` | El server no tomó `DATABASE_URL`, o la referencia `aws-sm://` no resolvió. Mirá `secretRefsResolved` en el log de boot: si `databaseUrl` no está ahí, la env var llegó vacía |
| El server no arranca y el log dice `Failed to fetch secret for "aws-sm://…"` | El instance role no puede leer ese secreto: nombre mal escrito, región distinta, o el secreto no cuelga de `sdlc/`. Probá `aws secretsmanager get-secret-value --secret-id <name>` desde la instancia |
| El server no arranca y el log dice `Key "x" missing or non-string` | El secreto existe pero no tiene esa clave. `aws-sm://sdlc/prod/db#url` necesita un JSON con `url` |
| Caddy reintenta y no hay certificado | El DNS no resuelve a la IP de la instancia todavía, o el puerto 80 está cerrado. ACME HTTP-01 entra por el 80 aunque todo el tráfico útil sea por 443 |
| `redirect_uri_mismatch` en el proveedor OIDC | `PUBLIC_URL` no coincide exacto con el redirect registrado (`<PUBLIC_URL>/oauth/callback`). Un `http` vs `https` o una barra de más alcanzan |
| `/oauth/*` responde 503 `OIDC identity provider not configured` | No hay bloque `auth.oidc` en el `sdlc.config.yaml` ni `GOOGLE_CLIENT_ID/SECRET` en el env, o el `clientSecretRef` no resolvió |
| Página "Cuenta sin alta" al loguearse | Ese email no tiene membresía en ningún workspace. Se da de alta en el panel (6.2) |
| Página "Cuenta no permitida" | El dominio del email no está en `auth.allowedEmailDomains` |
| "Sin acceso al panel" | El email no está en `adminEmails` |
| Todos los tokens dejaron de valer tras un deploy | Cambió `signing_secret`, o el secreto no resolvió y el server generó uno random por proceso (arranca igual, pero los tokens no sobreviven al restart) |
| `GET /mcp` devuelve 405 | Correcto: el transport es stateless y sólo atiende `POST`. Un cliente MCP hace `POST`; si el 405 lo ve un cliente, está configurado con el transport SSE viejo en vez de `http` |
| `POST /mcp` devuelve 404 | La imagen es anterior al transport Streamable HTTP. Redeploy con un sha que lo incluya |
| Una tool falla con `integration credential unavailable` | El `secret_ref` de la integración de ese workspace no resuelve: nombre, región o permisos. Es el mismo diagnóstico que en [`runbook-ado-validation.md`](./runbook-ado-validation.md) |
| Una tool cae al adapter in-memory / NoOp en vez del real | No hay fila de integración para `(tenant, workspace)`. Cargala en el panel: workspace → Integración |
| El deploy corrió pero sigue la imagen vieja | `deploy.sh` sin argumento usa el `SDLC_IMAGE` que ya está en `/etc/sdlc/sdlc.env`. Pasale el sha explícito |
| El disco se llenó | Imágenes viejas acumuladas: `docker image prune -a --filter "until=720h"`. Los logs ya rotan (10 MB × 5) |

---

## 10. Lo que este deploy todavía no cubre

- **Backups de Postgres.** El volumen está en el disco raíz de la instancia, cifrado
  y con `delete_on_termination = false`, pero no hay snapshot automático ni `pg_dump`
  programado. Hoy el respaldo es manual.
- **Streamable HTTP del MCP** (ver 6.3).
- **Observabilidad**: no hay métricas ni trazas. Está en la Fase 5 del roadmap.
