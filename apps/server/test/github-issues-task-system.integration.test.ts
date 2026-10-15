/**
 * Test de integración contra un repo real de GitHub.
 * Se skipea salvo que estén seteadas GITHUB_ISSUES_TEST_TOKEN,
 * GITHUB_ISSUES_TEST_OWNER y GITHUB_ISSUES_TEST_REPO.
 * Nunca correrlo en CI sin esas env vars.
 *
 * Limpieza: los issues creados se cierran como `not_planned` al terminar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { GitHubIssuesTaskSystemAdapter } from '../src/adapters/github-issues-task-system.js';

const token = process.env.GITHUB_ISSUES_TEST_TOKEN;
const owner = process.env.GITHUB_ISSUES_TEST_OWNER;
const repo = process.env.GITHUB_ISSUES_TEST_REPO;

const maybe = token && owner && repo ? describe : describe.skip;

maybe('GitHubIssuesTaskSystemAdapter — integración real', () => {
  let adapter: GitHubIssuesTaskSystemAdapter;
  const ctx: TenantCtx = {
    tenantId: 'integration-test',
    userId: 'ci',
    roles: [],
    resolveSecret: async () => token!,
  };

  let epicId: string;
  let storyId: string;
  let taskId: string;

  beforeAll(async () => {
    adapter = new GitHubIssuesTaskSystemAdapter({
      token: token!,
      owner: owner!,
      repo: repo!,
      estimateLabelPrefix: 'points:',
    });
    const epic = await adapter.createEpic(
      {
        project_key: repo!,
        title: '[CI] Integration Test Epic',
        description: 'Creado por el test de integración — se puede cerrar',
        labels: ['ci-test'],
      },
      ctx,
    );
    epicId = epic.external_id;
  });

  afterAll(async () => {
    for (const id of [taskId, storyId, epicId].filter(Boolean)) {
      try {
        await adapter.transition(id, 'Removed', ctx);
      } catch {
        /* ignore */
      }
    }
  });

  it('crea una story y la cuelga del epic como sub-issue', async () => {
    const ref = await adapter.createStory(
      {
        project_key: repo!,
        epic_id: epicId,
        title: '[CI] Integration Test Story',
        description: 'Auto-creada',
        acceptance_criteria: ['AC1: anda', 'AC2: sin errores'],
        labels: ['ci-test'],
        estimate: 3,
      },
      ctx,
    );
    storyId = ref.external_id;
    await adapter.linkChildToParent(epicId, storyId, ctx);

    const story = await adapter.getItem(storyId, ctx);
    expect(story.type).toBe('story');
    expect(story.description).toContain('- [ ] AC1: anda');
    expect(story.labels).toContain('points:3');
  });

  it('crea una subtask y la cuelga de la story', async () => {
    const ref = await adapter.createSubtask(
      { project_key: repo!, parent_story_id: storyId, title: '[CI] Integration Test Task' },
      ctx,
    );
    taskId = ref.external_id;
    await adapter.linkChildToParent(storyId, taskId, ctx);

    const children = await adapter.search({ parent_id: storyId }, ctx);
    expect(children.map((c) => c.external_id)).toContain(taskId);
  });

  it('cierra la story y la lee de vuelta como closed', async () => {
    await adapter.transition(storyId, 'Closed', ctx);
    expect((await adapter.getItem(storyId, ctx)).status).toBe('closed');
  });

  it('el epic se lee con sus labels y sin la marcadora de tipo', async () => {
    const epic = await adapter.getItem(epicId, ctx);
    expect(epic.type).toBe('epic');
    expect(epic.labels).toContain('ci-test');
    expect(epic.labels).not.toContain('sdlc:epic');
  });
});
