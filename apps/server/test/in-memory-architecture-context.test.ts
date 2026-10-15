import { describe, expect, it } from 'vitest';
import { InMemoryFlowStore } from '../src/state/index.js';

describe('InMemoryFlowStore — architecture context fields', () => {
  it('updateFlow persists architecture_mode, codebase_status, existing_repo', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({
      tenant_id: 't1',
      project: 'p',
      slug: 'feat-a',
      title: 'feat-a',
    });
    const updated = await store.updateFlow(flow.flow_id, {
      architecture_mode: 'reuse',
      codebase_status: 'existing',
      existing_repo: 'https://github.com/acme/repo',
    });
    expect(updated.architecture_mode).toBe('reuse');
    expect(updated.codebase_status).toBe('existing');
    expect(updated.existing_repo).toBe('https://github.com/acme/repo');

    const reread = await store.getFlow(flow.flow_id);
    expect(reread?.architecture_mode).toBe('reuse');
  });

  it('new flows have undefined architecture fields by default', async () => {
    const store = new InMemoryFlowStore();
    const flow = await store.createFlow({
      tenant_id: 't1',
      project: 'p',
      slug: 'feat-b',
      title: 'feat-b',
    });
    expect(flow.architecture_mode).toBeUndefined();
    expect(flow.codebase_status).toBeUndefined();
    expect(flow.existing_repo).toBeUndefined();
  });
});
