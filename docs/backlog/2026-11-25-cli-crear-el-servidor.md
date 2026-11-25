# Idea: Que el CLI `sdlc` también cree el servidor, no sólo habilite repos

| Campo | Valor |
|---|---|
| Estado | Draft |
| Fecha | 2026-11-25 |
| Origen | Épica #5 (`sdlc-repo-onboarding`), al cerrar la distribución del CLI como `@nigav/sdlc` (#16) |
| Tipo | Feature (pendiente de Discovery) |

## Problema observado

El CLI sólo sirve para conectar un repo a un server sdlc que ya existe: `init` pregunta la URL, hace login y escribe la configuración. Levantar el server en sí (Postgres, migraciones, secretos, OAuth con Google, Drive, GitHub) sigue siendo manual:

- Hoy la instancia nigav se armó a mano con `docker compose --env-file infra/.env.local -f infra/compose.yml`, construyendo la imagen desde un worktree y aplicando migraciones con el perfil `migrate`.
- Ya pasó que una reconstrucción desde una rama equivocada rompió el login con Google (faltaba el arreglo de `iss`), porque el proceso no es reproducible.
- Quien quiera usar sdlc por fuera de nigav no tiene un camino en un paso: tiene que leer el repo, el compose y los runbooks.

## Por qué importa

- `npx @nigav/sdlc init` habilita un repo en segundos, pero sin server no sirve de nada: el primer paso real sigue siendo el más difícil.
- Un setup reproducible del server reduce errores al actualizar la instancia (versión de la imagen, migraciones pendientes, rollback).

## Ideas iniciales (sin validar)

- `sdlc server init`: asistente que genera el `.env` (secreto de firma, URL pública, admins), el `compose.yml` y levanta Postgres y el server con la imagen publicada.
- `sdlc server upgrade`: baja la imagen de una versión, aplica migraciones y deja una imagen anterior etiquetada para rollback (lo que hoy se hace a mano con `docker tag … pre-…`).
- `sdlc server doctor`: chequea que el server responda, que las migraciones estén al día y que OAuth, Drive y GitHub estén configurados.
- Publicar la imagen del server (por ejemplo en GHCR) para no tener que construirla desde el código.
- Guiar la creación de las credenciales externas (client OAuth de Google, PAT de GitHub con los permisos de issues y pull requests) sin pedirle nunca al CLI que las maneje en texto plano.

## Pendiente

- Discovery con el rol PM: público objetivo (sólo nigav o terceros), local con Docker vs. nube.
- Decidir si vive en el mismo paquete `@nigav/sdlc` o en uno aparte.
- Definir cómo se manejan los secretos (env, AWS Secrets Manager, otro) sin mezclar clientes.
