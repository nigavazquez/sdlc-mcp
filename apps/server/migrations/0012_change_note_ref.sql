-- 0012: la nota de cambio del track liviano.
--
-- Los flows con initiative_type fix|improvement no producen PRD ni RFC: producen una
-- nota de cambio, que se ancla igual que los otros artefactos (referencia + sha256,
-- nunca el cuerpo). Misma forma que prd_ref/rfc_ref, así que verify_artifact la puede
-- verificar contra el doc store.
--
-- Aditiva a propósito: un flow del track completo conserva su prd_ref y su rfc_ref, y
-- uno liviano que escale a completo va a tener los tres.
ALTER TABLE "flows" ADD COLUMN IF NOT EXISTS "change_note_ref" jsonb;
