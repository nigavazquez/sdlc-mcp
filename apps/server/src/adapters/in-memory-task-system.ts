import type {
  Annotation,
  EpicInput,
  ExternalRef,
  StoryInput,
  SubtaskInput,
  TaskItem,
  TaskQuery,
  TaskSystemAdapter,
  TaskSystemKind,
  TenantCtx,
} from '@sdlc/adapters-contracts';
import { InMemoryAnnotationLog, type RecordedAnnotations } from './in-memory-annotations.js';

const ORG = 'sdlc-demo';

/**
 * Fake task system for tests/dev. No network. Generates deterministic refs
 * (ADO-1, ADO-2, …) and mirrors the Azure DevOps work item model
 * (Epic → User Story → Task) so the real adapter can slot in later.
 */
export class InMemoryTaskSystemAdapter implements TaskSystemAdapter {
  readonly kind: TaskSystemKind = 'azure-devops';
  private readonly items = new Map<string, TaskItem>();
  private counter = 0;
  private readonly annotations = new InMemoryAnnotationLog();

  private nextRef(projectKey: string): ExternalRef {
    this.counter += 1;
    const external_id = `ADO-${this.counter}`;
    const url = `https://dev.azure.com/${ORG}/${projectKey}/_workitems/edit/${this.counter}`;
    return { external_id, url };
  }

  async createEpic(input: EpicInput, _ctx: TenantCtx): Promise<ExternalRef> {
    const ref = this.nextRef(input.project_key);
    this.items.set(ref.external_id, {
      external_id: ref.external_id,
      url: ref.url,
      title: input.title,
      description: input.description,
      status: 'New',
      type: 'epic',
      labels: input.labels ?? [],
    });
    return ref;
  }

  async createStory(input: StoryInput, _ctx: TenantCtx): Promise<ExternalRef> {
    const ref = this.nextRef(input.project_key);
    this.items.set(ref.external_id, {
      external_id: ref.external_id,
      url: ref.url,
      title: input.title,
      description: input.description,
      status: 'New',
      type: 'story',
      parent_id: input.epic_id,
      labels: input.labels ?? [],
    });
    return ref;
  }

  async createSubtask(input: SubtaskInput, _ctx: TenantCtx): Promise<ExternalRef> {
    const ref = this.nextRef(input.project_key);
    this.items.set(ref.external_id, {
      external_id: ref.external_id,
      url: ref.url,
      title: input.title,
      description: input.description ?? '',
      status: 'New',
      type: 'subtask',
      parent_id: input.parent_story_id,
      labels: [],
    });
    return ref;
  }

  async linkChildToParent(parentId: string, childId: string, _ctx: TenantCtx): Promise<void> {
    const child = this.items.get(childId);
    if (!child) throw new Error(`Unknown work item: ${childId}`);
    child.parent_id = parentId;
  }

  async getItem(id: string, _ctx: TenantCtx): Promise<TaskItem> {
    const item = this.items.get(id);
    if (!item) throw new Error(`Unknown work item: ${id}`);
    return { ...item };
  }

  async transition(id: string, status: string, _ctx: TenantCtx): Promise<void> {
    const item = this.items.get(id);
    if (!item) throw new Error(`Unknown work item: ${id}`);
    item.status = status;
  }

  /** Guarda la anotación y suma las etiquetas al item, como haría GitHub. */
  async annotate(id: string, annotation: Annotation, _ctx: TenantCtx): Promise<void> {
    const item = this.items.get(id);
    if (!item) throw new Error(`Unknown work item: ${id}`);
    for (const label of annotation.labels) {
      if (!item.labels.includes(label)) item.labels.push(label);
    }
    this.annotations.record(id, annotation);
  }

  /** Para tests: lo que quedó anotado sobre el item. */
  annotationsOf(id: string): RecordedAnnotations {
    return this.annotations.get(id);
  }

  async search(query: TaskQuery, _ctx: TenantCtx): Promise<TaskItem[]> {
    let results = [...this.items.values()];
    if (query.parent_id !== undefined) {
      results = results.filter((i) => i.parent_id === query.parent_id);
    }
    if (query.status !== undefined) {
      results = results.filter((i) => i.status === query.status);
    }
    if (query.text !== undefined) {
      const t = query.text.toLowerCase();
      results = results.filter((i) => i.title.toLowerCase().includes(t));
    }
    if (query.limit !== undefined) results = results.slice(0, query.limit);
    return results.map((i) => ({ ...i }));
  }
}
