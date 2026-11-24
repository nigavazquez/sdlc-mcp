import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import type {
  Annotation,
  PullRequestAdapter,
  PullRequestRef,
  TenantCtx,
} from '@sdlc/adapters-contracts';
import { Catalog } from '@sdlc/catalog';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';
import { ConfigBackedTaskSystemProvider } from '../src/adapters/task-system-provider.js';
import type { PullRequestProvider } from '../src/adapters/pull-request-provider.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import { InMemoryAdminStore } from '../src/admin/in-memory.js';
import { buildToolRegistry } from '../src/mcp/tools/index.js';
import { testCtx } from './helpers/tenant-ctx.js';
import { seedFlowStatus } from './helpers/flow-status.js';

// Historia #26 (épica #20): `submit_qa_results` con firma propia.
// Seam: la tool por el registry, con un PR adapter real (no el no-op) y el task system
// in-memory, que guardan lo que se anotó.

const PR_URL = 'https://github.com/acme/app/pull/7';

const ctx = (userId = 'alice'): TenantCtx =>
  testCtx({ tenantId: 't1', userId, roles: ['developer', 'qa'], workspaces: ['demo'] });

/** PR adapter de GitHub de mentira: sólo lo que usa la firma propia de QA. */
class FakePrAdapter implements PullRequestAdapter {
  readonly kind = 'github' as const;
  annotations: Annotation[] = [];
  fail = false;
  async annotate(_ref: PullRequestRef, a: Annotation): Promise<void> {
    if (this.fail) throw new Error('GitHub 502');
    this.annotations.push(a);
  }
  parsePrUrl(url: string): PullRequestRef {
    return { url, pr_id: '7', _parsed: {} };
  }
  async requestReview(): Promise<void> {}
  async submitOutcome(): Promise<void> {}
  async getPullRequest(): Promise<never> {
    throw new Error('no usado');
  }
}

async function setup(opts: { selfSignoff?: boolean; noPrProvider?: boolean } = {}) {
  const catalog = await Catalog.load(resolve(__dirname, '../../../packages/catalog'));
  const store = new InMemoryFlowStore();
  const taskSystem = new InMemoryTaskSystemAdapter();
  const pr = new FakePrAdapter();
  const adminStore = new InMemoryAdminStore();
  await adminStore.createWorkspace({ workspace_id: 'demo', name: 'Demo' });
  if (opts.selfSignoff === false)
    await adminStore.setSelfSignoff('demo', false, 'admin@example.com');

  const pullRequestProvider: PullRequestProvider = { resolve: async () => pr };
  const registry = buildToolRegistry({
    catalog,
    store,
    adminStore,
    taskSystemProvider: new ConfigBackedTaskSystemProvider({
      configStore: new InMemoryIntegrationConfigStore(),
      inMemory: taskSystem,
    }),
    ...(opts.noPrProvider ? {} : { pullRequestProvider }),
  });

  const flow = await store.createFlow({
    tenant_id: 't1',
    project: 'demo',
    slug: 'qa',
    title: 'QA',
  });
  await seedFlowStatus(store, flow.flow_id, {
    status: 'backlog_ready',
    current_phase: 'implementation',
  });
  const epic = await taskSystem.createEpic(
    { project_key: 'demo', title: 'E', description: 'x' },
    ctx(),
  );
  const criteria = ['el login funciona', 'el error se muestra'];
  const ref = await taskSystem.createStory(
    {
      project_key: 'demo',
      epic_id: epic.external_id,
      title: 'Login',
      description: 'd',
      acceptance_criteria: criteria,
    },
    ctx(),
  );
  const story = await store.createStory({
    flow_id: flow.flow_id,
    external_id: ref.external_id,
    external_url: ref.url,
    title: 'Login',
    acceptance_criteria: criteria,
  });

  const call = (tool: string, input: Record<string, unknown>, who = 'alice') =>
    registry.get(tool)!.handler(input, ctx(who)) as Promise<{
      ok: boolean;
      error?: string;
      data?: { story?: { status: string } };
    }>;
  await call('claim_story', { story_id: story.story_id, developer_id: 'alice' });
  await call('report_progress', { story_id: story.story_id, status: 'in_review', pr_url: PR_URL });
  const plan = (await call('generate_qa_plan', { story_id: story.story_id })) as unknown as {
    data: { qa_plan: { cases: Array<{ case_id: string }> } };
  };

  const results = (extra: Record<string, unknown> = {}) =>
    plan.data.qa_plan.cases.map((c) => ({
      case_id: c.case_id,
      status: 'passed',
      evidence_url: `https://github.com/acme/app/actions/runs/${c.case_id}`,
      ...extra,
    }));
  const submit = (who = 'alice', extra: Record<string, unknown> = {}) =>
    call(
      'submit_qa_results',
      {
        story_id: story.story_id,
        verdict: 'passed',
        results: results(extra),
        envelope: {
          schema: 'sdlc.qa-result/v1',
          test_command: 'pnpm --filter @sdlc/server test',
          test_exit_code: 0,
          test_output_hash: `sha256:${'a'.repeat(64)}`,
          acceptance_criteria: '2/2',
        },
      },
      who,
    );

  return { store, taskSystem, pr, story, flow, submit };
}

const qaEvents = async (store: InMemoryFlowStore, flowId: string) =>
  (await store.listEvents(flowId)).filter((e) => e.type === 'qa.results.submitted');

describe('submit_qa_results con firma propia', () => {
  it('el assignee firma su QA: se acepta, se anotan issue y PR y el evento lleva self_signed', async () => {
    const { store, taskSystem, pr, story, flow, submit } = await setup();
    const out = await submit('alice', {
      screenshots: ['https://github.com/acme/app/assets/login.png'],
    });

    expect(out.ok).toBe(true);
    expect(out.data?.story?.status).toBe('qa_passed');

    const issue = taskSystem.annotationsOf(story.external_id);
    expect(issue.labels).toContain('sdlc:qa-propio');
    expect(issue.comments).toHaveLength(1);
    expect(issue.comments[0]).toMatch(/QA propio/);
    expect(issue.comments[0]).toMatch(/el login funciona/);
    expect(issue.comments[0]).toMatch(
      /!\[[^\]]*\]\(https:\/\/github\.com\/acme\/app\/assets\/login\.png\)/,
    );

    expect(pr.annotations).toHaveLength(1);
    expect(pr.annotations[0]!.labels).toEqual(['sdlc:qa-propio']);
    expect(pr.annotations[0]!.body).toBe(issue.comments[0]);

    const [event] = await qaEvents(store, flow.flow_id);
    expect(event?.payload).toMatchObject({ self_signed: true });
  });

  it('si la anotación falla, se rechaza y no se escribe nada', async () => {
    const { store, taskSystem, pr, story, flow, submit } = await setup();
    pr.fail = true;
    const out = await submit();

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/anot/i);
    expect((await store.getStory(story.story_id))?.status).toBe('in_review');
    expect((await taskSystem.getItem(story.external_id, ctx())).status).toBe('Resolved');
    expect(await qaEvents(store, flow.flow_id)).toHaveLength(0);
  });

  it('sin un PR provider real se rechaza: la marca no quedaría visible', async () => {
    const { store, story, submit } = await setup({ noPrProvider: true });
    const out = await submit();

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/pr_provider/);
    expect((await store.getStory(story.story_id))?.status).toBe('in_review');
  });

  it('con el workspace en self_signoff=false se rechaza como antes', async () => {
    const { pr, submit } = await setup({ selfSignoff: false });
    const out = await submit();

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no permite la firma propia/);
    expect(pr.annotations).toHaveLength(0);
  });

  it('screenshots que no son https o usan un host prohibido se rechazan como evidence_url', async () => {
    const { store, story, submit } = await setup();

    const http = await submit('alice', {
      screenshots: ['http://github.com/acme/app/assets/a.png'],
    });
    expect(http.ok).toBe(false);
    expect(http.error).toMatch(/screenshot/i);

    const placeholder = await submit('alice', { screenshots: ['https://example.com/a.png'] });
    expect(placeholder.ok).toBe(false);
    expect(placeholder.error).toMatch(/screenshot/i);

    expect((await store.getStory(story.story_id))?.status).toBe('in_review');
  });

  it('si firma otra persona, el camino es el actual: sin etiqueta ni self_signed', async () => {
    const { store, taskSystem, pr, story, flow, submit } = await setup();
    const out = await submit('quinn');

    expect(out.ok).toBe(true);
    expect(taskSystem.annotationsOf(story.external_id).comments).toHaveLength(0);
    expect(pr.annotations).toHaveLength(0);
    const [event] = await qaEvents(store, flow.flow_id);
    expect(event?.payload).not.toHaveProperty('self_signed');
  });
});
