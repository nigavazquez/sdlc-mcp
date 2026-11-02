#!/usr/bin/env bash
#
# examples/02-fintech/session.sh <persona> <flow-dir> [-- <args extra para claude>]
#
# Abre una sesión de Claude Code como <persona> (ver personas.json) sobre el repo
# de la app, conectada sólo al sdlc-mcp del ejemplo con un token firmado para esa
# persona. Registra la sesión en evidence/sessions.tsv para que capture.sh
# encuentre el transcript después.
#
#   ./session.sh nicolas 04-transferencias
#   ./session.sh qa 04-transferencias
#
# APP_DIR: checkout local de fintech-demo (default ../../../fintech-demo).
#
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

persona="${1:?uso: session.sh <persona> <flow-dir>}"
flow_dir="${2:?uso: session.sh <persona> <flow-dir>  (ej. 04-transferencias)}"
shift 2
[[ "${1:-}" == "--" ]] && shift

APP_DIR="${APP_DIR:-$ROOT/../fintech-demo}"
[[ -d "$APP_DIR" ]] || { echo "No existe APP_DIR=$APP_DIR (cloná fintech-demo o seteá APP_DIR)." >&2; exit 1; }
curl -sf "$PUBLIC_URL/health" >/dev/null || { echo "El server no responde en $PUBLIC_URL: corré ./setup.sh primero." >&2; exit 1; }

IFS=$'\t' read -r email roles squads < <(persona_info "$persona")
token=$(node "$ROOT/examples/lib/mint-token.mjs" --secret "$OAUTH_SIGNING_SECRET" --iss "$PUBLIC_URL" \
  --sub "$email" --roles "$roles" --workspaces "$squads" --ttl 43200)

mcp_cfg="$LOCAL/mcp.$persona.json"
node -e '
  const [url, token, out] = process.argv.slice(1);
  require("node:fs").writeFileSync(out, JSON.stringify({
    mcpServers: { sdlc: { type: "http", url: url + "/mcp", headers: { Authorization: "Bearer " + token } } },
  }, null, 2), { mode: 0o600 });
' "$PUBLIC_URL" "$token" "$mcp_cfg"

session_id=$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')
mkdir -p "$HERE/evidence/$flow_dir"
[[ -f "$HERE/evidence/sessions.tsv" ]] || printf 'started_at\tflow\tpersona\temail\troles\tsession_id\n' > "$HERE/evidence/sessions.tsv"
printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$flow_dir" "$persona" "$email" "$roles" "$session_id" \
  >> "$HERE/evidence/sessions.tsv"

# Lo único que agregamos al system prompt de Claude Code: quién es y en qué flow
# está. El resto lo tiene que dar el MCP (get_role_prompt), que es lo que el
# ejemplo quiere mostrar. Este texto también queda en la evidencia.
persona_prompt="Sos $persona <$email>, con roles $roles en los squads $squads del sdlc-mcp. \
Trabajás en el flow '$flow_dir' de la app fintech-demo. Antes de cada fase pedí tu prompt con \
get_role_prompt y seguilo; usá get_flow_state para saber dónde está el flow. Si una tool devuelve \
ok:false, leé el error, corregí y reintentá: no lo esquives."
printf '%s\n' "$persona_prompt" > "$HERE/evidence/$flow_dir/.persona-prompt.$persona.txt"

echo "→ $persona ($roles) · flow $flow_dir · sesión $session_id"
cd "$APP_DIR"
exec claude --mcp-config "$mcp_cfg" --strict-mcp-config --session-id "$session_id" \
  --name "$flow_dir · $persona" --append-system-prompt "$persona_prompt" "$@"
