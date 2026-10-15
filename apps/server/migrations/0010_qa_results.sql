-- Evidencia de QA persistida y auditable.
--
-- Hasta acá `submit_qa_results` exigía `evidence_url` en todos los casos y
-- después descartaba el array entero: no se guardaba en la story ni en el evento,
-- así que nadie podía auditar a posteriori qué se dijo haber corrido.
--
--  * "qa_results"  = los resultados de la última corrida admitida, con su evidencia.
--  * "qa_envelope" = el bloque estructurado de esa corrida (sdlc.qa-result/v1):
--                    test_command, test_exit_code, test_output_hash, acceptance_criteria.
--
-- Ambas jsonb y nullable: es un ADD COLUMN sin backfill ni reescritura de tabla.
-- Las stories anteriores quedan en NULL, que es lo correcto — son corridas de
-- antes del gate y no hay evidencia que inventarles.
ALTER TABLE "stories"
  ADD COLUMN IF NOT EXISTS "qa_results"  jsonb,
  ADD COLUMN IF NOT EXISTS "qa_envelope" jsonb;
