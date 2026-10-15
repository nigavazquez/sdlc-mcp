---
id: roles.developer.phases.change-note
version: 0.2.0
role: developer
phase: change-note
inputs: [flow_id]
outputs: [change_note_markdown, stories]
required_sections:
  - what
  - evidence
  - change
  - verification
# La secuencia de tools de la fase, en orden. La lee get_role_prompt y la cruza contra el
# registry test/catalog-tool-calls.test.ts.
next_actions:
  - 'submit_change_note'
  - 'claim_story'
---

# Fase: Nota de cambio

Tu tarea es escribir la nota de cambio de una iniciativa del track liviano (un `fix` o
un `improvement`) y dejar el flow listo para implementar. Reemplaza al PRD y al RFC:
para un cambio chico, esos dos documentos piden proyecciones que no existen y el
resultado es inventarlas.

Procedimiento:

1. Leé el template `change-note-template` y seguí sus cuatro secciones. No agregues
   otras: la nota vale por ser corta.
2. **Declará el repo en el frontmatter** (`repo: <owner>/<repo>`, o `components:` si el
   cambio toca más de uno). No es documentación: el gate de code review compara el PR
   contra ese repo, y sin él la story nace sin nada contra qué verificarse.

   Declará también **cómo se reproduce**: `repro: '<comando que falla hoy>'`, o
   `no_repro: <por qué>` si no lo pudiste reproducir. Las dos son válidas; el server
   rechaza la nota si no dice ninguna. Leé `skill-repro-antes-del-fix` para qué hace bueno
   a un repro.
3. Completá "Cómo lo sé" con evidencia real — un repro, un id de log, un ticket, el
   test que falla. **Si no tenés evidencia, no inventes un repro**: escribí qué sabés
   y de dónde viene. Una nota que dice "reportado por soporte, no reproducido" es
   honesta y cambia cómo se verifica; una que describe un repro que nunca corriste es
   una mentira que alguien va a intentar seguir.
4. Escribí las stories, casi siempre una. Cada una necesita título, descripción y
   criterios de aceptación concretos: son los mismos criterios contra los que después
   se va a medir la cobertura en `submit_qa_results`, y ahí el denominador tiene que
   coincidir. Una story es un repo y un PR.
5. Llamá `submit_change_note({flow_id, change_note_markdown, stories})`. El server
   valida la nota **antes** de escribir nada: si falla, corregí el markdown y reenviá.
   Si pasa, quedan creados el epic y las stories, y el flow avanza a `backlog_ready`.
6. Seguí con `claim_story` y la fase `implement`. De ahí en adelante el camino es el
   mismo que el de cualquier iniciativa: el plan de QA, el sobre de evidencia y el
   review no cambian, y quien implementó no puede firmar su propia verificación.

Cuándo **no** usar esta fase:

- Si el cambio agrega una capacidad nueva o cambia una interfaz de la que dependen
  otros, es una `feature`: va por `submit_prd` y `submit_rfc`.
- Si mientras escribís la sección "Qué cambio" necesitás discutir alternativas de
  arquitectura o dibujar un diagrama, el cambio dejó de ser chico. Decilo y abrí un
  flow del track completo — descubrirlo mientras escribís es barato; descubrirlo
  durante el review, no.
