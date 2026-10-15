-- 0011: la ruta de carpetas de documentos deja de ser texto libre (tribu/squad) y
-- pasa a derivarse del modelo (group + workspace). doc_folder_path guarda la ruta
-- efectiva de cada flow: se backfillea con la histórica para no mover de lugar los
-- documentos ya publicados en Drive.
--
-- El upsert del adapter matchea por nombre DENTRO de la carpeta destino, así que si
-- la ruta de un flow existente cambiara, un re-publish no actualizaría el documento:
-- crearía un duplicado en la carpeta nueva. De ahí el backfill.
ALTER TABLE "flows" ADD COLUMN IF NOT EXISTS "doc_folder_path" text[];

-- Backfill ANTES del drop: al revés se perderían los datos.
UPDATE "flows"
   SET "doc_folder_path" = ARRAY["tribu", "squad"]
 WHERE "tribu" IS NOT NULL AND "squad" IS NOT NULL;

UPDATE "flows"
   SET "doc_folder_path" = ARRAY["tribu"]
 WHERE "tribu" IS NOT NULL AND "squad" IS NULL;

ALTER TABLE "flows" DROP COLUMN IF EXISTS "tribu";
ALTER TABLE "flows" DROP COLUMN IF EXISTS "squad";
