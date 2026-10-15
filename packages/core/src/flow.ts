import { z } from 'zod';

export const FlowStatus = z.enum([
  'draft',
  'prd_ready',
  'rfc_ready',
  'backlog_ready',
  'impl_in_review',
  'merged',
  'aborted',
]);
export type FlowStatus = z.infer<typeof FlowStatus>;

export const CurrentPhase = z.enum([
  'prd',
  'rfc',
  'shaping',
  'implementation',
  'qa',
  'review',
  'done',
]);
export type CurrentPhase = z.infer<typeof CurrentPhase>;

export const ArtifactRef = z.object({
  url: z.string().url().optional(),
  repo_path: z.string().optional(),
  sha256: z.string().optional(),        // markdown hash (unchanged)
  external_id: z.string().optional(),   // = .md file Drive id when published to Drive
  gdoc_id: z.string().optional(),       // = native Google Doc Drive id (Drive doc_store only)
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

export const ArchitectureMode = z.enum(['new', 'reuse', 'hybrid']);
export type ArchitectureMode = z.infer<typeof ArchitectureMode>;

export const CodebaseStatus = z.enum(['greenfield', 'existing']);
export type CodebaseStatus = z.infer<typeof CodebaseStatus>;

export const InitiativeType = z.enum(['improvement', 'feature', 'refactor', 'fix']);
export type InitiativeType = z.infer<typeof InitiativeType>;

/**
 * Cuánta ceremonia exige un flow antes de dejar implementar.
 *
 *  - `full`: PRD → RFC → shaping, que es el camino de siempre.
 *  - `lite`: una nota de cambio y las stories, en una sola llamada.
 *
 * Sólo cambia el descubrimiento. Las gates de entrega —plan de QA, el sobre con
 * `test_exit_code` y cobertura, y la separación entre quien implementa y quien
 * firma— son idénticas en los dos tracks.
 */
export const FlowTrack = z.enum(['full', 'lite']);
export type FlowTrack = z.infer<typeof FlowTrack>;

/**
 * El track de cada tipo de iniciativa.
 *
 * `Record<InitiativeType, FlowTrack>` y no un `switch` con default: agregar un
 * `initiative_type` nuevo sin decidirle un track no compila, que es exactamente
 * cuándo queremos enterarnos.
 */
const TRACK_POR_INICIATIVA: Record<InitiativeType, FlowTrack> = {
  fix: 'lite',
  improvement: 'lite',
  feature: 'full',
  refactor: 'full',
};

/**
 * Deriva el track del `initiative_type`. No se persiste: `flow.initiative_type` es
 * la única fuente de verdad, así que no hay drift posible entre los dos.
 *
 * Sin `initiative_type` el track es `full`. `Flow.initiative_type` es opcional y los
 * flows anteriores a la migración `0011` pueden no tenerlo: el default seguro es la
 * ceremonia completa, porque un flow viejo no puede quedar habilitado para saltearse
 * el PRD por omisión.
 */
export function trackForInitiative(t?: InitiativeType): FlowTrack {
  if (!t) return 'full';
  return TRACK_POR_INICIATIVA[t];
}

export const ComponentKind = z.enum(['app', 'infra']);
export type ComponentKind = z.infer<typeof ComponentKind>;

/**
 * A unit of an epic that maps to exactly one repository. An epic can touch
 * several repos (app services + Terraform/IaC modules), so the flow carries a
 * registry of components declared in the RFC frontmatter. Each story targets
 * exactly one component (1 story = 1 repo = 1 PR).
 */
export const FlowComponent = z.object({
  name: z.string().min(1), // unique within the flow, e.g. "checkout-api", "vpc-tf"
  kind: ComponentKind, // "app" code vs "infra" (Terraform/IaC)
  repo: z.string().min(1), // repo URL or identifier
  repo_project: z.string().optional(), // integration project key for PR provider; defaults to flow.project
});
export type FlowComponent = z.infer<typeof FlowComponent>;

export const Flow = z.object({
  flow_id: z.string(),
  tenant_id: z.string(),
  project: z.string(),
  slug: z.string(),
  title: z.string(),
  status: FlowStatus,
  current_phase: CurrentPhase,
  prd_ref: ArtifactRef.optional(),
  rfc_ref: ArtifactRef.optional(),
  /** Nota de cambio del track liviano: reemplaza a prd_ref + rfc_ref. */
  change_note_ref: ArtifactRef.optional(),
  epic_external_id: z.string().optional(),
  architecture_mode: ArchitectureMode.optional(),
  codebase_status: CodebaseStatus.optional(),
  existing_repo: z.string().optional(),
  components: z.array(FlowComponent).optional(),
  initiative_type: InitiativeType.optional(),
  /** Ruta de carpetas del doc store, derivada del modelo y fijada en el primer publish. */
  doc_folder_path: z.array(z.string()).optional(),
  adr_refs:  z.array(ArtifactRef).optional(),
  adr_count: z.number().int().nonnegative().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Flow = z.infer<typeof Flow>;

export const FlowEventType = z.enum([
  'flow.started',
  'prd.submitted',
  'prd.validated',
  'rfc.submitted',
  /** Nota de cambio del track liviano: reemplaza a prd.submitted + rfc.submitted. */
  'change_note.submitted',
  'rfc.validated',
  'breakdown.proposed',
  'epic.created',
  'stories.created',
  'subtasks.linked',
  'backlog.synced',
  'story.claimed',
  'progress.reported',
  'qa.plan.generated',
  /**
   * Corrida de QA admitida. **Su payload lleva los resultados con sus
   * `evidence_url` y el envelope de la corrida**, no sólo contadores: sin eso un
   * replay del log no recupera qué evidencia se presentó, y el gate de evidencia
   * queda siendo contable en vez de auditable. La forma está en
   * `QaResultsSubmittedPayload` (`./story.js`) — se define allá y no acá para no
   * meter un ciclo de imports, porque `story.js` ya importa de este módulo.
   */
  'qa.results.submitted',
  'story.blocked',
  'story.discarded',
  'review.requested',
  'review.outcome.submitted',
  // Abandono explícito de la iniciativa. `FlowStatus.aborted` existía en el enum
  // desde el principio y ninguna tool lo seteaba, así que un flow abandonado no
  // tenía salida: se quedaba para siempre en la fase donde murió. `abort_flow` es
  // la única tool que lo produce y este evento, con su motivo, es la única traza.
  'flow.aborted',
  'prd.published',
  'rfc.published',
  'adr.submitted',
]);
export type FlowEventType = z.infer<typeof FlowEventType>;

export const FlowEvent = z.object({
  flow_id: z.string(),
  type: FlowEventType,
  actor: z.string(),
  payload: z.record(z.unknown()),
  ts: z.string(),
});
export type FlowEvent = z.infer<typeof FlowEvent>;
