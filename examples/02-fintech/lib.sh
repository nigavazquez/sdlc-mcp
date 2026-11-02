# Helpers compartidos por los scripts del ejemplo 02. Se sourcea, no se ejecuta.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
LOCAL="$HERE/.local"
mkdir -p "$LOCAL"

if [[ ! -f "$HERE/.env.local" ]]; then
  echo "Falta $HERE/.env.local (copiá env.example y completalo)." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
source "$HERE/.env.local"
set +a

PORT="${PORT:-3040}"
DB_NAME="${DB_NAME:-sdlc_fintech}"
PUBLIC_URL="http://localhost:$PORT"
DATABASE_URL="postgres://sdlc:sdlc@localhost:5432/$DB_NAME"
COMPOSE=(docker compose -f "$ROOT/infra/compose.yml")

psql_fintech() { "${COMPOSE[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U sdlc -d "$DB_NAME" "$@"; }

# Lee personas.json con node: imprime "<email>\t<roles csv>\t<squads csv>" de una persona.
persona_info() {
  node -e '
    const cfg = require(process.argv[1]);
    const p = cfg.personas[process.argv[2]];
    if (!p) { console.error(`persona desconocida: ${process.argv[2]}. Opciones: ${Object.keys(cfg.personas).join(", ")}`); process.exit(1); }
    const squads = p.squads === "*" ? cfg.squads : p.squads;
    process.stdout.write([p.email, p.roles.join(","), squads.join(",")].join("\t"));
  ' "$HERE/personas.json" "$1"
}
