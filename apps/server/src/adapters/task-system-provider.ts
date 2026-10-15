import type { Flow } from '@sdlc/core';
import type { TaskSystemAdapter, TenantCtx } from '@sdlc/adapters-contracts';
import type { IntegrationConfigStore } from '../integrations/types.js';
import type { InMemoryTaskSystemAdapter } from './in-memory-task-system.js';
import { AzureDevOpsTaskSystemAdapter } from './azure-devops-task-system.js';
import { LinearTaskSystemAdapter } from './linear-task-system.js';
import {
  GitHubIssuesTaskSystemAdapter,
  type GitHubIssueState,
} from './github-issues-task-system.js';

/** Thrown when a configured adapter kind is recognised but not yet built (a later slice). */
export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}

/** Selects + builds the TaskSystemAdapter for a given flow at call time. */
export interface TaskSystemProvider {
  resolve(ctx: TenantCtx, flow: Flow): Promise<TaskSystemAdapter>;
}

export interface ConfigBackedTaskSystemProviderDeps {
  configStore: IntegrationConfigStore;
  /** Shared fake used for the default `in-memory` kind (tests/dev). */
  inMemory: InMemoryTaskSystemAdapter;
}

export class ConfigBackedTaskSystemProvider implements TaskSystemProvider {
  constructor(private readonly deps: ConfigBackedTaskSystemProviderDeps) {}

  async resolve(ctx: TenantCtx, flow: Flow): Promise<TaskSystemAdapter> {
    const cfg = await this.deps.configStore.getTaskSystemConfig(ctx.tenantId, flow.project);
    switch (cfg.kind) {
      case 'in-memory':
        return this.deps.inMemory;
      case 'azure-devops': {
        if (!cfg.secret_ref) {
          throw new Error('azure-devops adapter: secret_ref is required in task_system config');
        }
        const pat = await ctx.resolveSecret(cfg.secret_ref);
        const s = cfg.settings as Record<string, unknown>;
        return new AzureDevOpsTaskSystemAdapter({
          org:     s.org as string,
          project: s.project as string,
          pat,
          ...(s.epicType      !== undefined ? { epicType:      s.epicType      as string }                    : {}),
          ...(s.storyType     !== undefined ? { storyType:     s.storyType     as string }                    : {}),
          ...(s.subtaskType   !== undefined ? { subtaskType:   s.subtaskType   as string }                    : {}),
          ...(s.stateMap      !== undefined ? { stateMap:      s.stateMap      as Record<string, string> }    : {}),
          ...(s.areaPath      !== undefined ? { areaPath:      s.areaPath      as string }                    : {}),
          ...(s.iterationPath !== undefined ? { iterationPath: s.iterationPath as string }                    : {}),
        });
      }
      case 'linear': {
        if (!cfg.secret_ref) {
          throw new Error('linear adapter: secret_ref is required in task_system config');
        }
        const apiKey = await ctx.resolveSecret(cfg.secret_ref);
        const s = cfg.settings as Record<string, unknown>;
        return new LinearTaskSystemAdapter({
          apiKey,
          teamId: s.teamId as string,
          ...(s.projectId !== undefined ? { projectId: s.projectId as string } : {}),
          ...(s.apiUrl    !== undefined ? { apiUrl:    s.apiUrl    as string } : {}),
          ...(s.stateMap  !== undefined ? { stateMap:  s.stateMap  as Record<string, string> } : {}),
        });
      }
      case 'github': {
        if (!cfg.secret_ref) {
          throw new Error('github adapter: secret_ref is required in task_system config');
        }
        const token = await ctx.resolveSecret(cfg.secret_ref);
        const s = cfg.settings as Record<string, unknown>;
        return new GitHubIssuesTaskSystemAdapter({
          token,
          owner: s.owner as string,
          repo:  s.repo  as string,
          ...(s.apiBaseUrl          !== undefined ? { apiBaseUrl:          s.apiBaseUrl          as string } : {}),
          ...(s.typeLabelPrefix     !== undefined ? { typeLabelPrefix:     s.typeLabelPrefix     as string } : {}),
          ...(s.statusLabelPrefix   !== undefined ? { statusLabelPrefix:   s.statusLabelPrefix   as string } : {}),
          ...(s.estimateLabelPrefix !== undefined ? { estimateLabelPrefix: s.estimateLabelPrefix as string } : {}),
          ...(s.stateMap            !== undefined ? { stateMap:            s.stateMap            as Record<string, GitHubIssueState> } : {}),
        });
      }
      default:
        throw new Error(`unknown task_system kind: ${cfg.kind}`);
    }
  }
}
