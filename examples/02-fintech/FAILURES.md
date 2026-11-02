# Fallas y correcciones: índice del ejemplo

Las fallas de cada flow están en `evidence/NN-flow/failures.md`. Acá se agrupan por tipo
a medida que los flows cierran, junto con los hallazgos sobre el propio `sdlc-mcp`.

## Por tipo

| Tipo | Flows | Ejemplo |
|---|---|---|
| Validación de PRD / RFC / nota | — | — |
| Rol insuficiente | — | — |
| Self-signoff | — | — |
| Evidencia de QA rechazada | — | — |
| PR de otro repo / PR cerrado | — | — |
| Review incoherente entre ejes | — | — |

## Hallazgos sobre sdlc-mcp

### H-01 · La nota de cambio se publica como `prd.md`

- **Dónde:** `apps/server/src/mcp/tools/submit-change-note.ts`, que llama
  `ds.publish({ doc_kind: 'prd', … })`. Lo encontré leyendo el código para el adapter
  `github-repo`, antes de correr ningún flow.
- **Qué pasa:** en el doc store, la nota de un flow liviano queda guardada como
  `<flow>/prd.md`. Si el flow escala de track (lo permitido: un fix que creció llama
  `submit_prd`), el PRD se publica en el mismo path y **pisa la nota**. En el repo queda
  en la historia de git; en Drive se actualiza el mismo archivo.
- **Impacto:** se pierde el documento vigente de la fase anterior, y `verify_artifact`
  sobre `change_note_ref` pasa a comparar contra el PRD y reporta un mismatch falso.
- **Arreglo:** `DocPublishInput.doc_kind` suma `'change-note'` y `submit_change_note` lo
  usa, así que la nota queda en `<flow>/change-note.md` y el PRD de una escalada va a su
  propio archivo. `submit_prd` no frena un flow que ya tiene nota (solo uno abortado), así
  que el escenario era alcanzable en el mismo flow.
- **Test:** `submit-change-note.test.ts` › *el PRD de la escalada no pisa la nota
  publicada*: nota, PRD sobre el mismo flow, y `verify_artifact(change_note)` da `match`.
  Con el código anterior falla.
- **Estado:** cerrado antes de correr los flows. Los docs que ya estén publicados como
  `prd.md` por una nota no se migran (no había ninguno).

### H-02 · El doc store de Drive no sirve con una cuenta personal de Google

- **Dónde:** setup del ejemplo.
- **Qué pasa:** `GoogleDriveDocStoreAdapter` trabaja contra un Shared Drive
  (`corpora: 'drive'`), y las cuentas @gmail.com no pueden crearlos.
- **Resolución:** nuevo adapter `github-repo` (`github-repo-docstore.ts`, con tests),
  que es el que usa el ejemplo.
