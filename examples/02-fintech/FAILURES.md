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
- **Arreglo propuesto:** agregar `'change-note'` a `DocPublishInput.doc_kind` y usarlo
  en `submit_change_note`.
- **Estado:** abierto. Lo vamos a ver en vivo si el flow 05 o el 07 escalan de track.

### H-02 · El doc store de Drive no sirve con una cuenta personal de Google

- **Dónde:** setup del ejemplo.
- **Qué pasa:** `GoogleDriveDocStoreAdapter` trabaja contra un Shared Drive
  (`corpora: 'drive'`), y las cuentas @gmail.com no pueden crearlos.
- **Resolución:** nuevo adapter `github-repo` (`github-repo-docstore.ts`, con tests),
  que es el que usa el ejemplo.
