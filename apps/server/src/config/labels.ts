import type { FileConfig } from './file-config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LabelPair {
  singular: string;
  plural: string;
}

export interface Labels {
  workspace: LabelPair;
  group: LabelPair;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_LABELS: Labels = {
  workspace: { singular: 'workspace', plural: 'workspaces' },
  group: { singular: 'group', plural: 'groups' },
};

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Resolve the labels from a FileConfig, falling back to defaults for any
 * missing values.
 */
export function resolveLabels(fileCfg: FileConfig | null): Labels {
  if (!fileCfg) return DEFAULT_LABELS;
  return {
    workspace: {
      singular: fileCfg.labels.workspace.singular,
      plural: fileCfg.labels.workspace.plural,
    },
    group: {
      singular: fileCfg.labels.group.singular,
      plural: fileCfg.labels.group.plural,
    },
  };
}
