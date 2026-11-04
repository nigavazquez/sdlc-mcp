#!/usr/bin/env bash
#
# examples/02-fintech/capture.sh <flow-dir> <flow_id>
#
# Arma la evidencia de un flow a partir de las sesiones registradas en
# evidence/sessions.tsv y del estado en Postgres. Regenera todo salvo las notas
# manuales de failures.md, que se conservan.
#
#   ./capture.sh 04-transferencias default:transferencias:alias-cvu
#
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

flow_dir="${1:?uso: capture.sh <flow-dir> <flow_id>}"
flow_id="${2:?uso: capture.sh <flow-dir> <flow_id>}"
out="$HERE/evidence/$flow_dir"
mkdir -p "$out"
rm -rf "$out/tool-calls.jsonl" "$out/transcripts" "$out/prompts" "$out/artifacts"

# Los SECRET_* y OAUTH_SIGNING_SECRET de .env.local quedan en el entorno (lib.sh
# los exporta): el conversor los redacta literalmente.

echo "→ Transcripts"
found=0
while IFS=$'\t' read -r _ts flow persona _email _roles session_id; do
  [[ "$flow" == "$flow_dir" ]] || continue
  jsonl=$(find "$HOME/.claude/projects" -name "$session_id.jsonl" -print -quit 2>/dev/null || true)
  if [[ -z "$jsonl" ]]; then
    echo "   ⚠ $persona $session_id: no encontré el transcript (¿la sesión nunca arrancó?)" >&2
    continue
  fi
  node "$HERE/scripts/transcript-to-md.mjs" --jsonl "$jsonl" --out "$out" --persona "$persona" --session "$session_id"
  found=$((found + 1))
done < <(tail -n +2 "$HERE/evidence/sessions.tsv")
[[ $found -gt 0 ]] || { echo "No hay sesiones de $flow_dir en evidence/sessions.tsv" >&2; exit 1; }

# Varias sesiones escriben tool-calls.jsonl: ordenar por timestamp y renumerar.
node -e '
  const fs = require("node:fs"); const f = process.argv[1];
  const rows = fs.readFileSync(f, "utf8").trim().split("\n").map(JSON.parse)
    .sort((a, b) => a.ts.localeCompare(b.ts)).map((r, i) => ({ ...r, seq: i + 1 }));
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
' "$out/tool-calls.jsonl"

echo "→ Estado en Postgres"
psql_fintech -At -c "SELECT json_build_object(
    'flow',    (SELECT row_to_json(f) FROM flows f WHERE f.flow_id = '$flow_id'),
    'stories', (SELECT coalesce(json_agg(s ORDER BY s.created_at), '[]') FROM stories s WHERE s.flow_id = '$flow_id'),
    'events',  (SELECT coalesce(json_agg(e ORDER BY e.seq), '[]') FROM flow_events e WHERE e.flow_id = '$flow_id'))" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s),null,2)+"\n"))' \
  > "$out/events.json"

echo "→ Artefactos, fallas y resumen"
node "$HERE/scripts/build-flow-evidence.mjs" --out "$out" --flow-id "$flow_id"

if grep -rEq 'ghp_[A-Za-z0-9]{20}|github_pat_|Bearer eyJ|BEGIN [A-Z ]*PRIVATE KEY' "$out"; then
  echo "✖ Quedó un secreto sin redactar en $out. No commitear." >&2
  exit 1
fi
echo "✔ Evidencia en $out"
