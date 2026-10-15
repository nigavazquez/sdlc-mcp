import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { tenant_integrations } from '../state/schema.js';
import type { IntegrationRef } from './types.js';

export const IntegrationRefSchema = z.object({
  kind: z.string().min(1),
  secret_ref: z.string().min(1).optional(),
  settings: z.record(z.unknown()).default({}),
});

const ProjectSchema = z
  .object({
    project: z.string().min(1),
    task_system: IntegrationRefSchema.optional(),
    doc_store: IntegrationRefSchema.optional(),
    pr_provider: IntegrationRefSchema.optional(),
  })
  .refine((p) => p.task_system ?? p.doc_store ?? p.pr_provider, {
    message: 'project must define at least one of task_system, doc_store, or pr_provider',
  });

export const IntegrationsConfigSchema = z.object({
  tenants: z
    .array(
      z.object({
        tenant_id: z.string().min(1),
        projects: z.array(ProjectSchema).min(1),
      }),
    )
    .min(1),
});

export type IntegrationsConfig = z.infer<typeof IntegrationsConfigSchema>;

/** Validates raw (parsed-JSON) input. Throws ZodError on any problem. */
export function parseIntegrationsConfig(raw: unknown): IntegrationsConfig {
  return IntegrationsConfigSchema.parse(raw);
}

export interface SeedResult {
  created: string[];
  updated: string[];
}

/**
 * Upserts one `tenant_integrations` row per (tenant, project) in the config.
 * The file is canonical for each row: omitted refs are written as NULL.
 * Returns which `tenant/project` labels were created vs updated.
 */
export async function seedIntegrations(
  db: PostgresJsDatabase,
  config: IntegrationsConfig,
): Promise<SeedResult> {
  const created: string[] = [];
  const updated: string[] = [];

  // Classify created vs updated by checking existing keys first.
  for (const tenant of config.tenants) {
    for (const proj of tenant.projects) {
      const label = `${tenant.tenant_id}/${proj.project}`;
      const existing = await db
        .select({ p: tenant_integrations.project })
        .from(tenant_integrations)
        .where(
          and(
            eq(tenant_integrations.tenant_id, tenant.tenant_id),
            eq(tenant_integrations.project, proj.project),
          ),
        )
        .limit(1);

      const values = {
        tenant_id: tenant.tenant_id,
        project: proj.project,
        task_system: (proj.task_system as IntegrationRef | undefined) ?? null,
        doc_store: (proj.doc_store as IntegrationRef | undefined) ?? null,
        pr_provider: (proj.pr_provider as IntegrationRef | undefined) ?? null,
      };

      await db
        .insert(tenant_integrations)
        .values(values)
        .onConflictDoUpdate({
          target: [tenant_integrations.tenant_id, tenant_integrations.project],
          set: {
            task_system: values.task_system,
            doc_store: values.doc_store,
            pr_provider: values.pr_provider,
            updated_at: new Date(),
          },
        });

      if (existing[0]) updated.push(label);
      else created.push(label);
    }
  }

  return { created, updated };
}
