import { z } from 'zod';

export const EpicInput = z.object({
  title: z.string().min(1),
  description: z.string(),
  labels: z.array(z.string()).optional(),
});
export type EpicInput = z.infer<typeof EpicInput>;

export const SubtaskInput = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
});
export type SubtaskInput = z.infer<typeof SubtaskInput>;

export const StoryInput = z.object({
  title: z.string().min(1),
  description: z.string(),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
  labels: z.array(z.string()).optional(),
  estimate: z.number().optional(),
  subtasks: z.array(SubtaskInput).optional(),
  // References a FlowComponent.name from the flow's registry. The breakdown
  // assigns each story to exactly one component (1 story = 1 repo = 1 PR).
  component: z.string().optional(),
});
export type StoryInput = z.infer<typeof StoryInput>;

export const Breakdown = z.object({
  epic: EpicInput,
  stories: z.array(StoryInput).min(1),
});
export type Breakdown = z.infer<typeof Breakdown>;

export const ExternalRefZ = z.object({
  external_id: z.string(),
  url: z.string(),
});
export type ExternalRefZ = z.infer<typeof ExternalRefZ>;
