import { bigserial, boolean, jsonb, pgTable, primaryKey, smallint, text, timestamp } from 'drizzle-orm/pg-core';

export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  task_system: text('task_system'),
  doc_system: text('doc_system'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const flows = pgTable('flows', {
  flow_id: text('flow_id').primaryKey(),
  tenant_id: text('tenant_id').notNull(),
  project: text('project').notNull(),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  status: text('status').notNull(),
  current_phase: text('current_phase').notNull(),
  prd_ref: jsonb('prd_ref'),
  rfc_ref: jsonb('rfc_ref'),
  change_note_ref: jsonb('change_note_ref'),
  epic_external_id: text('epic_external_id'),
  architecture_mode: text('architecture_mode'),
  codebase_status: text('codebase_status'),
  existing_repo: text('existing_repo'),
  components: jsonb('components').notNull().default([]),
  /** Ruta de carpetas del doc store. La escribe el primer publish exitoso; no es input de usuario. */
  doc_folder_path: text('doc_folder_path').array(),
  adr_refs:   jsonb('adr_refs').notNull().default([]),
  adr_count:  smallint('adr_count').notNull().default(0),
  initiative_type: text('initiative_type'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Append-only audit log keyed by (flow_id, seq). `seq` is a monotonic per-flow
 * counter, computed at insert time inside a transaction.
 */
export const flow_events = pgTable(
  'flow_events',
  {
    flow_id: text('flow_id').notNull(),
    seq: smallint('seq').notNull(),
    type: text('type').notNull(),
    actor: text('actor').notNull(),
    payload: jsonb('payload').notNull(),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.flow_id, t.seq] }),
  }),
);

/**
 * Aprobaciones humanas de fases (migración 0016). No se borran: invalidar marca
 * `invalidated_at` y el motivo. La vigencia la decide el código comparando el
 * `sha256` con la referencia actual del flow.
 */
export const flow_approvals = pgTable('flow_approvals', {
  id: text('id').primaryKey(),
  tenant_id: text('tenant_id').notNull(),
  flow_id: text('flow_id').notNull(),
  artifact: text('artifact').notNull(),
  sha256: text('sha256').notNull(),
  approved_by: text('approved_by').notNull(),
  approver_roles: text('approver_roles').array().notNull(),
  self_signed: boolean('self_signed').notNull(),
  approved_at: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
  invalidated_at: timestamp('invalidated_at', { withTimezone: true }),
  invalidated_reason: text('invalidated_reason'),
});

export const stories = pgTable(
  'stories',
  {
    story_id: text('story_id').primaryKey(),
    flow_id: text('flow_id').notNull(),
    external_id: text('external_id').notNull(),
    external_url: text('external_url').notNull(),
    title: text('title').notNull(),
    acceptance_criteria: jsonb('acceptance_criteria').notNull(),
    status: text('status').notNull(),
    assignee: text('assignee'),
    target_repo: text('target_repo'),
    component: text('component'),
    component_kind: text('component_kind'),
    pr_url: text('pr_url'),
    qa_plan: jsonb('qa_plan'),
    qa_verdict: text('qa_verdict'),
    qa_block_reason: text('qa_block_reason'),
    // Resultados con evidencia + envelope de la última corrida de QA admitida.
    // jsonb como qa_plan; nullable, así que la migración 0010 es un ADD COLUMN
    // sin backfill y las stories viejas quedan con NULL (= "corrida anterior al
    // gate", que es exactamente lo que son).
    qa_results: jsonb('qa_results'),
    qa_envelope: jsonb('qa_envelope'),
    review_envelope: jsonb('review_envelope'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

export const tenant_integrations = pgTable(
  'tenant_integrations',
  {
    tenant_id: text('tenant_id').notNull(),
    project: text('project').notNull().default(''),
    task_system: jsonb('task_system'),
    doc_store: jsonb('doc_store'),
    pr_provider: jsonb('pr_provider'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenant_id, t.project] }),
  }),
);

export const tenant_api_keys = pgTable('tenant_api_keys', {
  id: text('id').primaryKey(),
  tenant_id: text('tenant_id').notNull(),
  key_hash: text('key_hash').notNull().unique(),
  label: text('label').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revoked_at: timestamp('revoked_at', { withTimezone: true }),
});

export const tenant_members = pgTable('tenant_members', {
  email: text('email').primaryKey(),
  tenant_id: text('tenant_id').notNull(),
  roles: jsonb('roles').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const oauth_clients = pgTable('oauth_clients', {
  client_id: text('client_id').primaryKey(),
  client_name: text('client_name').notNull(),
  redirect_uris: jsonb('redirect_uris').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const oauth_codes = pgTable('oauth_codes', {
  code_hash: text('code_hash').primaryKey(),
  workspaces: jsonb('workspaces').notNull().default({}),
  client_id: text('client_id').notNull(),
  redirect_uri: text('redirect_uri').notNull(),
  code_challenge: text('code_challenge').notNull(),
  email: text('email').notNull(),
  tenant_id: text('tenant_id').notNull(),
  roles: jsonb('roles').notNull(),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  used_at: timestamp('used_at', { withTimezone: true }),
});

export const oauth_refresh_tokens = pgTable('oauth_refresh_tokens', {
  id: text('id').primaryKey(),
  workspaces: jsonb('workspaces').notNull().default({}),
  token_hash: text('token_hash').notNull().unique(),
  email: text('email').notNull(),
  tenant_id: text('tenant_id').notNull(),
  roles: jsonb('roles').notNull(),
  client_id: text('client_id').notNull(),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  revoked_at: timestamp('revoked_at', { withTimezone: true }),
});

export const workspaces = pgTable('workspaces', {
  workspace_id: text('workspace_id').primaryKey(),
  name: text('name').notNull(),
  group_id: text('group_id'),
  /** Firma propia de QA y review (migración 0015). Default true: cada persona es un equipo. */
  self_signoff: boolean('self_signoff').notNull().default(true),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workspace_members = pgTable(
  'workspace_members',
  {
    email: text('email').notNull(),
    workspace_id: text('workspace_id').notNull(),
    roles: jsonb('roles').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.email, t.workspace_id] }) }),
);

export const groups = pgTable('groups', {
  group_id: text('group_id').primaryKey(),
  name: text('name').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Gate de repos habilitados (migración 0014). El secreto del lease no se persiste:
// la PK es su sha256. repo/branch nacen NULL y se fijan en el primer check.
export const gate_leases = pgTable('gate_leases', {
  lease_hash: text('lease_hash').primaryKey(),
  tenant_id: text('tenant_id').notNull(),
  workspace_id: text('workspace_id').notNull(),
  kind: text('kind').notNull(),
  story_id: text('story_id'),
  flow_id: text('flow_id'),
  user_id: text('user_id').notNull(),
  repo: text('repo'),
  branch: text('branch'),
  reason: text('reason'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  revoked_at: timestamp('revoked_at', { withTimezone: true }),
});

export const gate_events = pgTable('gate_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenant_id: text('tenant_id').notNull(),
  workspace_id: text('workspace_id').notNull(),
  user_id: text('user_id').notNull(),
  repo: text('repo').notNull(),
  branch: text('branch'),
  kind: text('kind').notNull(),
  lease_kind: text('lease_kind'),
  story_id: text('story_id'),
  reason: text('reason'),
  detail: jsonb('detail').notNull().default({}),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Auditoría de cambios de configuración de un workspace (migración 0015). */
export const workspace_settings_audit = pgTable('workspace_settings_audit', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  workspace_id: text('workspace_id').notNull(),
  setting: text('setting').notNull(),
  old_value: jsonb('old_value').notNull(),
  new_value: jsonb('new_value').notNull(),
  actor: text('actor').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
