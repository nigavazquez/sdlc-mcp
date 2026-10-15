/**
 * Live integration test against a real Azure DevOps project.
 * Skipped unless ADO_TEST_ORG, ADO_TEST_PROJECT, and ADO_TEST_PAT are set.
 * Never run in CI without those env vars configured.
 *
 * Cleanup: items are transitioned to Closed after each test run;
 * they can be deleted manually if needed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AzureDevOpsTaskSystemAdapter } from '../src/adapters/azure-devops-task-system.js';
import type { TenantCtx } from '@sdlc/adapters-contracts';

const org = process.env.ADO_TEST_ORG;
const project = process.env.ADO_TEST_PROJECT;
const pat = process.env.ADO_TEST_PAT;

const maybe = org && project && pat ? describe : describe.skip;

maybe('AzureDevOpsTaskSystemAdapter — live integration', () => {
  let adapter: AzureDevOpsTaskSystemAdapter;
  const ctx: TenantCtx = {
    tenantId: 'integration-test',
    userId: 'ci',
    roles: [],
    resolveSecret: async () => pat!,
  };

  let epicId: string;
  let storyId: string;
  let taskId: string;

  beforeAll(async () => {
    adapter = new AzureDevOpsTaskSystemAdapter({ org: org!, project: project!, pat: pat! });
    const epicRef = await adapter.createEpic(
      {
        project_key: project!,
        title: '[CI] Integration Test Epic',
        description: 'Created by automated integration test — safe to close',
        labels: ['ci-test'],
      },
      ctx,
    );
    epicId = epicRef.external_id;
  });

  afterAll(async () => {
    // Transition all created items to Closed for cleanup.
    for (const id of [taskId, storyId, epicId].filter(Boolean)) {
      try { await adapter.transition(id, 'Closed', ctx); } catch { /* ignore */ }
    }
  });

  it('creates a User Story under the Epic', async () => {
    const ref = await adapter.createStory(
      {
        project_key: project!,
        epic_id: epicId,
        title: '[CI] Integration Test Story',
        description: 'Auto-created',
        acceptance_criteria: ['AC1: system works', 'AC2: no errors'],
        labels: ['ci-test'],
        estimate: 3,
      },
      ctx,
    );
    storyId = ref.external_id;
    expect(storyId).toBeTruthy();
  });

  it('links the story as a child of the epic', async () => {
    await adapter.linkChildToParent(epicId, storyId, ctx);
    const story = await adapter.getItem(storyId, ctx);
    expect(story.parent_id).toBe(epicId);
  });

  it('creates a Task under the story', async () => {
    const ref = await adapter.createSubtask(
      { project_key: project!, parent_story_id: storyId, title: '[CI] Integration Test Task' },
      ctx,
    );
    taskId = ref.external_id;
    expect(taskId).toBeTruthy();
    await adapter.linkChildToParent(storyId, taskId, ctx);
  });

  it('transitions the story to Active', async () => {
    await adapter.transition(storyId, 'Active', ctx);
    const item = await adapter.getItem(storyId, ctx);
    expect(item.status).toBe('Active');
  });

  it('retrieves the epic and verifies fields', async () => {
    const epic = await adapter.getItem(epicId, ctx);
    expect(epic.type).toBe('epic');
    expect(epic.title).toContain('[CI] Integration Test Epic');
    expect(epic.labels).toContain('ci-test');
  });

  it('searches for Active stories containing "Integration"', async () => {
    const results = await adapter.search({ status: 'Active', text: 'Integration' }, ctx);
    const found = results.find((i) => i.external_id === storyId);
    expect(found).toBeDefined();
  });
});
