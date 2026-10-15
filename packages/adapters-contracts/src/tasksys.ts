import type { TenantCtx } from './tenant-context.js';

export type TaskSystemKind = 'jira' | 'linear' | 'github' | 'azure-devops';

export interface ExternalRef {
  external_id: string;
  url: string;
}

export interface EpicInput {
  project_key: string;
  title: string;
  description: string;
  labels?: string[];
}

export interface StoryInput {
  project_key: string;
  epic_id: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
  labels?: string[];
  estimate?: number;
}

export interface SubtaskInput {
  project_key: string;
  parent_story_id: string;
  title: string;
  description?: string;
}

export interface TaskItem {
  external_id: string;
  url: string;
  title: string;
  description: string;
  status: string;
  type: 'epic' | 'story' | 'subtask' | 'task';
  parent_id?: string;
  labels: string[];
}

export interface TaskQuery {
  project_key?: string;
  parent_id?: string;
  status?: string;
  text?: string;
  limit?: number;
}

export interface TaskSystemAdapter {
  readonly kind: TaskSystemKind;
  createEpic(input: EpicInput, ctx: TenantCtx): Promise<ExternalRef>;
  createStory(input: StoryInput, ctx: TenantCtx): Promise<ExternalRef>;
  createSubtask(input: SubtaskInput, ctx: TenantCtx): Promise<ExternalRef>;
  linkChildToParent(parentId: string, childId: string, ctx: TenantCtx): Promise<void>;
  getItem(id: string, ctx: TenantCtx): Promise<TaskItem>;
  transition(id: string, status: string, ctx: TenantCtx): Promise<void>;
  search(query: TaskQuery, ctx: TenantCtx): Promise<TaskItem[]>;
}
