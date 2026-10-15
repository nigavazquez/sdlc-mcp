import { describe, expect, it } from 'vitest';
import { InMemoryFlowStore } from '../src/state/in-memory.js';

async function makeStoreWithFlow() {
  const store = new InMemoryFlowStore();
  const flow = await store.createFlow({
    tenant_id: 't1',
    project: 'p1',
    slug: 's1',
    title: 'Test flow',
  });
  return { store, flow };
}

describe('InMemoryFlowStore — stories', () => {
  it('creates and reads back a story', async () => {
    const { store, flow } = await makeStoreWithFlow();
    const created = await store.createStory({
      flow_id: flow.flow_id,
      external_id: 'ADO-7',
      external_url: 'https://example.com/7',
      title: 'Story A',
      acceptance_criteria: ['must do X'],
    });
    expect(created.status).toBe('created');
    expect(created.story_id).toBeTruthy();

    const fetched = await store.getStory(created.story_id);
    expect(fetched).toEqual(created);
  });

  it('lists stories by flow', async () => {
    const { store, flow } = await makeStoreWithFlow();
    await store.createStory({
      flow_id: flow.flow_id,
      external_id: 'ADO-1',
      external_url: 'https://example.com/1',
      title: 'A',
      acceptance_criteria: ['ac'],
    });
    await store.createStory({
      flow_id: flow.flow_id,
      external_id: 'ADO-2',
      external_url: 'https://example.com/2',
      title: 'B',
      acceptance_criteria: ['ac'],
    });
    const list = await store.listStoriesByFlow(flow.flow_id);
    expect(list.map((s) => s.external_id).sort()).toEqual(['ADO-1', 'ADO-2']);
  });

  it('updates a story and bumps updated_at', async () => {
    const { store, flow } = await makeStoreWithFlow();
    const s = await store.createStory({
      flow_id: flow.flow_id,
      external_id: 'ADO-1',
      external_url: 'https://example.com/1',
      title: 'A',
      acceptance_criteria: ['ac'],
    });
    const after = await store.updateStory(s.story_id, {
      status: 'claimed',
      assignee: 'alice',
    });
    expect(after.status).toBe('claimed');
    expect(after.assignee).toBe('alice');
    expect(after.updated_at >= s.updated_at).toBe(true);
  });

  it('throws when updating an unknown story', async () => {
    const { store } = await makeStoreWithFlow();
    await expect(store.updateStory('does-not-exist', { status: 'claimed' })).rejects.toThrow(
      /Unknown story/,
    );
  });

  it('rejects createStory for an unknown flow', async () => {
    const store = new InMemoryFlowStore();
    await expect(
      store.createStory({
        flow_id: 'missing',
        external_id: 'ADO-1',
        external_url: 'https://example.com/1',
        title: 'A',
        acceptance_criteria: ['ac'],
      }),
    ).rejects.toThrow(/unknown flow/i);
  });
});
