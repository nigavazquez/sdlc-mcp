import { describe, expect, it } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';

const CTX: TenantCtx = {
  tenantId: 't1',
  userId: 'u1',
  roles: ['pmo'],
  async resolveSecret() {
    throw new Error('not used');
  },
};

describe('InMemoryTaskSystemAdapter', () => {
  it('reports kind azure-devops', () => {
    const a = new InMemoryTaskSystemAdapter();
    expect(a.kind).toBe('azure-devops');
  });

  it('creates an epic with a deterministic ref', async () => {
    const a = new InMemoryTaskSystemAdapter();
    const ref = await a.createEpic(
      { project_key: 'checkout', title: 'Cuotas', description: 'desc' },
      CTX,
    );
    expect(ref.external_id).toBe('ADO-1');
    expect(ref.url).toContain('checkout');
    expect(ref.url).toContain('/1');
  });

  it('creates stories/subtasks with incrementing ids and links them', async () => {
    const a = new InMemoryTaskSystemAdapter();
    const epic = await a.createEpic({ project_key: 'p', title: 'E', description: '' }, CTX);
    const story = await a.createStory(
      { project_key: 'p', epic_id: epic.external_id, title: 'S', description: '', acceptance_criteria: ['ac'] },
      CTX,
    );
    expect(story.external_id).toBe('ADO-2');
    const sub = await a.createSubtask(
      { project_key: 'p', parent_story_id: story.external_id, title: 'Sub' },
      CTX,
    );
    expect(sub.external_id).toBe('ADO-3');

    await a.linkChildToParent(story.external_id, sub.external_id, CTX);
    const fetched = await a.getItem(sub.external_id, CTX);
    expect(fetched.parent_id).toBe(story.external_id);
    expect(fetched.type).toBe('subtask');
  });

  it('transition changes status; getItem throws on unknown', async () => {
    const a = new InMemoryTaskSystemAdapter();
    const epic = await a.createEpic({ project_key: 'p', title: 'E', description: '' }, CTX);
    await a.transition(epic.external_id, 'Active', CTX);
    const fetched = await a.getItem(epic.external_id, CTX);
    expect(fetched.status).toBe('Active');
    await expect(a.getItem('ADO-999', CTX)).rejects.toThrow(/unknown/i);
  });

  it('search filters by type and parent', async () => {
    const a = new InMemoryTaskSystemAdapter();
    const epic = await a.createEpic({ project_key: 'p', title: 'E', description: '' }, CTX);
    await a.createStory(
      { project_key: 'p', epic_id: epic.external_id, title: 'S1', description: '', acceptance_criteria: [] },
      CTX,
    );
    const stories = await a.search({ parent_id: epic.external_id }, CTX);
    expect(stories.length).toBe(1);
    expect(stories[0]?.type).toBe('story');
  });
});
