-- 0013: los dos ejes del review, persistidos en la story.
--
-- Mismo razonamiento que qa_envelope (migración 0010): sin esto, "lo revisé contra el
-- spec" es una afirmación sin respaldo y el log no recupera qué se miró. Guarda el
-- último review admitido; el histórico completo vive en el log de eventos.
ALTER TABLE "stories" ADD COLUMN IF NOT EXISTS "review_envelope" jsonb;
