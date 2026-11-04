import type { TenantCtx } from './tenant-context.js';

export type DocStoreKind = 'confluence' | 'notion' | 'repo' | 'google-drive' | 'github-repo';

export interface DocRef {
  /** .md (faithful markdown) file Drive id — audit/source-of-truth anchor. */
  id: string;
  /** Primary human-facing URL = the native Google Doc webViewLink. */
  url: string;
  version?: string;
  /** Native Google Doc Drive id. */
  gdoc_id?: string;
  /** Native Google Doc webViewLink (same value as `url`, kept explicit). */
  gdoc_url?: string;
  /** .md file webViewLink (optional, for completeness). */
  md_url?: string;
}

export interface DocPublishInput {
  /** For Confluence/Notion adapters. Required by those; ignored by google-drive. */
  space_or_repo?: string;
  title: string;
  markdown: string;
  parent_id?: string;
  /**
   * Routing discriminator for Drive folder selection and filename. La nota de cambio
   * tiene el suyo: si compartiera 'prd', un flow lite que escala a submit_prd la pisaría.
   */
  doc_kind: 'prd' | 'rfc' | 'adr' | 'change-note';
  /**
   * Segmentos de carpeta, de la raíz hacia abajo. Requerido cuando kind='google-drive'.
   * El adapter los une tal cual: no asume una cantidad fija de niveles ni vocabulario
   * de organización. Quien llama lo deriva del modelo (ver src/docs/folder-path.ts).
   */
  folder_path?: string[];
  /** Per-flow folder name; typically the flow slug. Required when kind='google-drive'. */
  flow_folder: string;
  /** ADR filename, e.g. "0001-use-postgres.md". Only used when doc_kind='adr'. */
  adr_filename?: string;
}

export interface DocStoreAdapter {
  readonly kind: DocStoreKind;
  publish(input: DocPublishInput, ctx: TenantCtx): Promise<DocRef>;
  fetch(id: string, ctx: TenantCtx): Promise<{ markdown: string; version: string }>;
}
