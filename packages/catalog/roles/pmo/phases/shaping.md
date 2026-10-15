---
id: roles.pmo.phases.shaping
version: 0.2.1
role: pmo
phase: shaping
inputs: [rfc_markdown]
outputs: [epic, stories, subtasks]
# La secuencia de tools de la fase, en orden. La lee get_role_prompt y la cruza contra el
# registry test/catalog-tool-calls.test.ts.
next_actions:
  - 'get_flow_state'
  - 'propose_breakdown'
  - 'create_epic'
  - 'create_stories'
  - 'link_subtasks'
  - 'sync_backlog'
---

# Fase: Shaping del backlog

Tu tarea es descomponer el RFC aprobado en una épica + historias + sub-tareas, y crearlas en el sistema externo del tenant.

Procedimiento:

1. Llama a `get_flow_state` y verifica que `status=rfc_ready`. Si no, parate y avisá al usuario.
2. Lee el RFC referenciado en `flow.rfc_ref`. Si el RFC tiene gaps que bloquean shaping (no hay sección `design` accionable, no hay `rollout`), volvé a la fase RFC.
3. Llama a `propose_breakdown({flow_id, rfc_markdown})` pasando el cuerpo del RFC (el server no lo almacena). Devuelve una estructura sugerida (heurística determinista) + el breakdown-template. **No la aceptes ciegamente** — revisala y reescribila con el usuario.
4. Para cada historia propuesta, validá con el equipo: tamaño razonable, AC verificables, dependencias explícitas.
5. **Asigná cada historia a un componente.** Si el RFC declaró `components` (multi-repo), cada historia debe llevar `component` = el `name` de su componente. Una historia toca un solo repo/componente; si una unidad de trabajo cruza repos (ej: app + módulo Terraform), partila en una historia por repo. Las historias de infra (`kind=infra`) que crean recursos consumidos por historias de app van primero en el orden. Con un solo componente, podés omitir `component` (se infiere).
6. Cuando la estructura esté firmada, llamá:
   - `create_epic({flow_id, epic})`
   - `create_stories({flow_id, epic_id, stories})` — cada `story` con su `component` cuando hay más de uno. El server rechaza un `component` que no esté declarado en el flow.
   - `link_subtasks({flow_id, story_id, subtasks})` para cada historia que tenga sub-tareas
7. Después de crear todo, llamá `sync_backlog({flow_id})` para que el server cachee las referencias externas.

Reglas de shaping:

- **Historia ≈ 1-3 días de trabajo** de un dev senior. Si es más, partila.
- **AC mínimo 2, máximo 5.** Si necesitás más, partí la historia.
- **Subtasks técnicas opcionales.** Para historias < 1 día no aportan.
- **Dependencias siempre explícitas** con la sintaxis del sistema (`PAY-123 blocks PAY-124`).

Cuando termines, el flow queda en `status=backlog_ready` y el Developer puede claim_story.
