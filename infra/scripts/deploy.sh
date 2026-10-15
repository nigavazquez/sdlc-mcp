#!/usr/bin/env bash
#
# Deploy de sdlc-mcp en la EC2. Se corre EN la instancia:
#
#   sudo /opt/sdlc/deploy.sh <git-sha>     # tag explícito
#   sudo /opt/sdlc/deploy.sh               # el que ya está en /etc/sdlc/sdlc.env
#
# Orden: login a ECR → pull → migraciones → up → verificación. Las migraciones van
# antes del `up` a propósito: el server nuevo espera el schema nuevo, y el runner
# corre sobre la misma imagen que se va a arrancar.
#
# La password de Postgres se lee de Secrets Manager con el instance role y se pasa
# por el entorno de este proceso. No se escribe en ningún archivo.
set -euo pipefail

ENV_FILE=${ENV_FILE:-/etc/sdlc/sdlc.env}
COMPOSE_FILE=${COMPOSE_FILE:-/opt/sdlc/compose.prod.yml}

log() { printf '\n== %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[[ -f $ENV_FILE ]] || die "no existe $ENV_FILE (ver infra/sdlc.env.example)"
[[ -f $COMPOSE_FILE ]] || die "no existe $COMPOSE_FILE"

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

# Tag por argumento: pisa el del archivo y lo deja escrito, para que un `up` manual
# posterior use el mismo y no el anterior.
if [[ ${1:-} != "" ]]; then
  SDLC_IMAGE="${SDLC_IMAGE%:*}:$1"
  export SDLC_IMAGE
  sed -i "s|^SDLC_IMAGE=.*|SDLC_IMAGE=${SDLC_IMAGE}|" "$ENV_FILE"
fi

: "${SDLC_IMAGE:?falta SDLC_IMAGE}"
: "${AWS_REGION:=us-east-1}"
: "${SDLC_DB_SECRET_NAME:=sdlc/prod/db}"

registry="${SDLC_IMAGE%%/*}"

log "login a ECR ($registry)"
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$registry"

log "pull $SDLC_IMAGE"
docker pull "$SDLC_IMAGE"

log "password de Postgres desde Secrets Manager ($SDLC_DB_SECRET_NAME)"
POSTGRES_PASSWORD=$(
  aws secretsmanager get-secret-value \
    --secret-id "$SDLC_DB_SECRET_NAME" \
    --region "$AWS_REGION" \
    --query SecretString --output text \
  | jq -r '.password'
)
export POSTGRES_PASSWORD
[[ -n $POSTGRES_PASSWORD ]] || die "el secreto $SDLC_DB_SECRET_NAME no trae la clave 'password'"

log "Postgres arriba"
docker compose -f "$COMPOSE_FILE" up -d postgres

log "migraciones"
docker compose -f "$COMPOSE_FILE" --profile migrate run --rm migrate

log "server + caddy"
docker compose -f "$COMPOSE_FILE" up -d server caddy

log "esperando el health check"
for _ in $(seq 1 30); do
  status=$(docker inspect --format '{{.State.Health.Status}}' sdlc-mcp-server-1 2>/dev/null || echo starting)
  [[ $status == healthy ]] && break
  sleep 2
done
[[ ${status:-} == healthy ]] || {
  docker compose -f "$COMPOSE_FILE" logs --tail 50 server
  die "el server no llegó a healthy — mirá los logs de arriba"
}

log "OK — $SDLC_IMAGE corriendo"
docker compose -f "$COMPOSE_FILE" ps
