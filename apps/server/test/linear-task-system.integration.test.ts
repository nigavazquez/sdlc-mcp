/**
 * Test de integración contra un team real de Linear.
 * Se skipea salvo que estén seteadas LINEAR_TEST_API_KEY y LINEAR_TEST_TEAM_ID.
 * Nunca correrlo en CI sin esas env vars.
 *
 * Limpieza: los issues creados se pasan a `Canceled` al terminar; se pueden
 * borrar a mano si hace falta.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { LinearTaskSystemAdapter } from '../src/adapters/linear-task-system.js';

const apiKey = process.env.LINEAR_TEST_API_KEY;
const teamId = process.env.LINEAR_TEST_TEAM_ID;

const maybe = apiKey && teamId ? describe : describe.skip;

maybe('LinearTaskSystemAdapter — integración real', () => {
  let adapter: LinearTaskSystemAdapter;
  const ctx: TenantCtx = {
    tenantId: 'integration-test',
    userId: 'ci',
    roles: [],
    resolveSecret: async () => apiKey!,
  };

  let epicId: string;
  let storyId: string;
  let taskId: string;

  beforeAll(async () => {
    adapter = new LinearTaskSystemAdapter({ apiKey: apiKey!, teamId: teamId! });
    const epic = await adapter.createEpic(
      {
        project_key: teamId!,
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

  it('crea una story colgada del epic', async () => {
    const ref = await adapter.createStory(
      {
        project_key: teamId!,
        epic_id: epicId,
        title: '[CI] Integration Test Story',
        description: 'Auto-creada',
        acceptance_criteria: ['AC1: anda', 'AC2: sin errores'],
        labels: ['ci-test'],
      },
      ctx,
    );
    storyId = ref.external_id;
    expect(storyId).toBeTruthy();

    const story = await adapter.getItem(storyId, ctx);
    expect(story.parent_id).toBe(epicId);
    expect(story.type).toBe('story');
    expect(story.description).toContain('- [ ] AC1: anda');
  });

  it('crea una subtask colgada de la story', async () => {
    const ref = await adapter.createSubtask(
      { project_key: teamId!, parent_story_id: storyId, title: '[CI] Integration Test Task' },
      ctx,
    );
    taskId = ref.external_id;
    await adapter.linkChildToParent(storyId, taskId, ctx);

    const task = await adapter.getItem(taskId, ctx);
    expect(task.type).toBe('subtask');
    expect(task.parent_id).toBe(storyId);
  });

  it('transiciona la story a Active y lo lee de vuelta', async () => {
    await adapter.transition(storyId, 'Active', ctx);
    const item = await adapter.getItem(storyId, ctx);
    expect(item.status).toBeTruthy();
  });

  it('el epic se lee con sus labels', async () => {
    const epic = await adapter.getItem(epicId, ctx);
    expect(epic.type).toBe('epic');
    expect(epic.title).toContain('[CI] Integration Test Epic');
    expect(epic.labels).toContain('ci-test');
  });

  it('busca por texto dentro del team', async () => {
    const results = await adapter.search({ text: 'Integration Test Story' }, ctx);
    expect(results.find((i) => i.external_id === storyId)).toBeDefined();
  });
});
