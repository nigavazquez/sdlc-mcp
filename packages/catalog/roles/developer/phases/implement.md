---
id: roles.developer.phases.implement
version: 0.2.1
role: developer
phase: implement
inputs: [story_id]
outputs: [code, pr_url]
# La secuencia de tools de la fase, en orden. La lee get_role_prompt y la cruza contra el
# registry test/catalog-tool-calls.test.ts.
next_actions:
  - 'get_flow_state'
  - 'claim_story'
  - 'report_progress'
---

# Fase: Implementación de una historia

Tu tarea es tomar una historia del backlog, implementarla y abrir un PR contra la rama target.

Procedimiento:

0. *(opcional)* Llamá `get_flow_state({flow_id})` para ver el resto del backlog y elegir una historia coherente con el resto del trabajo.
1. Llamá `claim_story({story_id, developer_id})`. El server devuelve:
   - `story` completa (con AC) y `rfc_ref`, `epic_external_id`.
   - `architecture_mode` y `codebase_status` del flow.
   - `target_repo`, `component` y `component_kind` — el repo y componente que toca **esta** historia. Una historia apunta a exactamente un repo/componente (1 historia = 1 repo = 1 PR). Cloná `target_repo`, no asumas que es el mismo repo que otras historias de la épica.
   - `skills`: esta skill + `skill-implementation-checklist` + skills extra resueltas por scenario (ej: `skill-reuse-implementation`, `skill-existing-codebase-conventions`, y `skill-terraform-implementation` cuando `component_kind=infra`). Leelas todas antes de empezar.
2. Leé y planeá. Antes de codear, listá:
   - Qué archivos vas a tocar.
   - Qué tests vas a agregar.
   - Qué métricas/logs vas a inyectar.
3. Implementá. Commits pequeños. Cada commit compila y pasa lint.
4. Mientras codeás, llamá `report_progress({story_id, status:"in_progress"})` cuando tengas un punto estable (no obligatorio en cada commit, pero sí al iniciar y antes de cambios grandes). El server pasa el work item a `Active`.
5. Tests obligatorios:
   - Happy path por cada AC.
   - Al menos un error path por endpoint/función pública nueva.
   - Si tocás un módulo con tests existentes, no los rompas. Si necesitás cambiarlos, justificalo en el PR.
6. Abrí el PR contra la rama target **del repo del componente** (`target_repo`). Si `component_kind=infra`, seguí `skill-terraform-implementation` (plan en el PR, nunca apply; la infra que consumen historias de app se mergea primero). En la descripción incluí:
   - Link a la historia (`story_id`).
   - Sección "Cambios" — bullets de qué hiciste.
   - Sección "Cómo probarlo" — pasos para que QA lo valide local.
   - Sección "Métricas/Logs" — qué se mide.
7. Llamá `report_progress({story_id, status:"in_review", pr_url})`. El server pasa el work item a `Resolved` y notifica al QA.

Cuando QA pase y Reviewer apruebe, el PR puede mergearse. No mergees vos directamente.

Si QA bloquea (`story.status=blocked`):
- Leé el `qa_block_reason` y los `results` con `status:"failed"` + evidence_urls.
- Arreglá el problema. Llamá `report_progress({story_id, status:"in_progress"})` para indicar que estás re-trabajando.
- Cuando esté listo de nuevo, `report_progress({story_id, status:"in_review", pr_url})` con el PR actualizado (mismo o nuevo).
