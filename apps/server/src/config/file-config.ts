import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const LabelPairSchema = z.object({
  singular: z.string(),
  plural: z.string(),
});

const LabelsSchema = z.object({
  workspace: LabelPairSchema.default({ singular: 'workspace', plural: 'workspaces' }),
  group: LabelPairSchema.default({ singular: 'group', plural: 'groups' }),
});

const OidcSchema = z.object({
  discoveryUrl: z.string(),
  clientId: z.string(),
  clientSecretRef: z.string(),
  scopes: z.array(z.string()).default([]),
});

const AuthSchema = z.object({
  oidc: OidcSchema.optional(),
  // Optional (not `.default([])`): hay que poder distinguir "el campo no está"
  // —y entonces gana la env var— de "está y es vacío", que significa
  // explícitamente "sin restricción de dominio". Ver config/resolve.ts.
  allowedEmailDomains: z.array(z.string()).optional(),
});

// Los adapters NO se declaran acá: su fuente de verdad es `tenant_integrations`
// (editable desde el panel admin), porque la fila lleva además las referencias de
// credenciales que este archivo no tiene dónde expresar. Reconciliarlos al boot
// sobrescribiría lo que configuró el operador. Ver docs/ARCHITECTURE.md.
const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  group: z.string().optional(),
});

const GroupSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const FileConfigSchema = z.object({
  // `tenantId` y `adminEmails` son optional por el mismo motivo que
  // `auth.allowedEmailDomains`: ausente => gana la env var.
  tenantId: z.string().optional(),
  labels: LabelsSchema.default({}),
  adminEmails: z.array(z.string()).optional(),
  auth: AuthSchema.optional(),
  groups: z.array(GroupSchema).default([]),
  workspaces: z.array(WorkspaceSchema).default([]),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FileConfig = z.infer<typeof FileConfigSchema>;

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Parse and validate YAML text as a FileConfig.
 * Throws a ZodError if the input is invalid.
 */
export function parseFileConfig(yamlText: string): FileConfig {
  const raw = parseYaml(yamlText) ?? {};
  return FileConfigSchema.parse(raw);
}

/**
 * Load a FileConfig from the given file path.
 * Returns null if the file does not exist.
 * Throws if the file exists but is invalid.
 */
export function loadFileConfig(path: string): FileConfig | null {
  if (!existsSync(path)) {
    return null;
  }
  const text = readFileSync(path, 'utf8');
  return parseFileConfig(text);
}
