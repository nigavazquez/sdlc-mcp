# Contributing

Gracias por el interés. Esta guía cubre cómo levantar el proyecto, cómo trabajamos
(TDD) y qué se espera de un PR.

## Setup

Requisitos: **Node 20+** y **pnpm 9+** (ver `.nvmrc` y `engines` en `package.json`).

```bash
pnpm install
cp apps/server/.env.example apps/server/.env
pnpm turbo run build
```

Para levantar el server en modo watch (in-memory, sin Postgres):

```bash
pnpm --filter @sdlc/server dev
```

Si vas a tocar el panel admin:

```bash
pnpm --filter @sdlc/admin dev     # Vite dev server
pnpm --filter @sdlc/admin build   # el server sirve apps/admin/dist
```

### Postgres (opcional, para tests de integración)

```bash
docker compose -f infra/compose.yml up -d postgres

DATABASE_URL="postgres://sdlc:sdlc@localhost:5432/sdlc" \
  pnpm --filter @sdlc/server db:migrate
```

## Estructura del monorepo

```
apps/server/                 MCP server (Fastify + MCP SDK) + panel admin API
apps/admin/                  SPA del panel admin (React + Vite)
packages/core/               Tipos compartidos + schemas zod
packages/adapters-contracts/ Interfaces TaskSystemAdapter / DocStoreAdapter / PullRequestAdapter
packages/catalog/            Catálogo versionado de prompts, skills y templates
infra/                       Dockerfile, compose, terraform
docs/                        Arquitectura, runbooks, planes y specs
```

## Cómo trabajamos: TDD

**Test primero, siempre.** El ciclo por cada cambio de comportamiento:

0. Escribí cuál es el seam —el límite público que vas a testear— y confirmalo. Ningún test
   se escribe contra un seam sin confirmar: uno escrito contra un colaborador interno queda
   acoplado a la implementación y el próximo refactor lo rompe sin que nada se haya roto.
1. Escribí el test que describe el comportamiento nuevo.
2. Corrélo y **vé que falle** por la razón correcta (no por un import roto).
3. Implementá lo mínimo para que pase.
4. Corré la suite del package tocado.
5. Commit.

El refactor no va en este ciclo: dentro del ciclo va rojo → verde, y mejorar la forma de lo
que ya pasa es un diff aparte que se discute en el review.

Un cambio de comportamiento sin test que lo cubra no entra. Excepciones razonables:
docs, renames mecánicos cubiertos por el typecheck, y cambios de infra.

### Correr tests

```bash
pnpm turbo run test                        # toda la suite (los de Postgres se skipean)
pnpm --filter @sdlc/server test            # solo el server
pnpm --filter @sdlc/server test oauth-     # por patrón de nombre de archivo

# Con Postgres real (habilita los tests de integración):
TEST_DATABASE_URL="postgres://sdlc:sdlc@localhost:5432/sdlc_test" \
  pnpm --filter @sdlc/server test
```

Los tests de integración contra sistemas externos (Azure DevOps, Google Drive,
GitHub) se skipean salvo que estén seteadas sus env vars. Nunca commitees
credenciales: en el código y la config solo van **referencias** a secretos
(`aws-sm://<name>#<key>`), nunca los valores.

### Verificación antes de un PR

```bash
pnpm run lint:boundaries                    # reglas de arquitectura
npx turbo run typecheck test build --force
```

`lint:boundaries` corre dependency-cruiser con las reglas de `.dependency-cruiser.cjs`:
sin ciclos, las tools no importan adapters concretos (van por los providers),
`packages/` no depende de `apps/`, y `@sdlc/core` no depende de ningún otro package.
Son reglas que el repo ya tenía escritas en `docs/ARCHITECTURE.md` y que hasta ahora
sostenía sólo el review.

Todo verde. Formato: `pnpm format` (Prettier, config en `.prettierrc`).

## Migraciones de base de datos

Las migraciones viven en `apps/server/migrations/` y están versionadas y ordenadas.
Se generan con drizzle-kit y se aplican con el script propio:

```bash
pnpm --filter @sdlc/server db:generate    # a partir de cambios en schema.ts
DATABASE_URL=... pnpm --filter @sdlc/server db:migrate
```

Una migración ya mergeada **no se edita**: se agrega una nueva.

## Agregar un adapter

Los adapters se resuelven en tiempo de llamada según la configuración del
workspace. Para agregar el tuyo (Jira, Linear, lo que sea) implementá el contrato
correspondiente de `@sdlc/adapters-contracts` y registrá el provider. La guía paso
a paso, con un ejemplo completo, está en
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) § *Modelo de adapters*.

## Catálogo de prompts

El contenido de `packages/catalog/` es **genérico por diseño**: no debe mencionar
organizaciones, equipos ni proyectos concretos. Hay un test que lo verifica
(`apps/server/test/catalog.smoke.test.ts`). Para contenido propio de tu
organización, apuntá `CATALOG_ROOT` a tu propio catálogo en vez de editar el
bundleado. Ese catálogo tiene que cumplir el mismo frontmatter (`id` = la clave del índice,
`version` = la de `catalog.yaml`, `description` en las skills): si no, no carga. Convenciones de redacción en
[docs/PROMPT_AUTHORING.md](docs/PROMPT_AUTHORING.md).

El catálogo está **sellado**: `catalog.yaml` declara el digest del contenido bajo la
`catalog_version` que lo describe. Si tocás contenido, el ciclo es:

```bash
# 1. editar roles/, skills/, templates/ o catalog.yaml
# 2. bumpear catalog_version en catalog.yaml
pnpm turbo run build
pnpm --filter @sdlc/catalog seal        # reescribe el sello
```

El script **se niega a sellar** si el contenido cambió y `catalog_version` sigue igual, y
`apps/server/test/catalog-version.test.ts` deja la suite en rojo si el sello no corresponde al
contenido. Ver `docs/ARCHITECTURE.md` § *Catálogo*.

## Pull requests

- Una rama por cambio (`feat/...`, `fix/...`, `docs/...`), nunca directo a `main`.
- Commits en imperativo con scope: `feat(workspaces): ...`, `fix(auth): ...`,
  `docs(adapters): ...`. Un commit por unidad lógica — facilita el bisect.
- El PR describe **qué** cambia y **por qué**, y lista cómo verificarlo.
- Para cambios grandes, primero un plan en `docs/superpowers/plans/` (mirá los
  existentes como referencia): es más barato discutir el plan que el diff.

## Reportar bugs

Abrí un issue con: qué esperabas, qué pasó, cómo reproducirlo, y versión de Node /
modo de persistencia (in-memory o Postgres). Si es de auth, incluí el proveedor
OIDC y los logs del server (sin tokens).
