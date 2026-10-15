# Imagen única del deploy: server MCP + SPA del panel admin + migraciones.
#
# Una sola imagen a propósito. El paso de migración del deploy corre
# `node dist/state/migrate-cli.js` sobre **esta misma imagen**, así que es imposible
# migrar con un build y arrancar con otro.
#
# Build (desde la raíz del repo):
#   docker build -f infra/docker/Dockerfile -t sdlc-mcp:local .

FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app

# ── deps ────────────────────────────────────────────────────────────────────
# Sólo los manifests: mientras no cambie el lockfile, esta capa se reusa.
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/admin/package.json apps/admin/
COPY packages/core/package.json packages/core/
COPY packages/adapters-contracts/package.json packages/adapters-contracts/
COPY packages/catalog/package.json packages/catalog/
# `--frozen-lockfile` (y no `=false`): un build de prod que resuelve versiones
# distintas a las del lockfile no es reproducible y no es el que se testeó.
RUN pnpm install --frozen-lockfile

# ── build ───────────────────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json turbo.json ./
COPY packages packages
COPY apps apps
RUN pnpm turbo run build --filter=@sdlc/server --filter=@sdlc/admin
# `pnpm deploy` arma en /out un @sdlc/server autocontenido: sólo dependencies
# (sin tsx, vitest, vite, typescript ni turbo) y los workspace packages copiados
# de verdad adentro de node_modules/@sdlc/, no como symlinks al monorepo.
# Es lo que hace que la imagen de runtime no necesite el árbol del repo.
RUN pnpm --filter @sdlc/server --prod deploy /out

# ── runtime ─────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
# tini como PID 1: reapea zombies y pasa SIGTERM al proceso, que es lo que dispara
# el shutdown ordenado de Fastify (cierra los pools de Postgres).
RUN apk add --no-cache tini

# /out trae dist/, migrations/ y node_modules/ (incluido @sdlc/catalog con su
# catalog.yaml + roles/ + skills/ + templates/, que el server lee en disco).
COPY --from=build --chown=node:node /out /app
# El SPA del panel. Va fuera del layout del server, así que se nombra explícito:
# el default (`../../admin/dist`) sólo existe en un checkout del monorepo.
COPY --from=build --chown=node:node /app/apps/admin/dist /app/admin-ui
ENV ADMIN_UI_DIR=/app/admin-ui

# Usuario sin privilegios (`node` viene en la imagen base). El proceso no escribe
# nada en el filesystem, así que el contenedor puede correr con `read_only: true`.
USER node

EXPOSE 3000

# /health es público (no pasa por auth) y reporta el backend de storage efectivo.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
