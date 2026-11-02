#!/usr/bin/env bash
#
# examples/02-fintech/setup.sh
#
# Deja corriendo el sdlc-mcp del ejemplo: Postgres (base aparte, $DB_NAME),
# migraciones, estructura (sdlc.config.yaml), integraciones por squad y
# membresías (personas.json). Idempotente: se puede correr de nuevo.
#
# Uso: ./setup.sh            # arranca el server en foreground en $PORT
#      ./setup.sh --no-server
#
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

for v in GITHUB_OWNER SECRET_GITHUB_TOKEN OAUTH_SIGNING_SECRET; do
  [[ -n "${!v:-}" ]] || { echo "Falta $v en .env.local" >&2; exit 1; }
done

echo "→ Postgres"
"${COMPOSE[@]}" up -d --wait postgres
"${COMPOSE[@]}" exec -T postgres psql -U sdlc -d sdlc -tc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" \
  | grep -q 1 || "${COMPOSE[@]}" exec -T postgres psql -U sdlc -d sdlc -c "CREATE DATABASE $DB_NAME"

echo "→ Build + migraciones"
(cd "$ROOT" && pnpm turbo run build >/dev/null)
(cd "$ROOT" && DATABASE_URL="$DATABASE_URL" pnpm --filter @sdlc/server db:migrate)

echo "→ Integraciones por squad"
sed -e "s|\"OWNER\"|\"$GITHUB_OWNER\"|g" \
    -e "s|\"fintech-demo\"|\"${GITHUB_REPO:-fintech-demo}\"|g" \
    "$HERE/integrations.template.json" > "$LOCAL/integrations.json"
(cd "$ROOT" && DATABASE_URL="$DATABASE_URL" pnpm --filter @sdlc/server seed:integrations "$LOCAL/integrations.json")

export SECRETS_BACKEND=env SECRET_GITHUB_TOKEN

start_server() {
  (cd "$ROOT/apps/server" && \
    PORT="$PORT" PUBLIC_URL="$PUBLIC_URL" DATABASE_URL="$DATABASE_URL" \
    OAUTH_SIGNING_SECRET="$OAUTH_SIGNING_SECRET" SDLC_CONFIG="$HERE/sdlc.config.yaml" \
    QA_EVIDENCE_HOST_ALLOWLIST=github.com LOG_LEVEL="${LOG_LEVEL:-info}" \
    node dist/index.js)
}

# La reconciliación de la estructura corre al boot del server: hay que bootearlo
# una vez antes de insertar membresías (workspace_members referencia workspaces).
echo "→ Estructura (boot de reconciliación)"
start_server > "$LOCAL/server-reconcile.log" 2>&1 &
PID=$!
for _ in $(seq 1 60); do curl -sf "$PUBLIC_URL/health" >/dev/null && break; sleep 0.5; done
kill "$PID"; wait "$PID" 2>/dev/null || true

echo "→ Membresías"
for persona in $(node -e 'console.log(Object.keys(require(process.argv[1]).personas).join(" "))' "$HERE/personas.json"); do
  IFS=$'\t' read -r email roles squads < <(persona_info "$persona")
  roles_json=$(node -e 'process.stdout.write(JSON.stringify(process.argv[1].split(",")))' "$roles")
  for ws in ${squads//,/ }; do
    psql_fintech -q -c "INSERT INTO workspace_members (email, workspace_id, roles)
      VALUES ('$email', '$ws', '$roles_json'::jsonb)
      ON CONFLICT (email, workspace_id) DO UPDATE SET roles = EXCLUDED.roles"
  done
  echo "   $persona <$email>: $roles en $squads"
done

[[ "${1:-}" == "--no-server" ]] && exit 0
echo "→ Server en $PUBLIC_URL (Ctrl-C para cortar)"
start_server
