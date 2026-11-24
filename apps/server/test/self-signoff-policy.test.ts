import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryAdminStore } from '../src/admin/in-memory.js';
import type { AdminStore } from '../src/admin/store.js';
import {
  selfSignoffPolicy,
  type SignoffLogger,
  type SignoffRecorder,
} from '../src/mcp/tools/self-signoff.js';
import { testCtx } from './helpers/tenant-ctx.js';

// Historia #23 (épica #20). Seam: `selfSignoffPolicy`, la única decisión de si quien
// tiene asignada una story puede firmar su QA o su review. Las tools la consumen en #26/#27.

const flow = { project: 'demo' };
const story = { story_id: 't1:demo:f::1', assignee: 'alice' };
const ctx = (userId = 'alice') =>
  testCtx({ tenantId: 't1', userId, roles: ['qa'], workspaces: ['demo'] });

function harness(adminStore?: AdminStore) {
  const counts: Array<{ name: string; attrs: Record<string, string | boolean> }> = [];
  const logs: Array<Record<string, unknown>> = [];
  const recorder: SignoffRecorder = { count: (name, attrs) => counts.push({ name, attrs }) };
  const logger: SignoffLogger = { info: (obj) => logs.push(obj) };
  const decide = (userId?: string) =>
    selfSignoffPolicy(
      { ...(adminStore ? { adminStore } : {}), recorder, logger },
      ctx(userId),
      flow,
      story,
      'submit_qa_results',
    );
  return { decide, counts, logs };
}

async function storeWith(selfSignoff: boolean) {
  const store = new InMemoryAdminStore();
  await store.createWorkspace({ workspace_id: 'demo', name: 'Demo' });
  if (!selfSignoff) await store.setSelfSignoff('demo', false, 'admin@example.com');
  return store;
}

afterEach(() => {
  delete process.env.SELF_SIGNOFF_ENABLED;
});

describe('selfSignoffPolicy', () => {
  it('si firma otra persona no es firma propia: sigue el camino actual', async () => {
    const { decide } = harness(await storeWith(false));
    expect(await decide('quinn')).toEqual({ self: false });
  });

  it('permite la firma del assignee en un workspace con self_signoff=true', async () => {
    const { decide } = harness(await storeWith(true));
    expect(await decide()).toEqual({ self: true, allowed: true });
  });

  it('sin registro del workspace vale el default (permitido)', async () => {
    const { decide } = harness(new InMemoryAdminStore());
    expect(await decide()).toEqual({ self: true, allowed: true });
  });

  it('con self_signoff=false rechaza y el mensaje dice cuál es la salida', async () => {
    const { decide } = harness(await storeWith(false));
    const out = await decide();
    expect(out).toMatchObject({ self: true, allowed: false, reason: 'disabled' });
    if (out.self && !out.allowed) {
      expect(out.error).toMatch(/demo/);
      expect(out.error).toMatch(/otra persona/);
      expect(out.error).toMatch(/admin/);
    }
  });

  it('si leer la configuración falla, rechaza (falla cerrado)', async () => {
    const broken = new InMemoryAdminStore();
    broken.getWorkspace = async () => {
      throw new Error('connection refused');
    };
    const out = await harness(broken).decide();
    expect(out).toMatchObject({ self: true, allowed: false, reason: 'store_error' });
  });

  it('con SELF_SIGNOFF_ENABLED=false rechaza en todos los workspaces, aunque estén permitidos', async () => {
    process.env.SELF_SIGNOFF_ENABLED = 'false';
    const out = await harness(await storeWith(true)).decide();
    expect(out).toMatchObject({ self: true, allowed: false, reason: 'kill_switch' });
  });

  it('cualquier otro valor del kill switch no apaga nada', async () => {
    process.env.SELF_SIGNOFF_ENABLED = 'nope';
    expect(await harness(await storeWith(true)).decide()).toEqual({ self: true, allowed: true });
  });
});

describe('observabilidad de la política', () => {
  it('cada decisión cuenta signoff.total y deja un log evt:"signoff" sin tokens', async () => {
    const { decide, counts, logs } = harness(await storeWith(true));
    await decide();

    expect(counts).toEqual([
      { name: 'signoff.total', attrs: { tool: 'submit_qa_results', self: true, allowed: true } },
    ]);
    expect(logs).toEqual([
      {
        evt: 'signoff',
        tool: 'submit_qa_results',
        workspace_id: 'demo',
        story_id: story.story_id,
        self: true,
        allowed: true,
      },
    ]);
  });

  it('un rechazo de firma propia también cuenta signoff.self_rejected con el motivo', async () => {
    const { decide, counts, logs } = harness(await storeWith(false));
    await decide();

    expect(counts).toContainEqual({
      name: 'signoff.self_rejected',
      attrs: { tool: 'submit_qa_results', reason: 'disabled' },
    });
    expect(logs[0]).toMatchObject({ allowed: false, reason: 'disabled' });
    expect(JSON.stringify(logs)).not.toMatch(/token|secret|Bearer/i);
  });

  it('una firma ajena también queda medida, sin rechazo', async () => {
    const { decide, counts } = harness(await storeWith(false));
    await decide('quinn');
    expect(counts).toEqual([
      { name: 'signoff.total', attrs: { tool: 'submit_qa_results', self: false, allowed: true } },
    ]);
  });
});
