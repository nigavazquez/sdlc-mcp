import type {
  Approval,
  ApprovalArtifact,
  ApprovalRequest,
  ApprovalInvalidationReason,
  ArchitectureMode,
  ArtifactRef,
  CodebaseStatus,
  ComponentKind,
  CurrentPhase,
  Flow,
  FlowComponent,
  FlowEvent,
  FlowEventType,
  FlowStatus,
  InitiativeType,
  QaVerdict,
  Story,
  StoryQaEnvelope,
  StoryReviewEnvelope,
  StoryQaPlan,
  StoryQaResult,
  StoryStatus,
} from '@sdlc/core';

export interface CreateFlowInput {
  tenant_id: string;
  project: string;
  slug: string;
  title: string;
  initiative_type?: InitiativeType;
}

/**
 * Patch de flow **sin** `status`.
 *
 * `status` salió del tipo a propósito: es la invariante que sostiene el terminal
 * `aborted`, y mientras cualquier tool pudiera meterlo en un patch cualquiera la
 * única defensa era un censo por regex sobre las fuentes — que se evade con
 * `updateFlow(id, buildPatch())`, con un spread, con una clave computada o con un
 * cast. Ahora el compilador es el censo: para mover `flow.status` hay que nombrar
 * `updateFlowStatus`, que es una escritura condicional y no acepta patch anónimo.
 *
 * `updateFlow` además **rechaza en runtime** un patch que traiga la clave `status`
 * (ver `rejectStatusInFlowPatch`), porque el tipo solo no alcanza: TypeScript sólo
 * chequea propiedades de más en objetos literales frescos, así que un patch armado
 * en una variable o casteado pasaría el compilador.
 */
export interface UpdateFlowInput {
  current_phase?: CurrentPhase;
  prd_ref?: ArtifactRef;
  rfc_ref?: ArtifactRef;
  change_note_ref?: ArtifactRef;
  epic_external_id?: string;
  architecture_mode?: ArchitectureMode;
  codebase_status?: CodebaseStatus;
  existing_repo?: string;
  components?: FlowComponent[];
  adr_refs?: ArtifactRef[];
  adr_count?: number;
  initiative_type?: InitiativeType;
  /**
   * Ruta de carpetas del doc store. No es entrada de usuario: la escribe el primer
   * publish exitoso de submit_prd/submit_rfc/submit_adr para que un rename posterior
   * del workspace o su group no parta los documentos del flow en dos carpetas.
   */
  doc_folder_path?: string[];
}

/**
 * Aserción de compilación: `UpdateFlowInput` **no** tiene `status`.
 *
 * Es el censo de status, y corre en `pnpm typecheck`. Si alguien vuelve a agregar
 * `status?: FlowStatus` al patch genérico —el "arreglo" más natural cuando el
 * compilador se queja—, este alias pasa a ser `never` y la asignación de abajo no
 * compila, con el mensaje al lado. El censo por regex sobre las fuentes que había
 * antes se evadía con `updateFlow(id, buildPatch())`; esto no se evade.
 */
type PatchGenericoSinStatus = 'status' extends keyof UpdateFlowInput ? never : true;
export const PATCH_GENERICO_SIN_STATUS: PatchGenericoSinStatus = true;

/**
 * Transición de `flow.status`: el status nuevo más lo que lo acompañe en el mismo
 * patch (típicamente `current_phase`). El único que la construye es el chokepoint
 * de `mcp/tools/abort-flow.ts`.
 */
export interface FlowStatusTransition extends UpdateFlowInput {
  status: FlowStatus;
}

/**
 * Resultado de la escritura condicional de status.
 *
 * `applied:false` significa **no escribí**: la precondición ya no valía cuando la
 * escritura llegó al store. `flow` es el estado real de ahora (o `undefined` si el
 * flow no existe), para que el caller pueda decir *por qué* no escribió sin volver
 * a leer — una re-lectura sería otra carrera.
 */
export type FlowStatusWriteResult =
  | { applied: true; flow: Flow }
  | { applied: false; flow: Flow | undefined };

/**
 * Guarda de runtime de `updateFlow`: ningún patch genérico mueve `flow.status`.
 *
 * El tipo `UpdateFlowInput` ya no tiene `status`, pero el chequeo de propiedades de
 * más de TypeScript sólo corre sobre objetos literales frescos: `updateFlow(id, p)`
 * con `p` armado más arriba, `{...p}`, `{['status']:x}`, `Object.assign({},p)` o un
 * `p as UpdateFlowInput` compilan igual. Esta guarda cierra todas esas formas de una
 * sola vez porque mira el **valor**, no el texto del programa.
 *
 * Tira en vez de ignorar la clave: un patch con `status` es un bug de programación
 * (una tool que se saltea el chokepoint), no un input de usuario, y silenciarlo
 * dejaría la transición perdida sin que nadie se enterara.
 */
export function rejectStatusInFlowPatch(flowId: string, patch: UpdateFlowInput): void {
  if (!Object.prototype.hasOwnProperty.call(patch, 'status')) return;
  throw new Error(
    `updateFlow(${flowId}): el patch trae "status", y updateFlow no mueve flow.status. ` +
      'Toda transición de status pasa por updateFlowUnlessAborted (apps/server/src/mcp/tools/abort-flow.ts), ' +
      'que la escribe condicionalmente y se niega a pisar un flow aborted. Sacá status del patch y ' +
      'llamá al chokepoint.',
  );
}

export interface AppendEventInput {
  flow_id: string;
  type: FlowEventType;
  actor: string;
  payload: Record<string, unknown>;
}

/**
 * Storage abstraction for flow coordination state. Two implementations:
 * - InMemoryFlowStore: zero deps, used in tests and Fase 0/1 dev when DATABASE_URL is unset.
 * - PostgresFlowStore: drizzle-orm backed (added alongside the Fase 2 deploy).
 *
 * The MCP is stateful only for coordination — artifact bodies live in the repo or Confluence,
 * tasks live in the external system. This interface intentionally stores only references.
 */
export interface FlowStore {
  createFlow(input: CreateFlowInput): Promise<Flow>;
  getFlow(flowId: string): Promise<Flow | undefined>;
  /** Patch de flow sin `status`. Tira si el patch trae la clave (ver `rejectStatusInFlowPatch`). */
  updateFlow(flowId: string, patch: UpdateFlowInput): Promise<Flow>;
  /**
   * **Escritura condicional** de `flow.status`: aplica la transición sólo si el
   * status actual no está en `blockedFrom`, y en un único statement.
   *
   * Existe porque leer-chequear-escribir no es atómico ni en Postgres ni acá:
   * `getFlow` + `if (status !== 'aborted')` + `updateFlow` tiene un punto de
   * suspensión en medio, y dos requests MCP concurrentes en el mismo proceso Node
   * alcanzan para que gane el último que escribe. En las dos direcciones: un abort
   * pisado (el flow resucita) y un `abort_flow` que escribe sobre un flow ya
   * `merged`, dejándolo simultáneamente abandonado y terminado. La invariante tiene
   * que evaluarse en el **mismo** statement que escribe.
   *
   * Contrato para las implementaciones: entre la evaluación de `blockedFrom` y la
   * escritura no puede haber un `await`. En Postgres es un `UPDATE ... WHERE status
   * NOT IN (...)`; en memoria, un chequeo y un `Map.set` sincrónicos.
   */
  updateFlowStatus(
    flowId: string,
    transition: FlowStatusTransition,
    blockedFrom: readonly FlowStatus[],
  ): Promise<FlowStatusWriteResult>;
  listFlows(tenantId: string, project?: string): Promise<Flow[]>;
  appendEvent(input: AppendEventInput): Promise<FlowEvent>;
  listEvents(flowId: string): Promise<FlowEvent[]>;
  createStory(input: CreateStoryInput): Promise<Story>;
  getStory(storyId: string): Promise<Story | undefined>;
  listStoriesByFlow(flowId: string): Promise<Story[]>;
  updateStory(storyId: string, patch: UpdateStoryInput): Promise<Story>;
  /** Registra una aprobación. No mira vigencia ni roles: eso lo decide quien llama. */
  recordApproval(input: RecordApprovalInput): Promise<Approval>;
  /** Todas las aprobaciones del flow, vigentes o no, de la más vieja a la más nueva. */
  listApprovals(flowId: string): Promise<Approval[]>;
  /**
   * Marca como invalidadas las aprobaciones todavía no invalidadas de esos
   * artefactos. Devuelve las que marcó, para emitir un evento por cada una.
   */
  invalidateApprovals(
    flowId: string,
    artifacts: readonly ApprovalArtifact[],
    reason: ApprovalInvalidationReason,
  ): Promise<Approval[]>;
  /** Guarda un link de aprobación emitido (sólo el hash del token). */
  createApprovalRequest(input: ApprovalRequest): Promise<ApprovalRequest>;
  /** El link por el hash de su token, o `undefined`. */
  getApprovalRequest(tokenHash: string): Promise<ApprovalRequest | undefined>;
  /**
   * Consume el link: lo marca usado **sólo si** todavía no se usó y no venció, en
   * una sola escritura. `false` = no lo consumió (otro request ganó, o venció).
   * Es lo que hace que un link sirva una sola vez aunque lleguen dos POST juntos.
   */
  consumeApprovalRequest(tokenHash: string, now: Date): Promise<boolean>;
}

export interface RecordApprovalInput {
  tenant_id: string;
  flow_id: string;
  artifact: ApprovalArtifact;
  sha256: string;
  approved_by: string;
  approver_roles: string[];
  self_signed: boolean;
}

export interface CreateStoryInput {
  flow_id: string;
  external_id: string;
  external_url: string;
  title: string;
  acceptance_criteria: string[];
  target_repo?: string;
  component?: string;
  component_kind?: ComponentKind;
}

export interface UpdateStoryInput {
  status?: StoryStatus;
  assignee?: string;
  pr_url?: string;
  qa_plan?: StoryQaPlan;
  qa_verdict?: QaVerdict;
  qa_block_reason?: string | null;
  /** Resultados de la última corrida admitida, con evidencia. `null` limpia. */
  qa_results?: StoryQaResult[] | null;
  /** Envelope de esa corrida. `null` limpia. */
  qa_envelope?: StoryQaEnvelope | null;
  review_envelope?: StoryReviewEnvelope | null;
}
