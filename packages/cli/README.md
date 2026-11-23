# @sdlc/cli

CLI que habilita el SDLC obligatorio en un repositorio (`init`, `doctor`, `login`,
`bypass`, `uninstall`) y el gate que corre en los hooks de Claude Code. Diseño completo
en el RFC `sdlc-repo-onboarding` (épica #5).

Hoy el paquete tiene sólo el esqueleto del gate (historia #6).

```bash
pnpm --filter @sdlc/cli build   # dist/gate.mjs: un único archivo, sin dependencias
pnpm --filter @sdlc/cli test
```

## Contrato de hooks de Claude Code

Verificado con Claude Code 2.1.308 en un repo real (spike de la historia #6):

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
