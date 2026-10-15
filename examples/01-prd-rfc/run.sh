#!/usr/bin/env bash
#
# examples/01-prd-rfc/run.sh
#
# End-to-end Fase 1 walkthrough: starts a flow, submits a real PRD, generates the
# RFC skeleton, submits a real RFC, and inspects the resulting flow state +
# audit trail. Assumes the server is running locally; if BASE_URL is unset it
# starts a transient server on port 3030 and tears it down at the end.
#
# Usage:
#   ./examples/01-prd-rfc/run.sh                  # spins up its own server
#   BASE_URL=http://localhost:3030 ./run.sh       # use an already-running server
#
# Requirements: bash, curl, python3, jq.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PRD_FILE="$HERE/fixtures/prd.md"
RFC_FILE="$HERE/fixtures/rfc.md"

BASE_URL="${BASE_URL:-}"
API_KEY="${API_KEY:-dev-key-12345}"
TENANT="${TENANT:-demo-tenant}"
USER_ID="${USER_ID:-camila}"
PROJECT="${PROJECT:-checkout-$(date +%s)}"

START_SERVER=0
SERVER_PID=""

cleanup() {
  if [[ $START_SERVER -eq 1 && -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ -z "$BASE_URL" ]]; then
  echo "→ BASE_URL no provisto; levanto server local en :3030"
  (cd "$ROOT" && pnpm --filter @sdlc/server build >/dev/null)
  PORT=3030 API_KEYS="$TENANT:$API_KEY" LOG_LEVEL=warn \
    node "$ROOT/apps/server/dist/index.js" &
  SERVER_PID=$!
  START_SERVER=1
  BASE_URL="http://localhost:3030"
  for _ in $(seq 1 40); do
    if curl -sf "$BASE_URL/health" >/dev/null; then break; fi
    sleep 0.25
  done
fi

call() {
  local tool="$1"
  local body="$2"
  curl -sS -X POST "$BASE_URL/mcp/tools/$tool" \
    -H "Authorization: Bearer $API_KEY" \
    -H "X-User-Id: $USER_ID" \
    -H "X-User-Roles: product-manager,tech-lead" \
    -H "Content-Type: application/json" \
    -d "$body"
}

hr() { printf '\n──────────────────────────────────────────\n  %s\n──────────────────────────────────────────\n' "$1"; }

# ---------------------------------------------------------------------------

hr "0) /health + /.well-known/mcp"
curl -sS "$BASE_URL/health"; echo
curl -sS "$BASE_URL/.well-known/mcp" | jq '{server, transport, endpoint, auth, tools: [.tools[].name]}'

# ---------------------------------------------------------------------------

hr "1) start_flow"
START_BODY=$(jq -n --arg p "$PROJECT" --arg t "Pago en cuotas" --arg d "PRD aprobado por el sponsor; arrancamos el flow." \
              '{project:$p, title:$t, description:$d}')
START=$(call start_flow "$START_BODY")
echo "$START" | jq
FLOW_ID=$(echo "$START" | jq -r '.data.flow_id')
echo "→ flow_id=$FLOW_ID"

# ---------------------------------------------------------------------------

hr "2) get_role_prompt → Product Manager / prd-draft"
call get_role_prompt '{"role":"product-manager","phase":"prd-draft"}' \
  | jq '{
      role: .data.role,
      phase: .data.phase,
      version: .data.version,
      system_prompt_preview: (.data.system_prompt | .[0:380] + "..."),
      skills: [.data.skills[].id],
      templates: [.data.templates[].id],
      next_actions: .next_actions
    }'

# ---------------------------------------------------------------------------

hr "3) submit_prd  (PRD real desde fixtures/prd.md)"
PRD_BODY=$(jq -Rs --arg f "$FLOW_ID" --arg r "/docs/prd/cuotas.md" \
            '{flow_id:$f, prd_markdown:., repo_path:$r}' < "$PRD_FILE")
SUBMIT_PRD=$(call submit_prd "$PRD_BODY")
echo "$SUBMIT_PRD" | jq '{
  ok,
  next_actions,
  flow: .data.flow | {status, current_phase, prd_ref},
  validation: .data.validation
}'

# ---------------------------------------------------------------------------

hr "4) validate_prd dry-run con un PRD intencionalmente incompleto"
BAD_PRD='# PRD\n\n## Problem\nUn solo problema, nada mas.'
BAD_BODY=$(jq -n --arg f "$FLOW_ID" --arg md "$BAD_PRD" '{flow_id:$f, prd_markdown:$md}')
call validate_prd "$BAD_BODY" \
  | jq '{ok, validation: .data, issue_count: (.data.issues | length), issues: .data.issues}'

# ---------------------------------------------------------------------------

hr "5) generate_rfc_skeleton  (template hidratado con metadata del flow)"
call generate_rfc_skeleton "$(jq -n --arg f "$FLOW_ID" '{flow_id:$f}')" \
  | jq -r '.data.rfc_skeleton' | head -25

# ---------------------------------------------------------------------------

hr "6) get_role_prompt → Tech Lead / rfc-draft"
call get_role_prompt '{"role":"tech-lead","phase":"rfc-draft"}' \
  | jq '{
      role: .data.role,
      phase: .data.phase,
      system_prompt_preview: (.data.system_prompt | .[0:380] + "..."),
      skills: [.data.skills[].id],
      next_actions: .next_actions
    }'

# ---------------------------------------------------------------------------

hr "7) submit_rfc  (RFC real desde fixtures/rfc.md)"
RFC_BODY=$(jq -Rs --arg f "$FLOW_ID" --arg r "/docs/rfc/cuotas.md" \
            '{flow_id:$f, rfc_markdown:., repo_path:$r}' < "$RFC_FILE")
SUBMIT_RFC=$(call submit_rfc "$RFC_BODY")
echo "$SUBMIT_RFC" | jq '{
  ok,
  next_actions,
  flow: .data.flow | {status, current_phase, prd_ref, rfc_ref},
  validation: .data.validation
}'

# ---------------------------------------------------------------------------

hr "8) get_flow_state final (audit trail completo)"
call get_flow_state "$(jq -n --arg f "$FLOW_ID" '{flow_id:$f}')" \
  | jq '{
      flow: .data.flow,
      events: [.data.recent_events[] | {type, actor, ts, payload}]
    }'

hr "OK — flow $FLOW_ID terminó en status=rfc_ready / phase=shaping"
