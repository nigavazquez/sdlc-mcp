# Conectar clientes al sdlc-mcp

Guía paso a paso para que cualquier usuario conecte su cliente (Claude Code CLI, VSCode, Claude Desktop, Cursor, etc.) al servidor MCP del proyecto, tanto en **modo local** (stdio) como en **modo nube** (HTTP contra el deploy).

---

## TL;DR según escenario

| Escenario | Transport | Auth | Archivo de config | ¿Cierra el ciclo? |
|-----------|-----------|------|-------------------|-------------------|
| Desarrollo local (vos sola/o) | **stdio** | env vars del proceso, **sin `DATABASE_URL`** | `.mcp.json` del proyecto | **No** — llega hasta review (ver A.0) |
| Servidor compartido (deploy) | **HTTP** (`<PUBLIC_URL>/mcp`) | OAuth 2.1 con el IdP del deploy (Google SSO); el cliente hace el login solo | `.mcp.json` o config del cliente, **sin secretos** | Sí, con `tenant_integrations` cargado |

---

## A. Modo local (stdio)

El cliente lanza el binario del MCP como proceso hijo y conversa por stdin/stdout. No hace falta servidor corriendo ni red. Ideal para desarrollo y demos.

> **stdio no autentica nada.** La identidad (`SDLC_TENANT_ID`, `SDLC_USER_ID`, `SDLC_USER_ROLES`, `SDLC_WORKSPACES`) la pone quien lanza el proceso; no hay token ni verificación. Contra el store in-memory eso es aceptable —el estado nace y muere con el proceso—, pero apuntarlo a una base compartida sería acceso total a los datos de todos los workspaces sin una sola credencial. Por eso **stdio se niega a arrancar si hay `DATABASE_URL` seteado** (ver A.2). Para una base compartida con usuarios reales, el camino es el transport HTTP con login OAuth (sección B), no stdio.

### A.0. Hasta dónde llega el modo local

**El modo local no cierra el ciclo.** No es una limitación temporal ni un bug: es consecuencia directa de no tener base.

```
sin DATABASE_URL
  └─ el registro de integraciones es el store in-memory, y arranca vacío
       └─ no hay forma de poblarlo (el panel /admin y `seed:integrations`
          escriben en Postgres; stdio no expone ninguna otra vía)
            └─ getPrProviderConfig / getDocStoreConfig → undefined
                 └─ los providers caen al adapter no-op
                      └─ las tools que cierran un gate lo rechazan y fallan
```

| Etapa | Modo local | Por qué |
|-------|-----------|---------|
| `start_flow` → `submit_prd` → `submit_rfc` | ✅ Funciona | Sólo tocan el flow store |
| `propose_breakdown` → `create_stories` | ✅ Funciona | El task system tiene default in-memory |
| `claim_story` → `report_progress` | ✅ Funciona | Sólo tocan el story store |
| `request_code_review` | ❌ **Falla siempre** | Sin `pr_provider` cae al no-op, y el no-op acepta cualquier `pr_url` sin verificarla |
| `submit_review_outcome` | ❌ **Falla siempre** | Ídem: el no-op aprobaría un PR inexistente |
| `submit_adr` | ❌ **Falla siempre** | Sin `doc_store` cae al no-op, que no publica nada y dejaría una referencia sin documento |

Ese rechazo es **deliberado y correcto**: el adapter no-op no verifica nada, así que dejarlo firmar el gate produce exactamente el registro fantasma (un PR o un ADR que no existe, marcado como aprobado) que los gates vinieron a evitar. No hay dry-run ni modo simulado: un review fingido es el mismo registro fantasma con otro nombre.

Al arrancar en modo local, el proceso escribe este alcance en stderr, después del `ready`.

**Para cerrar el ciclo** hace falta base y credenciales reales: usá el transport HTTP contra Postgres (sección B) y cargá `pr_provider` (`github` | `azure-devops-repos`) y `doc_store` (`google-drive`) en `tenant_integrations` para tu workspace — desde el panel `/admin` (sección C.2) o con `pnpm --filter @sdlc/server seed:integrations`.

### A.1. Pre-requisitos

```bash
# Clonar el repo
git clone <repo> && cd sdlc-mcp

# Instalar y compilar
pnpm install
pnpm turbo run build

# Verificar que existe el binario
ls apps/server/dist/mcp-stdio.js
```

### A.2. Variables de entorno (opcionales)

El entry point de stdio (`apps/server/src/mcp-stdio.ts`) construye el `TenantCtx` desde estas variables. Todas tienen defaults razonables para desarrollo:

| Variable | Default | Descripción |
|----------|---------|-------------|
| `SDLC_TENANT_ID` | `local` | ID del tenant lógico |
| `SDLC_USER_ID` | `claude-user` | ID del usuario invocando las tools |
| `SDLC_USER_ROLES` | `developer` | Roles separados por coma (válidos: `product-manager`, `tech-lead`, `pmo`, `developer`, `qa`, `reviewer`) |
| `SDLC_WORKSPACES` | `local` | Workspaces del ctx, separados por coma. Las tools de escritura exigen membresía en el workspace del flow: si tu `project` no está acá, la tool devuelve `ok:false` nombrando el workspace |
| `DATABASE_URL` | (sin valor) | **stdio no arranca si está seteado** (ver A.2.1). Sin valor → `InMemoryFlowStore` |
| `SDLC_STDIO_ALLOW_DATABASE` | (sin valor) | Opt-in explícito (`true`/`1`) para dejar que stdio use `DATABASE_URL`. Sólo para una base de desarrollo descartable |
| `CATALOG_ROOT` | (bundled) | Override del catálogo de prompts |

#### A.2.1. Si stdio no arranca por `DATABASE_URL`

El proceso sale con código 1 y escribe en stderr el rechazo con sus salidas. Las opciones, en orden:

1. **Modo local (el más simple).** Sacá `DATABASE_URL` del entorno *del proceso del MCP*: del bloque `env` de tu `.mcp.json` / `claude_desktop_config.json`, o del `.env` que estés cargando en esa shell. stdio corre contra el store in-memory. **Ojo: no cierra el ciclo** — sin base no hay `tenant_integrations`, así que `request_code_review`, `submit_review_outcome` y `submit_adr` fallan siempre (ver A.0). Sirve para PRD/RFC/backlog, no para terminar una story.
2. **Base compartida con usuarios reales, y la única que cierra el ciclo.** Usá el transport HTTP con login OAuth (`pnpm --filter @sdlc/server dev` y apuntá el cliente a `<PUBLIC_URL>/mcp`). Ahí la identidad sale de un token firmado, con el claim `workspaces` real del usuario, y podés cargar `pr_provider` y `doc_store` en `tenant_integrations`.
3. **Base tuya de desarrollo.** Arrancá con `SDLC_STDIO_ALLOW_DATABASE=true`. Usá una DB descartable — con este opt-in el proceso escribe en esa base con la identidad que vos declaraste por env, sin verificar nada. Con base sí podés cargar integraciones, así que el ciclo llega al final.

### A.3. Configuración por cliente

#### Claude Code CLI / VSCode extension

Archivo `.mcp.json` en la **raíz del proyecto** (gitignored — creá el tuyo localmente con este contenido):

```json
{
  "mcpServers": {
    "sdlc": {
      "command": "node",
      "args": ["apps/server/dist/mcp-stdio.js"],
      "env": {
        "SDLC_TENANT_ID": "local",
        "SDLC_USER_ID": "<tu-usuario>",
        "SDLC_USER_ROLES": "developer,tech-lead,product-manager,pmo,qa,reviewer",
        "SDLC_WORKSPACES": "local,<los-workspaces-que-uses>"
      }
    }
  }
}
```

Notas:
- Las rutas en `args` son **relativas al cwd** del cliente (la raíz del proyecto). Funciona porque Claude Code CLI/VSCode arrancan desde ahí.
- Se commitea en git → se comparte con el equipo. Cada dev puede personalizar `SDLC_USER_ID` con un override local (ver A.4).

#### Claude Desktop

Archivo (macOS): `~/Library/Application Support/Claude/claude_desktop_config.json`
Archivo (Windows): `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "sdlc": {
      "command": "node",
      "args": ["/ruta/absoluta/al/repo/sdlc-mcp/apps/server/dist/mcp-stdio.js"],
      "env": {
        "SDLC_TENANT_ID": "local",
        "SDLC_USER_ID": "<tu-usuario>",
        "SDLC_USER_ROLES": "developer,tech-lead,product-manager,pmo,qa,reviewer",
        "SDLC_WORKSPACES": "local,<los-workspaces-que-uses>"
      }
    }
  }
}
```

Notas:
- **Rutas absolutas obligatorias**. Desktop no resuelve rutas relativas a un cwd de proyecto.
- Si ya hay otros servidores en `mcpServers`, hacer merge — no reemplazar el bloque entero.
- Reiniciar Claude Desktop completamente (no solo cerrar la ventana) para que la config se recargue.

#### Cursor

Cursor lee el mismo formato MCP. Configurar en `~/.cursor/mcp.json` o vía Settings → MCP. Usar rutas absolutas como en Desktop.

### A.4. Verificación

```bash
# CLI:
claude mcp list           # debe mostrar: sdlc: ... - ✓ Connected
claude mcp get sdlc       # detalle del scope y estado

# Smoke test directo del binario (Ctrl+D para cerrar):
node apps/server/dist/mcp-stdio.js
# stderr debe imprimir:
#   [sdlc-mcp] ready — N tools
#   [sdlc-mcp] store: in-memory — workspaces del ctx: local (cambialos con SDLC_WORKSPACES=...)
#   [sdlc-mcp] modo local (store in-memory): el ciclo NO llega hasta el final. ...
# Si en vez de eso sale el rechazo por DATABASE_URL, ver A.2.1.
```

El tercer renglón es el aviso de alcance de A.0, no un error: el server levantó bien. Nombra las tools que van a fallar y qué configurar para que dejen de fallar.

Dentro de una sesión con el cliente, pedir explícitamente: *"llamá la tool `list-roles` del MCP sdlc"*. Debe devolver los 6 roles del catálogo.

### A.5. Desarrollo con hot reload

Cambiar en `.mcp.json`:

```json
"command": "node_modules/.bin/tsx",
"args": ["apps/server/src/mcp-stdio.ts"]
```

Cada vez que el cliente arranque el server tomará el TS fuente directamente, sin necesidad de `pnpm build`.

---

## B. Modo nube (HTTP)

Contra el server deployado (ej. `https://sdlc-mcp.example.com`) los clientes hablan MCP
**Streamable HTTP** en `POST /mcp`. No hay API keys ni headers que configurar: el server
contesta el primer request con un 401 y un `WWW-Authenticate` que apunta a su metadata OAuth,
y el cliente hace el resto (registro dinámico, login en el browser, refresh del token).

Cómo está armado el endpoint —stateless, por qué `/mcp/tools/:name` también existe— en
[`ARCHITECTURE.md` § Las superficies MCP](./ARCHITECTURE.md#las-superficies-mcp).

### B.1. Alta de una persona (lo que hace el admin)

El acceso **no** se emite por persona: sale de la membresía en un workspace.

1. En el panel (`https://sdlc-mcp.example.com/admin`) → workspace → **Miembros** → alta con su
   email y sus roles en ese workspace.
2. Listo. Su email tiene que ser de un dominio permitido (`auth.allowedEmailDomains`) y tener
   membresía en al menos un workspace; si no, el login termina en "Cuenta no permitida" o
   "Cuenta sin alta".

Los roles viajan en el access token (claim `workspaces`), así que un cambio de membresía se ve
en el próximo token: a más tardar en una hora, o al volver a loguearse.

### B.2. Configuración por cliente

#### Claude Code CLI / VSCode

```bash
claude mcp add --transport http sdlc https://sdlc-mcp.example.com/mcp
```

O, equivalente, en el `.mcp.json` del proyecto:

```json
{
  "mcpServers": {
    "sdlc": { "type": "http", "url": "https://sdlc-mcp.example.com/mcp" }
  }
}
```

La primera llamada abre el browser para elegir la cuenta. El token queda guardado por el
cliente y se renueva solo (access token de 1 h, refresh de 30 días).

#### Cursor y otros clientes

Cualquier cliente que soporte MCP por HTTP con OAuth se configura con la misma URL y sin
headers. Si el cliente sólo habla stdio, se puede puentear con un proxy como
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote), que hace el OAuth del lado del proxy.

**No pongas un `Authorization` fijo en la config.** Un token pegado a mano vence en una hora
y deja una credencial en disco; el flujo OAuth existe para que ninguna de las dos cosas pase.

### B.3. Verificación

```bash
# Health (público)
curl https://sdlc-mcp.example.com/health
# → {"ok":true,"catalog_version":"…","store":"postgres"}

# Sin token, /mcp tiene que pedir OAuth, no dar 404:
curl -s -i -X POST https://sdlc-mcp.example.com/mcp | grep -i -E '^HTTP|www-authenticate'
# → HTTP/1.1 401 …
# → www-authenticate: Bearer resource_metadata="https://sdlc-mcp.example.com/.well-known/oauth-protected-resource"

# En el cliente:
claude mcp list   # → sdlc: https://sdlc-mcp.example.com/mcp (HTTP) - ✓ Connected
```

Y dentro de una sesión, llamar a `whoami`: tiene que devolver tu email y los roles que te dio
el admin. La verificación completa del deploy, con el `curl` autenticado paso a paso, está en
[`runbook-deploy-prod.md` § 6.3–6.4](./runbook-deploy-prod.md).

---

## C. Configurar adapters por workspace

Los adapters determinan con qué sistema externo interactúa cada workspace: backlog (Jira, ADO Boards…), docs (Google Drive…) y PRs (GitHub, ADO Repos…).

### C.1. Mecanismo de selección en runtime

La selección ocurre en tiempo de llamada a la tool: el provider correspondiente consulta `IntegrationConfigStore` (tabla `tenant_integrations`, clave `(tenant_id, workspace_id)`) y construye la instancia del adapter con las credenciales resueltas desde Secrets Manager. Si no hay fila para el workspace, cae al default del tenant (`project=""`); si tampoco existe, usa el default in-memory/NoOp.

```
tool call
  └─ ConfigBackedXxxProvider.resolve(ctx, flow)
       └─ IntegrationConfigStore.getXxxConfig(tenantId, flow.project)
            └─ fila tenant_integrations (tenant_id, workspace_id)
                 └─ { kind, secret_ref, settings }  →  adapter concreto
```

### C.2. Configurar un workspace via panel admin

El panel en `/admin` (requiere login con email autorizado en `adminEmails`) expone la pantalla de integración por workspace. También se puede hacer via API REST:

```bash
# Leer config actual
curl https://sdlc-mcp.example.com/admin/api/workspaces/workspace-1/integration \
  -H "Cookie: <session>"

# Escribir config (reemplaza la fila completa)
curl -X PUT https://sdlc-mcp.example.com/admin/api/workspaces/workspace-1/integration \
  -H "Content-Type: application/json" \
  -H "Cookie: <session>" \
  -d '{
    "task_system": {
      "kind": "azure-devops",
      "secret_ref": "aws-sm://ado/workspace-1-pat",
      "settings": { "org": "your-org", "project": "Workspace 1" }
    },
    "doc_store": {
      "kind": "google-drive",
      "secret_ref": "aws-sm://gdrive/sa-json",
      "settings": { "sharedDriveId": "0APm8ey..." }
    },
    "pr_provider": {
      "kind": "github",
      "secret_ref": "aws-sm://github/token",
      "settings": {}
    }
  }'
```

Kinds disponibles: `azure-devops`, `linear`, `github`, `in-memory` (backlog); `google-drive`, `github-repo`, `repo` (docs); `azure-devops-repos`, `github` (PRs).

Los tres kinds de backlog contra un sistema real exigen `secret_ref` y sus propios `settings`:

| Kind | `secret_ref` | `settings` requeridos | `settings` opcionales |
|---|---|---|---|
| `azure-devops` | PAT | `org`, `project` | `epicType`, `storyType`, `subtaskType`, `stateMap`, `areaPath`, `iterationPath` |
| `linear` | personal API key (`lin_api_…`) o token OAuth | `teamId` (UUID del team) | `projectId`, `apiUrl`, `stateMap` |
| `github` | PAT o token de GitHub App con permiso de issues | `owner`, `repo` | `apiBaseUrl` (GitHub Enterprise), `typeLabelPrefix`, `statusLabelPrefix`, `estimateLabelPrefix`, `stateMap` |

```json
{
  "task_system": {
    "kind": "linear",
    "secret_ref": "aws-sm://linear/workspace-1#api_key",
    "settings": { "teamId": "a1b2c3d4-...", "stateMap": { "Resolved": "In Review" } }
  }
}
```

```json
{
  "task_system": {
    "kind": "github",
    "secret_ref": "aws-sm://github/workspace-1#token",
    "settings": { "owner": "acme", "repo": "checkout", "estimateLabelPrefix": "points:" }
  }
}
```

Notas sobre el ejemplo:
- El `pr_provider` de GitHub no usa `settings` (`"settings": {}` es solo para satisfacer el shape); el token viene siempre de `secret_ref`.
- El doc_store `google-drive` exige **exactamente uno** de `settings.sharedDriveId` (unidad compartida de Google Workspace; el secreto es el JSON de una service account) o `settings.rootFolderId` (Mi unidad de una cuenta personal; el secreto es el JSON `authorized_user` que genera `pnpm --filter @sdlc/server drive:auth`, y `root` es la raíz de Mi unidad). Sin ninguno, el resolve falla: no hay unidad por default, para que un workspace mal configurado no publique en la de otro. Con `rootFolderId` el scope es `drive.file`: el server sólo ve lo que creó, así que el valor tiene que ser `root` o una carpeta que haya creado él.
- El doc_store `'repo'` es equivalente a no configurar `doc_store`: ambos resuelven al `NoOpDocStoreAdapter`. Podés setearlo explícitamente o dejar el campo ausente.
- `github` significa cosas distintas según el canal: en `task_system` es `GitHubIssuesTaskSystemAdapter` (el backlog vive en los issues del repo) y en `pr_provider` es `GitHubPullRequestAdapter`. Son dos filas independientes y pueden apuntar a secretos distintos.
- El `stateMap` traduce el vocabulario de estados del server (`Active`, `Resolved`, `Closed`, `Removed`) al del sistema externo. En `linear` los valores son nombres de workflow states del team; en `github`, `open`, `closed` o `closed:not_planned`. Un status sin mapeo **falla explícito** en vez de inventar un estado: el error dice qué agregar. Ver `docs/ARCHITECTURE.md` § *Qué se pierde en cada mapeo del backlog*.

### C.3. `sdlc.config.yaml` — campo `adapters` (intención declarativa)

`sdlc.config.yaml` acepta un campo `adapters` por workspace:

```yaml
workspaces:
  - id: workspace-1
    name: Workspace 1
    adapters:
      backlog: azure-devops   # "intención" para documentar qué adapter usa este workspace
      docs: google-drive
      pr: github
```

Este campo es **parseado y validado** al arrancar el servidor, pero al momento **no propaga automáticamente la config a `tenant_integrations`**. La fuente de verdad en runtime es exclusivamente la tabla `tenant_integrations` (gestionada via panel admin o API). El campo `workspaces[].adapters` sirve para documentar intención y será el mecanismo de seed/sincronización en una iteración futura.

### C.4. Agregar un adapter propio

Para integrar un sistema no incluido (por ejemplo Jira):

> **El `kind` es una unión cerrada.** `TaskSystemKind` en `packages/adapters-contracts/src/tasksys.ts` es `'jira' | 'linear' | 'github' | 'azure-devops'`. Si el `kind` de tu adapter **no** está ya en esa unión, `readonly kind = 'my-system' as const` no typechequea: agregá primero tu string a la unión `TaskSystemKind` (y análogamente a `DocStoreKind` en `docs.ts` o `PrProviderKind` en `pullrequest.ts` para adapters de docs / PRs). En el ejemplo `jira` el string ya existe, así que no hace falta tocarla.

**Paso 1 — implementar el contrato** de `@sdlc/adapters-contracts`:

```typescript
// apps/server/src/adapters/jira-task-system.ts
import type { TaskSystemAdapter, TenantCtx, EpicInput, ExternalRef, StoryInput,
              SubtaskInput, TaskItem, TaskQuery } from '@sdlc/adapters-contracts';

export class JiraTaskSystemAdapter implements TaskSystemAdapter {
  readonly kind = 'jira' as const;

  constructor(private readonly opts: { baseUrl: string; token: string }) {}

  async createEpic(input: EpicInput, _ctx: TenantCtx): Promise<ExternalRef> {
    const res = await fetch(`${this.opts.baseUrl}/rest/api/3/issue`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.opts.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { summary: input.title, issuetype: { name: 'Epic' } } }),
    });
    const data = await res.json();
    return { external_id: data.id, url: `${this.opts.baseUrl}/browse/${data.key}` };
  }

  // Implementar también: createStory, createSubtask, linkChildToParent,
  //                      getItem, transition, search
}
```

**Paso 2 — registrar en el provider** (`apps/server/src/adapters/task-system-provider.ts`):

```typescript
import { JiraTaskSystemAdapter } from './jira-task-system.js';

// En ConfigBackedTaskSystemProvider.resolve(), dentro del switch:
case 'jira': {
  if (!cfg.secret_ref) throw new Error('jira adapter: secret_ref required');
  const token = await ctx.resolveSecret(cfg.secret_ref);
  const s = cfg.settings as Record<string, unknown>;
  return new JiraTaskSystemAdapter({ baseUrl: s.baseUrl as string, token });
}
```

**Paso 3 — configurar el workspace** via panel admin con `"kind": "jira"`.

Los mismos tres pasos aplican para `DocStoreAdapter` (`ConfigBackedDocStoreProvider`) y `PullRequestAdapter` (`ConfigBackedPullRequestProvider`).

---

## D. Troubleshooting

| Síntoma | Causa probable | Fix |
|---------|----------------|-----|
| `claude mcp list` no muestra `sdlc` | Sesión antigua en cache | Reiniciar la sesión CLI / VSCode |
| `✗ Failed to connect` (stdio) | Binario no compilado | `pnpm turbo run build` y revisar `apps/server/dist/mcp-stdio.js` |
| `✗ Failed to connect` (HTTP) | URL incorrecta o servidor caído | `curl <url>/health` para verificar. La URL termina en `/mcp`, no en `/mcp/tools` |
| Login termina en "Cuenta sin alta" / tools rechazan por rol | Sin membresía en el workspace, o con otros roles | Pedirle al admin el alta en el panel (B.1) y volver a loguearse para que el token traiga la membresía nueva |
| Logs raros en stdout rompen MCP | El código loguea con `console.log` | En stdio mode, todo log debe ir a `process.stderr` |
| `Secret resolution not supported` | Tool intenta resolver `vault://...` en stdio | Stdio mode no soporta secrets externos; usar HTTP |
| `request_code_review` / `submit_review_outcome`: *"No hay pr_provider configurado…"* | Modo local: sin base no hay `tenant_integrations`, el provider cae al no-op y el gate lo rechaza | **No es un bug** (ver A.0). Cargá `pr_provider` en `tenant_integrations` corriendo contra Postgres vía HTTP (sección C.2) |
| `submit_adr`: *"No hay doc_store configurado…"* | Ídem, con el doc store | Cargá `doc_store: google-drive` en `tenant_integrations` (sección C.2) |
| `submit_prd` / `submit_rfc` devuelven `ok:false` y el flow no avanzó | El documento no pasó la validación estructural | Es el gate de admisión: un documento inválido se rechaza **sin escribir nada** (el anterior queda intacto). El detalle por sección viene en `data.validation.issues`; corregí y reenviá — podés probar antes con `validate_prd` / `validate_rfc` pasando el markdown |

---

## E. Ciclo de vida resumido

```
Dev local
  └─ stdio + .mcp.json (relativo)
     ciclo parcial: llega hasta review, no lo cierra (ver A.0)

Deploy compartido
  └─ HTTP en <PUBLIC_URL>/mcp + OAuth 2.1 (Google SSO), sin secretos en el cliente
     cierra el ciclo con tenant_integrations cargado; el acceso sale de la membresía por workspace
```
