# @nigav/sdlc

CLI de [sdlc-mcp](https://github.com/nigavazquez/sdlc-mcp). Hace obligatorio el ciclo de
desarrollo en un repositorio: instala un hook de Claude Code (el **gate**) que no deja al
agente editar código ni commitear sin una historia reclamada en el server sdlc-mcp.

Requiere Node 20+ y un server sdlc-mcp andando ([cómo instalarlo](https://github.com/nigavazquez/sdlc-mcp/blob/main/INSTALL.md)).

```bash
npx @nigav/sdlc login --server https://sdlc.example.com
npx @nigav/sdlc init
```

## Comandos

| Comando | Qué hace |
|---|---|
| `login [--server URL]` | Inicia sesión en el server (OAuth en el navegador). |
| `init` | Habilita el gate en el repo: pregunta workspace y exclusiones, muestra el diff de lo que va a escribir y pide confirmación. Termina corriendo `doctor`. Sin preguntas: `--server URL --workspace W --exclude a,b --yes`. |
| `doctor` | Diagnostica la instalación (archivos, hooks, sesión, workspace) y simula decisiones del gate. |
| `bypass --reason "…" [--ttl 30m]` | Permiso de emergencia sin historia, por ejemplo con el server caído. Sólo desde una terminal con una persona del otro lado: pide confirmación tipeada y el server lo registra. |
| `uninstall [--yes]` | Saca el gate del repo. |
| `--version` | Versión del CLI. |

## Qué escribe `init`

| Archivo | Qué es |
|---|---|
| `.claude/sdlc/config.json` | Server, workspace, branch por defecto y exclusiones. |
| `.claude/hooks/sdlc-gate.mjs` | El gate: un único archivo, sin dependencias ni red para arrancar. |
| `.claude/settings.json` | Los hooks `PreToolUse` y `PostToolUse` que lo llaman. |
| `.mcp.json` | El server sdlc-mcp como server MCP del repo. |
| `CLAUDE.md` | Un bloque (`<!-- sdlc:begin -->` … `<!-- sdlc:end -->`) que le explica al agente cómo trabajar con el gate. |
| `.gitignore` | Lo local de cada sesión: `.claude/sdlc/lease.json`, `.claude/sdlc/cache.json` y `.claude/worktrees/`. |

Esos archivos se commitean: así el gate corre para todo el que abra el repo con Claude Code.
Antes de escribir, `init` deja `.bak` sólo de los archivos que git no respalda.

## Cómo decide el gate

En cada edición o comando de Bash del agente (`PreToolUse`), en este orden:

1. **Archivos protegidos**: `.claude/settings*.json`, el propio gate, `.claude/sdlc/` y
   `.mcp.json` no se tocan nunca desde el agente, ni con edits ni nombrándolos en Bash.
   Tampoco puede correr `sdlc bypass`.
2. **Bash que no es commit ni push**: pasa.
3. **Fuera del repo**: pasa; no es asunto de este gate.
4. **Exclusiones**: `CLAUDE.md`, `docs/**/*.md`, `.claude/skills/**`, `.claude/commands/**`,
   `.claude/agents/**` y las que agregues en `init` pasan sin historia.
5. **Dónde trabaja la sesión**: en el checkout principal, nunca sobre la branch por defecto
   ni con HEAD detached; los worktrees, sólo dentro de `.claude/worktrees/`.
6. **Lease**: hace falta el que abre `claim_story` en esa sesión.
   - Un edit con el lease validado hace menos de 60 s no consulta la red.
   - Un commit o push se valida siempre en el server, y queda registrado como permitido
     o bloqueado.
   - Si el server no responde, se rechaza y se sugiere `sdlc bypass`.

Cuando `claim_story` responde `ok` (`PostToolUse`), el gate guarda el lease de esa sesión.
Cada worktree tiene el suyo, así que se puede trabajar en varias historias a la vez.

## Desarrollo

```bash
pnpm --filter @nigav/sdlc build   # dist/cli.mjs y dist/gate.mjs, sin dependencias
pnpm --filter @nigav/sdlc test
node packages/cli/dist/cli.mjs --version
```

Se publica desde CI con trusted publishing al pushear un tag `cli-v<versión>`
(`.github/workflows/release-cli.yml`).

### Contrato de hooks de Claude Code

Verificado con Claude Code 2.1.308 en un repo real:

- **`tool_response` de una tool MCP** en `PostToolUse` es el array `content` del
  resultado, no un objeto. sdlc-mcp serializa su respuesta (`{ ok, data }`) en un
  bloque `text`. El evento real está en `test/fixtures/post-tool-use-claim-story.json`.
- **PostToolUse no se dispara** cuando la tool devuelve `isError: true`, que es lo que
  el server marca en cualquier `{ ok: false }`. Igual el gate revisa `ok`: un rechazo
  nunca abre el gate.
- **Bloqueo**: en `PreToolUse`, sólo `exit 2` bloquea. El deny normal sale por stdout
  (`permissionDecision: "deny"`) con exit 0. Si el script tira una excepción sin
  capturar o falta `node`, el `|| exit 2` del comando del hook bloquea igual (ver
  `src/hooks.ts`).

### Sesión

`login` usa OAuth 2.1 + PKCE contra el authorization server de sdlc-mcp, con redirect a un
servidor loopback efímero en `127.0.0.1` (se registra un cliente por login, porque el
AS exige `redirect_uri` exacto). La credencial queda en
`~/.config/sdlc/credentials.json` (o `$XDG_CONFIG_HOME/sdlc/`), 0600 en un directorio
0700, fuera de cualquier repo y separada por server.

`getAccessToken()` es lo que usan el CLI y el gate: renueva el access token vencido con
el refresh token bajo un lock de archivo, porque el server rota el refresh token en
cada uso y dos hooks concurrentes lo quemarían. Si no hay sesión o la renovación falla,
tira `LoginRequiredError` con el mensaje que pide correr `sdlc login`.
