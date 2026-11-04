# Ejemplo 02: una fintech de punta a punta con el MCP

Una app fintech simulada (React Native + backend Node en monorepo) construida módulo por
módulo con el ciclo completo de `sdlc-mcp`, con sesiones reales de Claude Code por rol.
Lo que importa no es la app: es la **evidencia** de cómo el MCP condujo el trabajo. Qué
prompt recibió cada agente, qué entregó, qué le rechazaron los gates y cómo lo corrigió.

> **Estado:** el tooling está listo; los flows se van corriendo en tandas y su evidencia
> aparece en `evidence/` a medida que cierran. Ver [Progreso](#progreso).

## La organización del ejemplo

| | |
|---|---|
| **Tribu** | `fintech` |
| **Squads** (uno por módulo) | `auth` · `onboarding` · `home` · `transferencias` · `account` · `settings` |
| **App** | repo GitHub aparte, [`nigavazquez/fintech-demo-sdlc`](https://github.com/nigavazquez/fintech-demo-sdlc): `apps/mobile` (Expo), `apps/api` (Fastify + Postgres), `packages/contracts` |
| **Backlog** | GitHub Issues del mismo repo, separado por squad con el prefijo de labels (`transferencias/story`, `transferencias/status:Active`) |
| **PRs** | GitHub, mismo repo |
| **Docs** | El mismo repo, con el adapter `github-repo`: cada PRD/RFC/ADR/nota es un commit en `docs/sdlc/<tribu>/<squad>/<flow>/` |
| **Auth** | tokens firmados localmente por persona (ver abajo), sin login OIDC |

Personas ([`personas.json`](personas.json)):

| Persona | Roles | Por qué |
|---|---|---|
| `nicolas` | product-manager, tech-lead, pmo, developer | Hace discovery, diseño, shaping e implementación |
| `qa` | qa | `assertNotSelfSignoff` impide que quien implementó firme su QA |
| `reviewer` | reviewer | Ídem para el review. En GitHub es otra cuenta (`ngvazquez`): GitHub no deja pedirle review al autor del PR |

Los squads y su agrupación están en [`sdlc.config.yaml`](sdlc.config.yaml); las
integraciones de cada squad en [`integrations.template.json`](integrations.template.json)
(solo referencias a secretos).

> **Por qué los docs van al repo y no a Drive.** El adapter de Drive necesita un Shared
> Drive, y una cuenta @gmail.com no puede crearlo (requiere Google Workspace). Tampoco
> sirve una carpeta de "Mi unidad": la service account no tiene cuota para escribir ahí.
> Por eso se agregó el adapter `github-repo` (`apps/server/src/adapters/github-repo-docstore.ts`).

## Los flows

| # | Flow | Squad | Track | Qué demuestra |
|---|---|---|---|---|
| 01 | Plataforma + Sign in / Sign up | `auth` | full | RFC greenfield, ADR del stack |
| 02 | Onboarding (datos, KYC simulado, PIN) | `onboarding` | full | Stories api + mobile en paralelo |
| 03 | Home (saldo, movimientos) | `home` | full | `architecture_mode: reuse` |
| 04 | Transferencias (alias/CVU, ledger, idempotencia, límites) | `transferencias` | full | ADR del ledger, loops de QA |
| 05 | Fix que salga de QA de 04 | `transferencias` | lite | `submit_change_note` con repro |
| 06 | Account (perfil, alias, CVU) | `account` | full | `discard_story` |
| 07 | Settings (notificaciones, biometría, PIN, logout) | `settings` | lite | Track liviano para un `improvement` |

## Cómo leer la evidencia

Cada flow tiene su carpeta `evidence/NN-flow/`:

| Archivo | Qué es |
|---|---|
| `README.md` | Resumen: estado final, stories, PRs, llamadas por tool, timeline |
| `prompts/<rol>.<fase>.md` | System prompt, skills y templates que entregó `get_role_prompt` |
| `transcripts/<persona>-<sesión>.md` | La sesión completa de Claude Code, redactada |
| `artifacts/` | Lo que se entregó al MCP: PRD, RFC, ADRs, planes y resultados de QA, reviews. Incluye los **intentos rechazados** (`attempts/`, `*.rechazado*`) |
| `failures.md` | Cada `ok:false`: error literal, reintento, causa y corrección |
| `events.json` | Flow, stories y `flow_events` tal como quedaron en Postgres |
| `tool-calls.jsonl` | Todas las llamadas al MCP en orden, con input y resultado |
| `.persona-prompt.<persona>.txt` | Lo único que se le agregó al agente por fuera del MCP |

[`FAILURES.md`](FAILURES.md) junta las fallas de todos los flows agrupadas por tipo, y
los hallazgos sobre el propio MCP.

## Reproducirlo

Requisitos: Docker, Node 20+, pnpm 9+, `jq`, Claude Code CLI, un checkout de
`fintech-demo-sdlc` al lado de este repo (o `APP_DIR`) y un token fine-grained de GitHub
con Issues, Pull requests y Contents en lectura/escritura sobre ese repo.

```bash
cd examples/02-fintech
cp env.example .env.local            # completar
./setup.sh                           # Postgres, migraciones, squads, integraciones, membresías, server en :3040
```

En otra terminal, una sesión por rol y por fase:

```bash
./session.sh nicolas 04-transferencias    # PRD → RFC → shaping → implementación
./session.sh qa 04-transferencias         # plan de QA, resultados, pedido de review
./session.sh reviewer 04-transferencias   # review en dos ejes
```

Al cerrar el flow:

```bash
./capture.sh 04-transferencias default:transferencias:<slug>
```

`capture.sh` regenera la evidencia, conserva las notas que hayas escrito en
`failures.md` y aborta si encuentra un secreto sin redactar.

Tests del tooling: `node --test examples/02-fintech/scripts/*.test.mjs`.

### Sobre los tokens

`session.sh` firma un access token por persona con el `OAUTH_SIGNING_SECRET` del server
(`examples/lib/mint-token.mjs`), con el claim `workspaces` según `personas.json`. Saltea
el login OIDC a propósito: el ejemplo es sobre el ciclo, no sobre el SSO. Las mismas
membresías se cargan en `workspace_members` para que el panel admin las muestre. **Solo
para un server local**: quien tiene el secreto puede firmar cualquier identidad.

## Progreso

| # | Flow | Estado |
|---|---|---|
| 00 | Tooling del ejemplo | ✅ |
| 01–07 | — | pendiente |
