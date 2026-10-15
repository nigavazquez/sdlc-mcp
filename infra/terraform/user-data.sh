#!/usr/bin/env bash
# Bootstrap de la instancia: deja Docker y los directorios listos. NO deploya nada
# —eso lo hace /opt/sdlc/deploy.sh, que necesita archivos que todavía no existen
# (sdlc.env, sdlc.config.yaml, Caddyfile)— y así el primer deploy es el mismo
# procedimiento que todos los siguientes, no un caso especial.
set -euxo pipefail

dnf -y update
dnf -y install docker jq

# El plugin de compose no viene en los repos de AL2023.
COMPOSE_VERSION=v2.32.4
install -d -m 0755 /usr/libexec/docker/cli-plugins
curl -fsSL \
  "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
  -o /usr/libexec/docker/cli-plugins/docker-compose
chmod +x /usr/libexec/docker/cli-plugins/docker-compose

systemctl enable --now docker

# /etc/sdlc  → configuración del deploy (sdlc.env, sdlc.config.yaml, Caddyfile)
# /opt/sdlc  → lo que viene del repo (compose.prod.yml, deploy.sh)
install -d -m 0755 /etc/sdlc /opt/sdlc

# Rotación de los logs de Docker a nivel daemon, además de la que declara el
# compose: cubre también a los contenedores que alguien levante a mano.
cat >/etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" }
}
JSON
systemctl restart docker
