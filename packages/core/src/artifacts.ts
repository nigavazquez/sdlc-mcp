import { z } from 'zod';

export const PrdRequiredSections = [
  'problem',
  'users',
  'success_metrics',
  'scope',
  'out_of_scope',
  'risks',
] as const;

export const PrdSubmission = z.object({
  flow_id: z.string(),
  prd_markdown: z.string().min(50),
  doc_url: z.string().url().optional(),
});
export type PrdSubmission = z.infer<typeof PrdSubmission>;

export const RfcRequiredSections = [
  'context',
  'goals',
  'non_goals',
  'design',
  'risks',
  'rollout',
  'rollback',
] as const;

export const RfcSubmission = z.object({
  flow_id: z.string(),
  rfc_markdown: z.string().min(50),
  repo_path: z.string(),
});
export type RfcSubmission = z.infer<typeof RfcSubmission>;

export const ValidationIssue = z.object({
  severity: z.enum(['error', 'warning', 'info']),
  section: z.string().optional(),
  message: z.string(),
});
export type ValidationIssue = z.infer<typeof ValidationIssue>;

export const ValidationResult = z.object({
  ok: z.boolean(),
  issues: z.array(ValidationIssue),
});
export type ValidationResult = z.infer<typeof ValidationResult>;

export const ToolResponse = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  next_actions: z.array(z.string()).optional(),
});
export type ToolResponse<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
  next_actions?: string[];
};
