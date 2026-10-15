import type { z } from 'zod';
import type { Catalog } from '@sdlc/catalog';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { TaskSystemProvider } from '../../adapters/task-system-provider.js';
import type { DocStoreProvider } from '../../adapters/doc-store-provider.js';
import { NoOpDocStoreAdapter } from '../../adapters/doc-store-provider.js';
import type { PullRequestProvider } from '../../adapters/pull-request-provider.js';
import { NoOpPullRequestAdapter } from '../../adapters/pull-request-provider.js';
import type { FlowStore } from '../../state/index.js';
import { makeWhoamiTool } from './whoami.js';
import { makeListRolesTool } from './list-roles.js';
import { makeGetRolePromptTool } from './get-role-prompt.js';
import { makeStartFlowTool } from './start-flow.js';
import { makeGetFlowStateTool } from './get-flow-state.js';
import { makeSubmitPrdTool } from './submit-prd.js';
import { makeSubmitChangeNoteTool } from './submit-change-note.js';
import { makeValidatePrdTool } from './validate-prd.js';
import { makeGenerateRfcSkeletonTool } from './generate-rfc-skeleton.js';
import { makeSubmitRfcTool } from './submit-rfc.js';
import { makeValidateRfcTool } from './validate-rfc.js';
import { makeProposeBreakdownTool } from './propose-breakdown.js';
import { makeCreateEpicTool } from './create-epic.js';
import { makeCreateStoriesTool } from './create-stories.js';
import { makeLinkSubtasksTool } from './link-subtasks.js';
import { makeSyncBacklogTool } from './sync-backlog.js';
import { makeClaimStoryTool } from './claim-story.js';
import { makeReportProgressTool } from './report-progress.js';
import { makeGetImplementationContextTool } from './get-implementation-context.js';
import { makeGenerateQaPlanTool } from './generate-qa-plan.js';
import { makeSubmitQaResultsTool } from './submit-qa-results.js';
import { makeBlockStoryTool } from './block-story.js';
import { makeDiscardStoryTool } from './discard-story.js';
import { makeSubmitAdrTool } from './submit-adr.js';
import { makeVerifyArtifactTool } from './verify-artifact.js';
import { makeRequestCodeReviewTool } from './request-code-review.js';
import { makeSubmitReviewOutcomeTool } from './submit-review-outcome.js';
import { makeAbortFlowTool } from './abort-flow.js';
import type { AdminStore } from '../../admin/store.js';

export interface ToolDef<
  Shape extends z.ZodRawShape = z.ZodRawShape,
  Schema extends z.ZodObject<Shape> = z.ZodObject<Shape>,
> {
  name: string;
  description: string;
  inputSchema: Schema;
  handler: (input: z.infer<Schema>, ctx: TenantCtx) => Promise<unknown>;
}

export interface ToolRegistry {
  list(): ToolDef[];
  get(name: string): ToolDef | undefined;
}

export interface BuildRegistryDeps {
  catalog: Catalog;
  store: FlowStore;
  taskSystemProvider: TaskSystemProvider;
  /** Optional: defaults to a NoOpDocStoreAdapter (no Drive publishing). */
  docStoreProvider?: DocStoreProvider;
  /** Optional: defaults to a NoOpPullRequestProvider (PR calls are no-ops in dev/test). */
  pullRequestProvider?: PullRequestProvider;
  /**
   * Opcional: sin esto la ruta de documentos cae al `workspace_id` en vez de derivarse
   * del modelo (group + workspace). Los tests que arman registries mínimos no lo pasan.
   */
  adminStore?: AdminStore;
}

const _noopDocStoreProvider: DocStoreProvider = {
  resolve: async () => new NoOpDocStoreAdapter(),
};

const _noopPullRequestProvider: PullRequestProvider = {
  resolve: async () => new NoOpPullRequestAdapter(),
};

export function buildToolRegistry(deps: BuildRegistryDeps): ToolRegistry {
  const {
    catalog,
    store,
    taskSystemProvider,
    docStoreProvider = _noopDocStoreProvider,
    pullRequestProvider = _noopPullRequestProvider,
    adminStore,
  } = deps;
  const tools: ToolDef[] = [
    makeWhoamiTool(catalog) as unknown as ToolDef,
    makeListRolesTool(catalog) as unknown as ToolDef,
    makeGetRolePromptTool(catalog, store) as unknown as ToolDef,
    makeStartFlowTool(store) as unknown as ToolDef,
    makeGetFlowStateTool(store) as unknown as ToolDef,
    makeSubmitPrdTool(store, docStoreProvider, adminStore) as unknown as ToolDef,
    makeSubmitChangeNoteTool(store, taskSystemProvider, docStoreProvider, adminStore) as unknown as ToolDef,
    makeValidatePrdTool(store) as unknown as ToolDef,
    makeGenerateRfcSkeletonTool(store, catalog) as unknown as ToolDef,
    makeSubmitRfcTool(store, docStoreProvider, adminStore) as unknown as ToolDef,
    makeValidateRfcTool(store) as unknown as ToolDef,
    makeProposeBreakdownTool(store, catalog) as unknown as ToolDef,
    makeCreateEpicTool(store, taskSystemProvider) as unknown as ToolDef,
    makeCreateStoriesTool(store, taskSystemProvider) as unknown as ToolDef,
    makeLinkSubtasksTool(store, taskSystemProvider) as unknown as ToolDef,
    makeSyncBacklogTool(store) as unknown as ToolDef,
    makeClaimStoryTool(store, taskSystemProvider, catalog) as unknown as ToolDef,
    makeReportProgressTool(store, taskSystemProvider) as unknown as ToolDef,
    makeGetImplementationContextTool(store, catalog) as unknown as ToolDef,
    makeGenerateQaPlanTool(store) as unknown as ToolDef,
    makeSubmitQaResultsTool(store, taskSystemProvider) as unknown as ToolDef,
    makeBlockStoryTool(store, taskSystemProvider) as unknown as ToolDef,
    makeDiscardStoryTool(store, taskSystemProvider) as unknown as ToolDef,
    makeSubmitAdrTool(store, docStoreProvider, adminStore) as unknown as ToolDef,
    makeVerifyArtifactTool(store, docStoreProvider) as unknown as ToolDef,
    makeRequestCodeReviewTool(store, pullRequestProvider) as unknown as ToolDef,
    makeSubmitReviewOutcomeTool(store, pullRequestProvider) as unknown as ToolDef,
    makeAbortFlowTool(store) as unknown as ToolDef,
  ];
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    list: () => tools,
    get: (name) => byName.get(name),
  };
}
