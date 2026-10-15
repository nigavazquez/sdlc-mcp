import { z } from 'zod';

export const RoleId = z.enum([
  'product-manager',
  'tech-lead',
  'pmo',
  'developer',
  'qa',
  'reviewer',
]);
export type RoleId = z.infer<typeof RoleId>;

export const PhaseId = z.enum([
  'prd-draft',
  'prd-validate',
  'rfc-draft',
  'rfc-validate',
  'shaping',
  // Track liviano: reemplaza a las fases prd-* y rfc-* para un fix o una mejora chica.
  'change-note',
  'implement',
  'qa',
  'review',
]);
export type PhaseId = z.infer<typeof PhaseId>;

export const RolePhase = z.object({
  role: RoleId,
  phase: PhaseId,
});
export type RolePhase = z.infer<typeof RolePhase>;

export const RolePromptResponse = z.object({
  role: RoleId,
  phase: PhaseId,
  version: z.string(),
  system_prompt: z.string(),
  skills: z.array(
    z.object({
      id: z.string(),
      version: z.string(),
      markdown: z.string(),
    }),
  ),
  templates: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
    }),
  ),
});
export type RolePromptResponse = z.infer<typeof RolePromptResponse>;
