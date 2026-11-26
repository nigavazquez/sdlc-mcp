# sdlc-mcp

**Hace que los agentes de código (Claude Code, Cursor, …) trabajen dentro del ciclo de
desarrollo de tu equipo y no por fuera de él.**

PRD → RFC → historias en el backlog → implementación → QA → code review: el mismo ciclo
de siempre, pero cada fase la hace una persona con su agente, el agente recibe el prompt
que tu equipo curó para ese rol y esa fase, y el server registra, valida y publica lo que
sale de cada paso.

- **Licencia:** MIT · **Requisitos:** Node 20+, pnpm 9+ · Postgres para uso real
- **Instalar:** [INSTALL.md](INSTALL.md)

## El problema

Con un agente, el código llega antes que la decisión. Se puede tener un PR en diez minutos
sin que nadie haya escrito qué problema resuelve, sin un diseño que alguien haya mirado y
sin una historia en el backlog. Después nadie sabe por qué se hizo así, si se testeó de
verdad o quién lo validó. Y cada persona le pide las cosas a su agente a su manera, así
que la calidad depende de quién escribió el prompt ese día.

## Qué cambia

| | Agente sin sdlc-mcp | Agente con sdlc-mcp |
|---|---|---|
| **El prompt de cada fase** | El que cada persona escribe en el momento | El del catálogo de tu equipo, versionado, por rol y por fase |
| **PRD, RFC, decisiones** | En el chat, si existen | Validados por estructura y publicados en tu Drive o tu repo, con su hash |
| **Quién avanza cada fase** | Cualquiera, en cualquier orden | Cada tool exige el rol del workspace y el estado correcto del flow |
| **Un commit en el repo** | Entra sin preguntar | El gate lo frena si no hay una historia activa detrás (o un bypass registrado) |
| **QA y review** | "Lo probé" | Un sobre con el comando, el exit code y la cobertura de los criterios, y un review en dos ejes |

## Las tres piezas

1. **El server MCP** (`apps/server`). Entrega a cada agente el prompt, las skills y el
   template de su rol y su fase; valida lo que el agente produce; mueve el flow; y escribe
   en tus sistemas: historias en GitHub Issues, Linear o Azure DevOps, documentos en Google
   Drive o en el repo, comentarios y etiquetas en el PR. Login con OAuth contra tu
   proveedor de identidad.
2. **El panel admin** (`apps/admin`, servido en `/admin`). Workspaces, quién tiene qué rol
   en cada uno, con qué sistemas habla cada workspace y el estado de cada flow con su
   historial.
3. **El CLI [`@nigav/sdlc`](packages/cli/README.md) y su gate.** `npx @nigav/sdlc init`
   instala en un repo un hook de Claude Code que hace obligatorio el ciclo: sin una
   historia reclamada en el server, el agente no edita código ni commitea.

## Un ciclo

```
Fase:    PRD ────► RFC ─────► Shaping ───────► Implementación ─► QA ─► Review ──────────► fin
Rol:     PM        TL         PMO              Developer          QA    Reviewer
Status:  draft ──► prd_ready ► rfc_ready ────► backlog_ready ─────────► impl_in_review ─► merged
```

En cada fase el agente pide primero su prompt con `get_role_prompt(role, phase)` y
después llama a las tools de esa fase:

| Quién | Qué hace | Tools |
|---|---|---|
| PM / TL / PMO | Abre la iniciativa con su tipo | `start_flow` |
| Product Manager | Discovery y PRD | `validate_prd` · `submit_prd` |
| Tech Lead | RFC con la arquitectura y el repo de cada componente; ADRs | `generate_rfc_skeleton` · `validate_rfc` · `submit_rfc` · `submit_adr` |
| PMO / TL | Épica, historias con criterios de aceptación y subtareas en el backlog | `propose_breakdown` · `create_epic` · `create_stories` · `sync_backlog` |
| Developer | Reclama una historia, implementa en su branch y abre el PR | `claim_story` · `get_implementation_context` · `report_progress` |
| QA | Plan desde los criterios y resultados con evidencia ejecutable | `generate_qa_plan` · `submit_qa_results` |
| Reviewer | Review en dos ejes: estándares y spec | `request_code_review` · `submit_review_outcome` |

- **Track completo** (`feature`, `refactor`): la tabla entera.
- **Track liviano** (`fix`, `improvement`): `submit_change_note`, una nota de cuatro
  secciones (qué pasa, cómo lo sé, qué cambio, cómo se verifica), reemplaza las filas del
  PRD al backlog. QA y review no se relajan.

Lo que el server hace cumplir en cualquier track:

- Cada tool exige su rol en el workspace del flow, y el estado del flow tiene que ser el
  de esa fase.
- QA necesita evidencia: URL por caso, comando de test con exit code 0, hash del output y
  cobertura completa de los criterios.
- El PR tiene que ser del repo que la historia declaró.
- Se sube de track, no se baja: un fix que creció puede pasar a PRD; una feature no se
  degrada a nota de cambio.
- Todo queda en el historial del flow, visible en el panel. `verify_artifact` comprueba que
  un documento publicado no se editó después del submit.

Para verlo andar sin configurar nada: `./examples/01-prd-rfc/run.sh`. El ciclo completo
con integraciones reales, transcripts y fallas documentadas está en
[examples/02-fintech](examples/02-fintech/README.md).

## Qué es y qué no es

- **No ejecuta agentes ni es un modelo.** Los agentes corren en la máquina de cada persona;
  el server les dice qué hacer en cada fase y registra lo que hicieron.
- **No es un método nuevo.** No es spec-driven development ni reemplaza tu proceso: es el
  SDLC clásico, con agentes en cada fase.
- **No reemplaza a Jira, GitHub o Drive.** Escribe en ellos. Cada workspace elige los suyos.
- **No es sólo para equipos grandes.** Una persona sola puede firmar su propio QA y su
  propio review: queda marcado como firma propia en el issue y en el PR. Un workspace con
  equipo puede desactivarlo y exigir que firme otra persona.
- **Todo lo de tu organización es configuración, no código:** cómo se llaman los
  workspaces y los grupos, el proveedor de identidad, las integraciones de cada workspace
  y el catálogo de prompts.

## Estado

En uso diario en una instancia propia con varios proyectos (incluido este repo, que se
desarrolla por su propio flow). Lo que se usa todos los días: GitHub Issues, GitHub PRs,
Google Drive en Mi unidad, login con Google y el gate del CLI. Azure DevOps (Boards y Repos)
tiene un [runbook de validación](docs/runbook-ado-validation.md) contra una organización
real; Linear y la unidad compartida de Drive tienen tests pero no uso diario. El deploy de
producción documentado es AWS (EC2 + compose + Terraform).

## Documentación

| Archivo | Cuándo leerlo |
|---|---|
| [INSTALL.md](INSTALL.md) | Para levantarlo: probar, instancia propia, producción, habilitar un repo |
| [docs/CONNECTING_CLIENTS.md](docs/CONNECTING_CLIENTS.md) | Para conectar Claude Code, Claude Desktop o Cursor |
| [packages/cli/README.md](packages/cli/README.md) | Para el CLI y cómo decide el gate |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Para entender el diseño, los adapters y el modelo de datos |
| [docs/PROMPT_AUTHORING.md](docs/PROMPT_AUTHORING.md) | Para escribir o adaptar el catálogo de prompts |
| [docs/runbook-google-sso.md](docs/runbook-google-sso.md) | Para configurar el login con Google |
| [docs/runbook-deploy-prod.md](docs/runbook-deploy-prod.md) | Para el deploy en AWS |
| [examples/](examples/) | Flujos de punta a punta ejecutables, con transcripts |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Para contribuir: setup, tests, migraciones, catálogo, PRs |

## Licencia

[MIT](LICENSE)
