import type { TaskSystemAdapter } from '@sdlc/adapters-contracts';
import { InMemoryTaskSystemAdapter } from './in-memory-task-system.js';

export interface MakeTaskSystemOptions {
  /** Reserved for future selection (e.g. 'azure-devops' real adapter). */
  kind?: string;
}

/**
 * Returns the task system adapter. In this slice it always returns the
 * in-memory fake. The real Azure DevOps adapter (REST + PAT via vault) will be
 * selected here by config/env in a later slice.
 */
export function makeTaskSystemAdapter(_opts: MakeTaskSystemOptions = {}): TaskSystemAdapter {
  return new InMemoryTaskSystemAdapter();
}
