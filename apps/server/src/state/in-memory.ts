import { createHash, randomUUID } from 'node:crypto';
import type {
  Approval,
  ApprovalArtifact,
  ApprovalInvalidationReason,
  Flow,
  FlowEvent,
  FlowStatus,
  Story,
} from '@sdlc/core';
import type {
  AppendEventInput,
  CreateFlowInput,
  CreateStoryInput,
  FlowStatusTransition,
  FlowStatusWriteResult,
  FlowStore,
  RecordApprovalInput,
  UpdateFlowInput,
  UpdateStoryInput,
} from './store.js';
import { rejectStatusInFlowPatch } from './store.js';

export class InMemoryFlowStore implements FlowStore {
  private readonly flows = new Map<string, Flow>();
  private readonly events: FlowEvent[] = [];
  private readonly stories = new Map<string, Story>();
  private readonly approvals: Approval[] = [];

  async createFlow(input: CreateFlowInput): Promise<Flow> {
    const flow_id = `${input.tenant_id}:${input.project}:${input.slug}`;
    if (this.flows.has(flow_id)) {
      throw new Error(`Flow already exists: ${flow_id}`);
    }
    const now = new Date().toISOString();
    const flow: Flow = {
      flow_id,
      tenant_id: input.tenant_id,
      project: input.project,
      slug: input.slug,
      title: input.title,
      status: 'draft',
      current_phase: 'prd',
      ...(input.initiative_type !== undefined ? { initiative_type: input.initiative_type } : {}),
      adr_count: 0,
      created_at: now,
      updated_at: now,
    };
    this.flows.set(flow_id, flow);
    return flow;
  }

  async getFlow(flowId: string): Promise<Flow | undefined> {
    return this.flows.get(flowId);
  }

  async updateFlow(flowId: string, patch: UpdateFlowInput): Promise<Flow> {
    rejectStatusInFlowPatch(flowId, patch);
    const existing = this.flows.get(flowId);
    if (!existing) throw new Error(`Unknown flow: ${flowId}`);
    return this.applyFlowPatch(existing, patch);
  }

  /**
   * Escritura condicional de status. El equivalente en memoria del
   * `UPDATE ... WHERE status NOT IN (...)` de Postgres.
   *
   * Todo el cuerpo es sincrónico a propósito: entre el `get`, el chequeo de
   * `blockedFrom` y el `set` no hay ni un `await`, así que no hay ventana donde
   * otro request se meta. Si esto se escribiera como `getFlow()` + chequeo +
   * `updateFlow()` volvería la misma carrera que el método existe para cerrar, y el
   * test de la carrera dejaría de valer para las dos implementaciones.
   */
  async updateFlowStatus(
    flowId: string,
    transition: FlowStatusTransition,
    blockedFrom: readonly FlowStatus[],
  ): Promise<FlowStatusWriteResult> {
    const existing = this.flows.get(flowId);
    if (!existing) return { applied: false, flow: undefined };
    if (blockedFrom.includes(existing.status)) return { applied: false, flow: existing };
    return { applied: true, flow: this.applyFlowPatch(existing, transition) };
  }

  /** Merge sincrónico del patch sobre el flow, sin puntos de suspensión. */
  private applyFlowPatch(existing: Flow, patch: UpdateFlowInput | FlowStatusTransition): Flow {
    const next: Flow = {
      ...existing,
      ...patch,
      ...(patch.adr_refs !== undefined ? { adr_refs: patch.adr_refs } : {}),
      ...(patch.adr_count !== undefined ? { adr_count: patch.adr_count } : {}),
      updated_at: new Date().toISOString(),
    };
    this.flows.set(existing.flow_id, next);
    return next;
  }

  async listFlows(tenantId: string, project?: string): Promise<Flow[]> {
    return [...this.flows.values()].filter(
      (f) => f.tenant_id === tenantId && (project === undefined || f.project === project),
    );
  }

  async appendEvent(input: AppendEventInput): Promise<FlowEvent> {
    if (!this.flows.has(input.flow_id)) {
      throw new Error(`Cannot append event to unknown flow: ${input.flow_id}`);
    }
    const event: FlowEvent = {
      flow_id: input.flow_id,
      type: input.type,
      actor: input.actor,
      payload: input.payload,
      ts: new Date().toISOString(),
    };
    this.events.push(event);
    return event;
  }

  async listEvents(flowId: string): Promise<FlowEvent[]> {
    return this.events.filter((e) => e.flow_id === flowId);
  }

  async createStory(input: CreateStoryInput): Promise<Story> {
    if (!this.flows.has(input.flow_id)) {
      throw new Error(`Cannot create story for unknown flow: ${input.flow_id}`);
    }
    const story_id = `${input.flow_id}::${input.external_id}`;
    if (this.stories.has(story_id)) {
      throw new Error(`Story already exists: ${story_id}`);
    }
    const now = new Date().toISOString();
    const story: Story = {
      story_id,
      flow_id: input.flow_id,
      external_id: input.external_id,
      external_url: input.external_url,
      title: input.title,
      acceptance_criteria: input.acceptance_criteria,
      status: 'created',
      ...(input.target_repo !== undefined ? { target_repo: input.target_repo } : {}),
      ...(input.component !== undefined ? { component: input.component } : {}),
      ...(input.component_kind !== undefined ? { component_kind: input.component_kind } : {}),
      created_at: now,
      updated_at: now,
    };
    this.stories.set(story_id, story);
    return story;
  }

  async getStory(storyId: string): Promise<Story | undefined> {
    const found = this.stories.get(storyId);
    return found ? { ...found } : undefined;
  }

  async listStoriesByFlow(flowId: string): Promise<Story[]> {
    return [...this.stories.values()]
      .filter((s) => s.flow_id === flowId)
      .map((s) => ({ ...s }));
  }

  async updateStory(storyId: string, patch: UpdateStoryInput): Promise<Story> {
    const existing = this.stories.get(storyId);
    if (!existing) throw new Error(`Unknown story: ${storyId}`);
    const next: Story = {
      ...existing,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.assignee !== undefined ? { assignee: patch.assignee } : {}),
      ...(patch.pr_url !== undefined ? { pr_url: patch.pr_url } : {}),
      ...(patch.qa_plan !== undefined ? { qa_plan: patch.qa_plan } : {}),
      ...(patch.qa_verdict !== undefined ? { qa_verdict: patch.qa_verdict } : {}),
      ...(patch.qa_block_reason !== undefined
        ? { qa_block_reason: patch.qa_block_reason ?? undefined }
        : {}),
      ...(patch.qa_results !== undefined ? { qa_results: patch.qa_results ?? undefined } : {}),
      ...(patch.qa_envelope !== undefined ? { qa_envelope: patch.qa_envelope ?? undefined } : {}),
      ...(patch.review_envelope !== undefined
        ? { review_envelope: patch.review_envelope ?? undefined }
        : {}),
      updated_at: new Date().toISOString(),
    };
    this.stories.set(storyId, next);
    return next;
  }

  async recordApproval(input: RecordApprovalInput): Promise<Approval> {
    if (!this.flows.has(input.flow_id)) {
      throw new Error(`Cannot record approval for unknown flow: ${input.flow_id}`);
    }
    const approval: Approval = {
      id: randomUUID(),
      tenant_id: input.tenant_id,
      flow_id: input.flow_id,
      artifact: input.artifact,
      sha256: input.sha256,
      approved_by: input.approved_by,
      approver_roles: [...input.approver_roles],
      self_signed: input.self_signed,
      approved_at: new Date().toISOString(),
    };
    this.approvals.push(approval);
    return { ...approval, approver_roles: [...approval.approver_roles] };
  }

  async listApprovals(flowId: string): Promise<Approval[]> {
    return this.approvals
      .filter((a) => a.flow_id === flowId)
      .map((a) => ({ ...a, approver_roles: [...a.approver_roles] }));
  }

  async invalidateApprovals(
    flowId: string,
    artifacts: readonly ApprovalArtifact[],
    reason: ApprovalInvalidationReason,
  ): Promise<Approval[]> {
    const now = new Date().toISOString();
    const marked: Approval[] = [];
    for (const [i, a] of this.approvals.entries()) {
      if (a.flow_id !== flowId || a.invalidated_at !== undefined) continue;
      if (!artifacts.includes(a.artifact)) continue;
      const next: Approval = { ...a, invalidated_at: now, invalidated_reason: reason };
      this.approvals[i] = next;
      marked.push({ ...next, approver_roles: [...next.approver_roles] });
    }
    return marked;
  }
}

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (base) return base;
  // Fallback if the title was all non-ASCII.
  return createHash('sha1').update(input).digest('hex').slice(0, 12);
}
