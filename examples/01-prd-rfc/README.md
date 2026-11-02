# Ejemplo 01 — Flujo completo Fase 1 (PRD → RFC)

Walkthrough end-to-end del flujo Fase 1 del MCP. Ejecuta un caso de feature real ("Pago en cuotas") atravesando las dos primeras fases del SDLC: **Product Manager redacta el PRD** y **Tech Lead redacta el RFC**.

Muestra:

- Discovery del server (`/health`, `/.well-known/mcp`).
- Apertura del flow con `start_flow`.
- Entrega del **system prompt + skills + template** al agente PM vía `get_role_prompt`.
- Envío del PRD real (`fixtures/prd.md`) vía `submit_prd` — el server lo valida estructuralmente y avanza el flow a `prd_ready` / `phase=rfc`.
- `validate_prd` dry-run con un PRD incompleto para mostrar el detalle de issues.
- `generate_rfc_skeleton` hidratando el template `rfc-template` con metadata del flow (título, autor, fecha, ref al PRD).
- `get_role_prompt` para el Tech Lead.
- Envío del RFC real (`fixtures/rfc.md`) vía `submit_rfc` — avanza el flow a `rfc_ready` / `phase=shaping`.
- `get_flow_state` final con la **audit trail completa** (`flow.started`, `prd.submitted`, `rfc.submitted`).

## Cómo correrlo

Desde la raíz del repo:

```bash
./examples/01-prd-rfc/run.sh
```

El script levanta el server local en puerto 3030, ejecuta el flujo y mata el server al terminar. Si querés reutilizar un server ya corriendo:

```bash
BASE_URL=http://localhost:3000 \
OAUTH_SIGNING_SECRET=<el OAUTH_SIGNING_SECRET del server> \
PUBLIC_URL=<el PUBLIC_URL del server> \
  ./examples/01-prd-rfc/run.sh
```

El MCP solo acepta access tokens firmados por su propio servidor OAuth. Para no pasar
por el login OIDC, el script firma localmente un token equivalente con el mismo
`OAUTH_SIGNING_SECRET`, con roles `product-manager,tech-lead` y membresía en el
workspace del ejemplo. Por eso, contra un server que ya está corriendo tenés que pasarle
el mismo secreto y el mismo `PUBLIC_URL` (que es el issuer del token). Usalo solo contra
un server local cuyo secreto conozcas, nunca contra un deploy compartido.

Requisitos: `bash`, `curl`, `python3`, `jq`. El server se compila la primera vez (`pnpm --filter @sdlc/server build`).

## Archivos

```
examples/01-prd-rfc/
├── README.md              # este archivo
├── run.sh                 # script ejecutable
└── fixtures/
    ├── prd.md             # PRD válido que pasa todas las reglas
    └── rfc.md             # RFC válido que pasa todas las reglas
```

## Salida esperada (resumida)

```
0) /health + /.well-known/mcp
   ok, 10 tools listadas

1) start_flow
   → flow_id=demo-tenant:checkout-<ts>:pago-en-cuotas
   status=draft, current_phase=prd

2) get_role_prompt(product-manager, prd-draft)
   skills=[skill-prd-template], templates=[prd-template]
   next_actions=[submit_prd, validate_prd]

3) submit_prd (fixtures/prd.md, 9 secciones)
   ok=true, status=prd_ready, current_phase=rfc
   prd_ref.sha256=<...>

4) validate_prd dry-run (PRD incompleto)
   ok=false, issue_count=6 (problem, users, success_metrics, scope,
                          out_of_scope, risks faltantes)

5) generate_rfc_skeleton
   Template rfc hidratado con título + autor + fecha + prd_ref

6) get_role_prompt(tech-lead, rfc-draft)
   skills=[skill-rfc-template]

7) submit_rfc (fixtures/rfc.md, 9 secciones)
   ok=true, status=rfc_ready, current_phase=shaping
   rfc_ref.repo_path=/docs/rfc/cuotas.md, sha256=<...>

8) get_flow_state final
   events: [flow.started, prd.submitted, rfc.submitted]
```

## Qué validar después de correrlo

| Comprobación | Resultado esperado |
|---|---|
| `flow.status` final | `rfc_ready` |
| `flow.current_phase` final | `shaping` |
| `prd_ref` y `rfc_ref` presentes en el flow | Sí, con `sha256` + `repo_path` |
| Cuerpo del PRD/RFC almacenado server-side | **No** (solo referencias) |
| Validación PRD bloquea avance si faltan secciones | Sí (mirá el paso 4) |
| Eventos en orden | `flow.started` → `prd.submitted` → `rfc.submitted` |
| Aislamiento multi-tenant | Cubierto por test unit `flow.test.ts` |

## De qué NO se ocupa este ejemplo

- **Persistencia real**: el flow vive en memoria (`InMemoryFlowStore`). Fase 2 lo migra a Postgres + drizzle.
- **Sistema externo de tareas** (Jira/Linear/GitHub): se llega hasta `phase=shaping` pero las tools `propose_breakdown` / `create_epic` / `create_stories` se agregan en Fase 2.
- **OAuth**: la auth es API key bootstrap. OAuth/OIDC corporativo es Fase 4.
- **Roles 3-6** (pmo, developer, qa, reviewer): se cargan al catálogo en Fase 2.3.
