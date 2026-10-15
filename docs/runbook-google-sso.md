# Runbook — Google SSO (panel + MCP)

Cómo activar el login con Google Workspace (ej. dominio `example.com`) para el panel admin y los
clientes MCP (Claude Code), y cómo coordinar el switch desde API keys.

## 1. Crear el client OAuth en Google Cloud console

1. Proyecto de GCP de tu organización → **APIs & Services → Credentials → Create credentials →
   OAuth client ID**, tipo **Web application**.
2. Authorized redirect URI: `<PUBLIC_URL>/oauth/callback`
   (ej: `https://sdlc-mcp.example.com/oauth/callback`; para pruebas locales agregá
   `http://localhost:3000/oauth/callback`).
3. Si la OAuth consent screen es nueva: tipo **Internal** (solo cuentas del Workspace),
   scopes `openid` y `email`. Internal evita el proceso de verificación de Google.
4. Guardá `client_id` y `client_secret`.

## 2. Configurar el server (EC2 / compose)

En el env del compose (`infra/compose.aws.yml` los exige):

```bash
GOOGLE_CLIENT_ID=<client_id>
GOOGLE_CLIENT_SECRET=<client_secret>
OAUTH_SIGNING_SECRET=$(openssl rand -hex 32)   # NO rotar sin avisar: invalida todos los tokens
PUBLIC_URL=https://sdlc-mcp.example.com
ADMIN_EMAILS=admin@example.com                 # CSV; quiénes entran al panel
# ALLOWED_EMAIL_DOMAINS=example.com            # CSV; vacío = sin restricción de dominio
ADMIN_SESSION_SECRET=$(openssl rand -hex 32)
```

Aplicar las migraciones (`pnpm --filter @sdlc/server db:migrate`) y rebuildear la imagen
(incluye el SPA). La estructura de squads/workspaces se reconcilia al boot desde
`sdlc.config.yaml`. `TENANT_ID` es opcional (default `default`).

## 3. Alta por squad (antes del switch)

1. Entrá a `<PUBLIC_URL>/admin` → "Sign in with Google" (tu email tiene que estar en
   `ADMIN_EMAILS`).
2. Por cada **squad**: entrá al squad → solapa **Miembros** → alta de cada persona con su
   email (de un dominio permitido) y sus roles (developer, qa, tech-lead, pmo, product-manager, reviewer).
   Una persona puede estar en **varios squads con roles distintos**: el alta es por
   `(squad, email)` y no muda las otras membresías. **Sin membresía en al menos un squad, esa
   persona no puede loguearse al MCP** (ve una página "Cuenta sin alta" que le pide el alta en
   su squad).

## 4. Switch de los clientes MCP

Breaking: las API keys ya no autentican. Cada dev actualiza su `mcp.json` quitando el
header `Authorization`:

```json
{ "mcpServers": { "sdlc": { "type": "http", "url": "https://sdlc-mcp.example.com/mcp" } } }
```

Al primer request el server responde 401 con `WWW-Authenticate` apuntando al resource
metadata OAuth; Claude Code abre el browser, la persona elige su cuenta (de un dominio permitido)
y listo. El access token dura 1 h y se renueva solo con el refresh token (30 días).

Orden recomendado del rollout: (1) deploy con envs nuevas + migración `0008`, (2) admin da de
alta a las personas en sus squads, (3) avisar a las 5 squads que actualicen el `mcp.json` — las
API keys viejas dejan de funcionar desde el deploy.

## 5. Troubleshooting

| Síntoma | Causa probable |
|---|---|
| `/oauth/*` responde 503 | Falta `GOOGLE_CLIENT_ID/SECRET` en el env |
| Google: `redirect_uri_mismatch` | El redirect URI del client no coincide con `PUBLIC_URL/oauth/callback` |
| Página "Cuenta no permitida" | El dominio del email no está en `ALLOWED_EMAIL_DOMAINS` |
| Página "Cuenta sin alta" | Falta la membresía en algún squad para ese email |
| "Sin acceso al panel" | El email no está en `ADMIN_EMAILS` |
| Todos los tokens inválidos tras un deploy | Cambió `OAUTH_SIGNING_SECRET` (o no está seteado y se regenera por proceso) |
