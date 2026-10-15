import { and, asc, desc, eq, notInArray, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import type {
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
import type {
  AppendEventInput,
  CreateFlowInput,
  CreateStoryInput,
  FlowStatusTransition,
  FlowStatusWriteResult,
  FlowStore,
  UpdateFlowInput,
  UpdateStoryInput,
} from './store.js';
import { rejectStatusInFlowPatch } from './store.js';
import { flow_events, flows, stories } from './schema.js';

export interface PostgresFlowStoreOptions {
  databaseUrl: string;
  /** Optional pre-built postgres client, used by tests to share a single connection. */
  client?: Sql;
}

export class PostgresFlowStore implements FlowStore {
  readonly db: PostgresJsDatabase;
  private readonly client: Sql;

  constructor(opts: PostgresFlowStoreOptions) {
    this.client = opts.client ?? postgres(opts.databaseUrl, { max: 5 });
    this.db = drizzle(this.client);
  }

  /** Closes the underlying client. Tests should call this between cases. */
  async close(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }

  async createFlow(input: CreateFlowInput): Promise<Flow> {
    const flow_id = `${input.tenant_id}:${input.project}:${input.slug}`;
    const rows = await this.db
      .insert(flows)
      .values({
        flow_id,
        tenant_id: input.tenant_id,
        project: input.project,
        slug: input.slug,
        title: input.title,
        status: 'draft',
        current_phase: 'prd',
        initiative_type: input.initiative_type ?? null,
        // adr_refs and adr_count use column defaults
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error(`Insert returned no rows for ${flow_id}`);
    return rowToFlow(row);
  }

  async getFlow(flowId: string): Promise<Flow | undefined> {
    const rows = await this.db.select().from(flows).where(eq(flows.flow_id, flowId)).limit(1);
    const row = rows[0];
    return row ? rowToFlow(row) : undefined;
  }

  async updateFlow(flowId: string, patch: UpdateFlowInput): Promise<Flow> {
    rejectStatusInFlowPatch(flowId, patch);
    const rows = await this.db
      .update(flows)
      .set(flowUpdateSet(patch))
      .where(eq(flows.flow_id, flowId))
      .returning();
    const row = rows[0];
    if (!row) throw new Error(`Unknown flow: ${flowId}`);
    return rowToFlow(row);
  }

  /**
   * Escritura condicional de status: un solo `UPDATE ... WHERE status NOT IN (...)`.
   *
   * La precondición se evalúa dentro del mismo statement que escribe, que es lo único
   * que cierra la carrera: con `SELECT` + chequeo en JS + `UPDATE` gana el último que
   * escribe, y dos requests MCP concurrentes alcanzan para resucitar un flow abortado
   * o para abortar uno ya `merged`. Cero filas devueltas = no escribí.
   */
  async updateFlowStatus(
    flowId: string,
    transition: FlowStatusTransition,
    blockedFrom: readonly FlowStatus[],
  ): Promise<FlowStatusWriteResult> {
    const set = { ...flowUpdateSet(transition), status: transition.status };
    const where =
      blockedFrom.length === 0
        ? eq(flows.flow_id, flowId)
        : and(eq(flows.flow_id, flowId), notInArray(flows.status, [...blockedFrom]));
    const rows = await this.db.update(flows).set(set).where(where).returning();
    const row = rows[0];
    if (row) return { applied: true, flow: rowToFlow(row) };
    // No escribimos. Leemos para poder decir *por qué* (status bloqueado vs. flow
    // inexistente); esta lectura no es parte de la decisión, así que no reabre la
    // carrera — la decisión ya la tomó el UPDATE.
    return { applied: false, flow: await this.getFlow(flowId) };
  }

  async listFlows(tenantId: string, project?: string): Promise<Flow[]> {
    const where =
      project !== undefined
        ? and(eq(flows.tenant_id, tenantId), eq(flows.project, project))
        : eq(flows.tenant_id, tenantId);
    const rows = await this.db.select().from(flows).where(where).orderBy(desc(flows.created_at));
    return rows.map(rowToFlow);
  }

  async appendEvent(input: AppendEventInput): Promise<FlowEvent> {
    return await this.db.transaction(async (tx) => {
      const exists = await tx
        .select({ id: flows.flow_id })
        .from(flows)
        .where(eq(flows.flow_id, input.flow_id))
        .limit(1);
      if (exists.length === 0) {
        throw new Error(`Cannot append event to unknown flow: ${input.flow_id}`);
      }
      const seqRows = await tx
        .select({ next: sql<number>`coalesce(max(${flow_events.seq}), 0) + 1` })
        .from(flow_events)
        .where(eq(flow_events.flow_id, input.flow_id));
      const nextSeq = Number(seqRows[0]?.next ?? 1);
      const inserted = await tx
        .insert(flow_events)
        .values({
          flow_id: input.flow_id,
          seq: nextSeq,
          type: input.type,
          actor: input.actor,
          payload: input.payload,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error('Failed to insert event');
      return {
        flow_id: row.flow_id,
        type: row.type as FlowEventType,
        actor: row.actor,
        payload: row.payload as Record<string, unknown>,
        ts: row.ts.toISOString(),
      } satisfies FlowEvent;
    });
  }

  async listEvents(flowId: string): Promise<FlowEvent[]> {
    const rows = await this.db
      .select()
      .from(flow_events)
      .where(eq(flow_events.flow_id, flowId))
      .orderBy(asc(flow_events.seq));
    return rows.map((row) => ({
      flow_id: row.flow_id,
      type: row.type as FlowEventType,
      actor: row.actor,
      payload: row.payload as Record<string, unknown>,
      ts: row.ts.toISOString(),
    }));
  }

  async createStory(input: CreateStoryInput): Promise<Story> {
    const existing = await this.db
      .select({ id: flows.flow_id })
      .from(flows)
      .where(eq(flows.flow_id, input.flow_id))
      .limit(1);
    if (existing.length === 0) {
      throw new Error(`Cannot create story for unknown flow: ${input.flow_id}`);
    }
    const story_id = `${input.flow_id}::${input.external_id}`;
    const rows = await this.db
      .insert(stories)
      .values({
        story_id,
        flow_id: input.flow_id,
        external_id: input.external_id,
        external_url: input.external_url,
        title: input.title,
        acceptance_criteria: input.acceptance_criteria,
        status: 'created',
        target_repo: input.target_repo ?? null,
        component: input.component ?? null,
        component_kind: input.component_kind ?? null,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error(`Insert returned no rows for ${story_id}`);
    return rowToStory(row);
  }

  async getStory(storyId: string): Promise<Story | undefined> {
    const rows = await this.db
      .select()
      .from(stories)
      .where(eq(stories.story_id, storyId))
      .limit(1);
    const row = rows[0];
    return row ? rowToStory(row) : undefined;
  }

  async listStoriesByFlow(flowId: string): Promise<Story[]> {
    const rows = await this.db
      .select()
      .from(stories)
      .where(eq(stories.flow_id, flowId))
      .orderBy(asc(stories.created_at));
    return rows.map(rowToStory);
  }

  async updateStory(storyId: string, patch: UpdateStoryInput): Promise<Story> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.assignee !== undefined) update.assignee = patch.assignee;
    if (patch.pr_url !== undefined) update.pr_url = patch.pr_url;
    if (patch.qa_plan !== undefined) update.qa_plan = patch.qa_plan;
    if (patch.qa_verdict !== undefined) update.qa_verdict = patch.qa_verdict;
    if (patch.qa_block_reason !== undefined) update.qa_block_reason = patch.qa_block_reason; // null clears
    if (patch.qa_results !== undefined) update.qa_results = patch.qa_results; // null clears
    if (patch.qa_envelope !== undefined) update.qa_envelope = patch.qa_envelope; // null clears
    if (patch.review_envelope !== undefined) update.review_envelope = patch.review_envelope; // null clears

    const rows = await this.db
      .update(stories)
      .set(update)
      .where(eq(stories.story_id, storyId))
      .returning();
    const row = rows[0];
    if (!row) throw new Error(`Unknown story: ${storyId}`);
    return rowToStory(row);
  }
}

/**
 * Columnas a escribir de un patch de flow. **No incluye `status`**: lo agrega sólo
 * `updateFlowStatus`, que es el único camino con precondición.
 */
function flowUpdateSet(patch: UpdateFlowInput): Record<string, unknown> {
  const update: Record<string, unknown> = { updated_at: new Date() };
  if (patch.current_phase !== undefined) update.current_phase = patch.current_phase;
  if (patch.prd_ref !== undefined) update.prd_ref = patch.prd_ref;
  if (patch.change_note_ref !== undefined) update.change_note_ref = patch.change_note_ref;
  if (patch.rfc_ref !== undefined) update.rfc_ref = patch.rfc_ref;
  if (patch.epic_external_id !== undefined) update.epic_external_id = patch.epic_external_id;
  if (patch.architecture_mode !== undefined) update.architecture_mode = patch.architecture_mode;
  if (patch.codebase_status !== undefined) update.codebase_status = patch.codebase_status;
  if (patch.existing_repo !== undefined) update.existing_repo = patch.existing_repo;
  if (patch.components !== undefined) update.components = patch.components;
  if (patch.adr_refs !== undefined) update.adr_refs = patch.adr_refs;
  if (patch.adr_count !== undefined) update.adr_count = patch.adr_count;
  if (patch.initiative_type !== undefined) update.initiative_type = patch.initiative_type;
  if (patch.doc_folder_path !== undefined) update.doc_folder_path = patch.doc_folder_path;
  return update;
}

function rowToFlow(row: typeof flows.$inferSelect): Flow {
  return {
    flow_id: row.flow_id,
    tenant_id: row.tenant_id,
    project: row.project,
    slug: row.slug,
    title: row.title,
    status: row.status as FlowStatus,
    current_phase: row.current_phase as CurrentPhase,
    prd_ref: (row.prd_ref as ArtifactRef | null) ?? undefined,
    change_note_ref: (row.change_note_ref as ArtifactRef | null) ?? undefined,
    rfc_ref: (row.rfc_ref as ArtifactRef | null) ?? undefined,
    epic_external_id: row.epic_external_id ?? undefined,
    architecture_mode: (row.architecture_mode as ArchitectureMode | null) ?? undefined,
    codebase_status: (row.codebase_status as CodebaseStatus | null) ?? undefined,
    existing_repo: row.existing_repo ?? undefined,
    components: (row.components as FlowComponent[] | null) ?? undefined,
    doc_folder_path: row.doc_folder_path ?? undefined,
    initiative_type: (row.initiative_type as InitiativeType | null) ?? undefined,
    adr_refs: (row.adr_refs as ArtifactRef[] | null) ?? undefined,
    adr_count: row.adr_count ?? undefined,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function rowToStory(row: typeof stories.$inferSelect): Story {
  return {
    story_id: row.story_id,
    flow_id: row.flow_id,
    external_id: row.external_id,
    external_url: row.external_url,
    title: row.title,
    acceptance_criteria: row.acceptance_criteria as string[],
    status: row.status as StoryStatus,
    assignee: row.assignee ?? undefined,
    target_repo: row.target_repo ?? undefined,
    component: row.component ?? undefined,
    component_kind: (row.component_kind as ComponentKind | null) ?? undefined,
    pr_url: row.pr_url ?? undefined,
    qa_plan: (row.qa_plan as StoryQaPlan | null) ?? undefined,
    qa_verdict: (row.qa_verdict as QaVerdict | null) ?? undefined,
    qa_block_reason: row.qa_block_reason ?? undefined,
    qa_results: (row.qa_results as StoryQaResult[] | null) ?? undefined,
    qa_envelope: (row.qa_envelope as StoryQaEnvelope | null) ?? undefined,
    review_envelope: (row.review_envelope as StoryReviewEnvelope | null) ?? undefined,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
