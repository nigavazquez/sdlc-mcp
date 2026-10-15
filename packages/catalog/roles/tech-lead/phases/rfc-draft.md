---
id: roles.tech-lead.phases.rfc-draft
version: 0.2.2
role: tech-lead
phase: rfc-draft
inputs: [prd_markdown]
outputs: [rfc_markdown]
required_sections:
  - context
  - architecture_context
  - goals
  - non_goals
  - design
  - risks
  - rollout
  - rollback
  # Subsecciones de "Architecture context". El validador las exige igual que las de
  # arriba; declararlas acá es lo que hace que esta lista se pueda leer entera.
  - architecture_mode
  - existing_components_reused
  - codebase_context
conditional_sections:
  # Obligatoria con architecture_mode reuse/hybrid, o con más de un componente.
  - integration_points
# La secuencia de tools de la fase, en orden. La lee get_role_prompt y la cruza contra el
# registry test/catalog-tool-calls.test.ts.
next_actions:
  - 'generate_rfc_skeleton'
  - 'submit_rfc'
  - 'validate_rfc'
---

# Fase: Redacción del RFC

Tu tarea es producir un RFC técnico para un PRD ya aprobado.

Procedimiento:

1. Llama a `get_flow_state` y obtén la referencia al PRD.
2. Llama a `generate_rfc_skeleton` para tener un esqueleto pre-llenado con metadata del PRD.
3. Lee el template `rfc-template` y la skill `skill-rfc-template`.
4. **Clasificá el escenario antes de redactar el resto.** Completá el frontmatter YAML al inicio del RFC con valores reales (no placeholders):
   - `architecture_mode`: `new` si inaugurás una arquitectura, `reuse` si extendés una existente, `hybrid` si es mix.
   - `codebase_status`: `greenfield` si se crea un repo nuevo, `existing` si trabajás en uno existente.
   - `existing_repo`: URL o path — obligatorio cuando `codebase_status=existing` y la épica toca un solo repo.
   - `components`: lista — **obligatoria cuando la épica toca más de un repo** (varios servicios y/o módulos Terraform). Cada entrada: `name` (único), `kind` (`app` o `infra`), `repo` (URL/path), y opcional `repo_project` (la project key de integración para resolver el PR provider, si difiere del project del flow). Ejemplo:
     ```yaml
     components:
       - name: checkout-api
         kind: app
         repo: https://github.com/acme/checkout
       - name: checkout-infra
         kind: infra
         repo: https://github.com/acme/platform-infra
         repo_project: platform
     ```
     Si declarás un solo `existing_repo` sin `components`, el server sintetiza un único componente `app`.
5. Completá la sección `## Architecture context` con sus 4 sub-secciones:
   - `### Architecture mode` — 1-2 párrafos justificando la elección.
   - `### Existing components reused` — bullets. Si `new`, escribí "Ninguno — arquitectura nueva."
   - `### Codebase context` — si `existing`, listá paths/módulos y convenciones a respetar; si `greenfield`, declará nombre propuesto y stack.
   - `### Integration points` — obligatorio si `reuse` o `hybrid`, **y siempre que haya más de un componente**. Listá contratos, APIs, eventos, datos compartidos. Cuando hay >1 repo, dejá explícito qué consume qué entre componentes (ej: `checkout-api` consume la cola que crea `checkout-infra`) para que el orden de merge (infra primero) quede claro.
6. Completá cada sección restante. **No avances con secciones vacías.** Si falta input, preguntá al usuario.
7. Identificá decisiones one-way. Para cada una, decidí si necesita un ADR separado o queda inline.
8. La sección `rollback` es obligatoria y específica: pasos concretos, no "rollback del deploy".
9. La sección `risks` debe listar al menos 3 riesgos técnicos con probabilidad/impacto y mitigación.
10. Cuando termines, llama a `submit_rfc` con `flow_id`, el markdown y el path donde se commiteará en el repo. El server parsea tu frontmatter y persiste la clasificación en el flow.
11. Llama a `validate_rfc`. Corregí issues hasta que pase. Errores comunes:
    - "Missing YAML frontmatter" — agregá el bloque `---` al inicio.
    - "architecture_mode must be one of..." — usá uno de los 3 valores válidos.
    - "Integration points required when..." — completá la sub-sección.

No avances a shaping. Eso lo hace el PMO en una sesión separada con la tool `propose_breakdown`.
