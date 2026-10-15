import { z } from 'zod';
import { ComponentKind } from './flow.js';

export const StoryStatus = z.enum([
  'created',
  'claimed',
  'in_progress',
  'in_review',
  'qa_passed',
  'blocked',
  'merged',
  /**
   * Terminal de descarte: la story no se va a hacer. Es el contrapeso de que
   * `merged` sea el único terminal — sin él, una story creada de más (un array
   * de más en `create_stories`, que es una sola llamada sin deshacer) dejaba el
   * flow sin poder cerrar nunca, porque el cierre exige que ninguna hermana
   * quede fuera de `merged` y `blocked` tampoco lo es.
   *
   * Sólo lo setea `discard_story`, que exige rol tech-lead: un estado terminal
   * que cualquiera pudiera setear sería un bypass del conteo de pendientes.
   */
  'discarded',
]);
export type StoryStatus = z.infer<typeof StoryStatus>;

export const StoryQaCase = z.object({
  case_id: z.string().min(1),
  description: z.string().min(1),
  ac_ref: z.string().optional(),
  type: z.enum(['ac', 'edge', 'perf']),
});
export type StoryQaCase = z.infer<typeof StoryQaCase>;

export const StoryQaPlan = z.object({
  cases: z.array(StoryQaCase).min(1),
  generated_at: z.string(),
});
export type StoryQaPlan = z.infer<typeof StoryQaPlan>;

export const StoryQaResult = z.object({
  case_id: z.string().min(1),
  status: z.enum(['passed', 'failed']),
  /**
   * URL de la evidencia del caso. **Obligatoria para todo caso reportado**, sea
   * `passed` o `failed`: la exige `submit_qa_results`, no este schema.
   *
   * Por qué acá queda `optional()` y sin `.url()`:
   * el schema de input se valida en el borde MCP (`inputSchema.parse` en
   * `apps/server/src/mcp/server.ts`) y una violación ahí **tira** — el caller
   * recibe un error de zod, no el `{ ok:false, error }` del repo. Un error de
   * zod no puede nombrar *todos* los `case_id` sin evidencia de una, ni la
   * salida ejecutable, así que el agente hace N round-trips adivinando. Con el
   * campo laxo acá, la presencia y la forma (esquema http(s), host plausible,
   * allowlist) las valida el handler y devuelve un solo mensaje accionable.
   */
  evidence_url: z
    .string()
    .min(1)
    .optional()
    .describe(
      'URL http(s) de la evidencia del caso (corrida de CI, log, video, ticket). ' +
        'Obligatoria en submit_qa_results para todos los casos, pasen o fallen.',
    ),
  notes: z.string().optional(),
});
export type StoryQaResult = z.infer<typeof StoryQaResult>;

export const QaVerdict = z.enum(['passed', 'blocked']);
export type QaVerdict = z.infer<typeof QaVerdict>;

// ---------------------------------------------------------------------------
// Envelope de resultado de QA
// ---------------------------------------------------------------------------

/**
 * Versión del envelope que `submit_qa_results` sabe leer. Es un literal y no un
 * "compatible con": si algún día cambia la forma, cambia el tag y el server
 * rechaza los viejos con un mensaje que dice qué mandar.
 */
export const QA_ENVELOPE_SCHEMA = 'sdlc.qa-result/v1';

/**
 * Bloque estructurado que acompaña a los `results`, tal como llega del agente.
 *
 * **Todos los campos son opcionales acá a propósito**, igual que `evidence_url`:
 * el schema de input se valida en el borde MCP (`inputSchema.parse` en
 * `apps/server/src/mcp/server.ts`) y una violación ahí **tira** — el caller
 * recibe un error de zod, no el `{ ok:false, error }` del repo. Un error de zod
 * no puede enumerar los cinco campos mal de una sola vez ni nombrar la salida
 * ejecutable, así que el agente hace N round-trips adivinando. La validación de
 * verdad la hace `validateQaEnvelope`
 * (`apps/server/src/validation/qa-envelope.ts`) dentro del handler, y devuelve
 * un solo mensaje accionable con todos los problemas juntos.
 */
export const QaRunEnvelopeInput = z.object({
  schema: z
    .string()
    .optional()
    .describe(`Tiene que ser exactamente "${QA_ENVELOPE_SCHEMA}".`),
  test_command: z
    .string()
    .optional()
    .describe('El comando exacto que corriste, p.ej. "pnpm --filter @sdlc/server test".'),
  test_exit_code: z
    .number()
    .int()
    .optional()
    .describe('Código de salida del comando. 0 = la corrida pasó. Un verdict "passed" lo exige 0.'),
  test_output_hash: z
    .string()
    .optional()
    .describe(
      'sha256 del output completo de la corrida, con prefijo: "sha256:<64 hex>". ' +
        'No se verifica contra nada (el server no corrió los tests): es trazabilidad.',
    ),
  acceptance_criteria: z
    .string()
    .optional()
    .describe(
      'Cobertura de criterios de aceptación, formato "<cubiertos>/<total>". El total es el de la ' +
        'story (acceptance_criteria.length) y se verifica; no lo elegís vos.',
    ),
});
export type QaRunEnvelopeInput = z.infer<typeof QaRunEnvelopeInput>;

/**
 * El envelope ya validado y normalizado, tal como se persiste en la story y se
 * emite en el evento `qa.results.submitted`.
 */
export const StoryQaEnvelope = z.object({
  schema: z.literal(QA_ENVELOPE_SCHEMA),
  test_command: z.string().min(1),
  test_exit_code: z.number().int().min(0).max(255),
  /** `sha256:<64 hex>`, en minúsculas. */
  test_output_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** `total` sale de `story.acceptance_criteria.length`, nunca del agente. */
  acceptance_criteria: z.object({
    covered: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  submitted_at: z.string(),
});
export type StoryQaEnvelope = z.infer<typeof StoryQaEnvelope>;

// ---------------------------------------------------------------------------
// Review en dos ejes
// ---------------------------------------------------------------------------

/** Versión del envelope de review que `submit_review_outcome` sabe leer. */
export const REVIEW_ENVELOPE_SCHEMA = 'sdlc.review/v1';

/**
 * Un hallazgo del review, anclado en el código.
 *
 * `file` es obligatorio porque un hallazgo que no se puede ubicar no se puede
 * arreglar: "hay un problema de naming" manda a releer el diff entero. `line` es
 * opcional — hay hallazgos que son sobre el archivo, no sobre una línea.
 */
export const ReviewFinding = z.object({
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  why: z.string().min(1).describe('Qué está mal y por qué importa, en una o dos frases.'),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

/**
 * El resultado de uno de los dos ejes.
 *
 *  - `ok`: sin hallazgos.
 *  - `advisory`: hay hallazgos, ninguno bloquea. Es el caso normal de los smells:
 *    son juicios, no violaciones.
 *  - `blocking`: hay al menos uno que tiene que arreglarse antes del merge.
 *
 * La coherencia entre el veredicto y los hallazgos la exige `validateReviewEnvelope`:
 * un `blocking` sin hallazgos no le dice a nadie qué arreglar, y un `ok` con
 * hallazgos se contradice solo.
 */
export const ReviewAxisReport = z.object({
  verdict: z.enum(['ok', 'advisory', 'blocking']),
  findings: z.array(ReviewFinding),
  summary: z.string().optional().describe('Una o dos frases sobre el eje, para la persona.'),
});
export type ReviewAxisReport = z.infer<typeof ReviewAxisReport>;

/**
 * Los dos ejes del review, que se miden por separado y **no se mezclan**.
 *
 *  - `standards`: conformidad con las convenciones del repo y el piso de smells.
 *  - `spec`: que el código haga lo que el RFC o la nota de cambio dijeron.
 *
 * Van separados porque responden preguntas distintas y se contaminan si los mira
 * el mismo contexto: un diff impecable puede implementar otra cosa, y uno que hace
 * exactamente lo pedido puede estar escrito contra todas las convenciones del repo.
 * Un veredicto único obliga a elegir cuál de los dos problemas contar.
 */
export const StoryReviewEnvelope = z.object({
  schema: z.literal(REVIEW_ENVELOPE_SCHEMA),
  standards: ReviewAxisReport,
  spec: ReviewAxisReport,
  submitted_at: z.string(),
});
export type StoryReviewEnvelope = z.infer<typeof StoryReviewEnvelope>;

/** Lo que manda el agente, antes de validar. Laxo a propósito: ver qa-envelope.ts. */
export const ReviewEnvelopeInput = z.object({
  schema: z.string(),
  standards: ReviewAxisReport,
  spec: ReviewAxisReport,
});
export type ReviewEnvelopeInput = z.infer<typeof ReviewEnvelopeInput>;

/**
 * Payload del evento `qa.results.submitted` (ver `FlowEventType` en `flow.js`).
 *
 * Lleva los resultados y sus evidencias, no sólo contadores. Antes el payload
 * era `{ story_id, verdict, case_count, failed_count }`: un replay del log
 * recuperaba *cuántos* casos hubo, pero no **qué evidencia se presentó** — que es
 * justamente lo único que hace auditable el proceso. `case_count` y
 * `failed_count` siguen ahí para no romper a nadie que ya los leía; los datos
 * nuevos son `results` y `envelope`.
 *
 * El schema vive acá para poder tipar un replay; el store no lo aplica al
 * escribir (`FlowEvent.payload` es un `record` abierto, igual que para el resto
 * de los eventos).
 */
export const QaResultsSubmittedPayload = z.object({
  story_id: z.string(),
  verdict: QaVerdict,
  case_count: z.number().int().nonnegative(),
  failed_count: z.number().int().nonnegative(),
  results: z.array(StoryQaResult),
  envelope: StoryQaEnvelope,
  block_reason: z.string().nullable().optional(),
});
export type QaResultsSubmittedPayload = z.infer<typeof QaResultsSubmittedPayload>;

export const Story = z.object({
  story_id: z.string().min(1),
  flow_id: z.string().min(1),
  external_id: z.string().min(1),
  external_url: z.string().url(),
  title: z.string().min(1),
  acceptance_criteria: z.array(z.string().min(1)),
  status: StoryStatus,
  assignee: z.string().optional(),
  // Target component (1 story = 1 repo = 1 PR). Denormalized from the flow's
  // component registry at creation time so the repo/skill can be resolved
  // without re-joining the flow.
  target_repo: z.string().optional(),
  component: z.string().optional(), // = FlowComponent.name
  component_kind: ComponentKind.optional(), // "app" | "infra"
  pr_url: z.string().url().optional(),
  qa_plan: StoryQaPlan.optional(),
  qa_verdict: QaVerdict.optional(),
  qa_block_reason: z.string().optional(),
  /**
   * Los resultados de la última corrida de QA admitida, con su evidencia.
   *
   * Antes esto no existía: `submit_qa_results` exigía `evidence_url` en todos los
   * casos y después **tiraba el array entero** — no quedaba en la story ni en el
   * evento. Se pedía evidencia y se descartaba, así que nadie podía auditar
   * después qué se dijo haber corrido. Persistir acá (y en el payload del evento)
   * es lo que convierte el gate en auditable.
   *
   * Guarda la última corrida **admitida**, no todas: el histórico completo vive
   * en el log de eventos, que es append-only.
   */
  qa_results: z.array(StoryQaResult).optional(),
  /** Envelope estructurado de esa misma corrida. Ver `StoryQaEnvelope`. */
  qa_envelope: StoryQaEnvelope.optional(),
  /**
   * Los dos ejes del último review admitido. Ver `StoryReviewEnvelope`.
   *
   * Se persiste por la misma razón que el envelope de QA: sin esto, "lo revisé
   * contra el spec" es una afirmación sin respaldo, y el histórico del log no
   * recupera qué se miró.
   */
  review_envelope: StoryReviewEnvelope.optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Story = z.infer<typeof Story>;
