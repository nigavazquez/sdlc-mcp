import { afterEach, describe, expect, it } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { Catalog } from '@sdlc/catalog';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';
import { ConfigBackedTaskSystemProvider } from '../src/adapters/task-system-provider.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import { buildToolRegistry } from '../src/mcp/tools/index.js';
import { testCtx, type TestCtxOptions } from './helpers/tenant-ctx.js';
import { resolve } from 'node:path';
import { seedFlowStatus } from './helpers/flow-status.js';

// El claim `workspaces` va explícito: las guardas de workspace ya no dejan pasar un ctx sin él.
//
// Los overrides entran *por* `testCtx` en vez de spreadearse encima del ctx ya construido:
// las tools evalúan el rol contra `ctx.workspaces[flow.project]`, así que un override de
// `roles` tiene que rederivar el mapa del claim. Spreadeándolo por arriba quedaba
// `ctx.roles` nuevo con el mapa viejo, y todo se rechazaba por rol.
const ctx = (overrides: Partial<TestCtxOptions> = {}): TenantCtx =>
  testCtx({
    tenantId: 't1',
    userId: 'alice',
    roles: ['developer'],
    workspaces: ['demo'],
    resolveSecret: async () => { throw new Error('no secrets'); },
    ...overrides,
  });

/**
 * QA lo firma alguien distinto del assignee: `submit_qa_results` aplica
 * separacion de funciones, asi que el ctx de QA nunca puede ser 'alice'.
 */
const qaCtx = (overrides: Partial<TestCtxOptions> = {}): TenantCtx =>
  ctx({ userId: 'quinn', roles: ['qa'], ...overrides });

/** Host de evidencia plausible (ni example.com ni localhost, que ahora se rechazan). */
const evidence = (path: string) => `https://ci.acme-corp.dev/${path}`;

/** sha256 de juguete con la forma que exige el envelope. */
const hash = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;

/**
 * Envelope válido para la story que siembra `seedReadyFlow`, que tiene **2**
 * criterios de aceptación — el denominador lo verifica el server contra
 * `story.acceptance_criteria.length`, así que no es un número libre.
 */
const envelope = (overrides: Record<string, unknown> = {}) => ({
  schema: 'sdlc.qa-result/v1',
  test_command: 'pnpm --filter @sdlc/server test',
  test_exit_code: 0,
  test_output_hash: hash('a'),
  acceptance_criteria: '2/2',
  ...overrides,
});

/** El mismo envelope para una corrida en rojo (la que acompaña a un `blocked`). */
const failedEnvelope = (overrides: Record<string, unknown> = {}) =>
  envelope({ test_exit_code: 1, test_output_hash: hash('b'), ...overrides });

async function makeRegistry() {
  const catalog = await Catalog.load(resolve(__dirname, '../../../packages/catalog'));
  const store = new InMemoryFlowStore();
  const taskSystem = new InMemoryTaskSystemAdapter();
  const taskSystemProvider = new ConfigBackedTaskSystemProvider({
    configStore: new InMemoryIntegrationConfigStore(),
    inMemory: taskSystem,
  });
  const registry = buildToolRegistry({ catalog, store, taskSystemProvider });
  return { store, taskSystem, registry };
}

async function seedReadyFlow(store: InMemoryFlowStore, taskSystem: InMemoryTaskSystemAdapter) {
  const flow = await store.createFlow({
    tenant_id: 't1',
    project: 'demo',
    slug: 'login',
    title: 'Login feature',
  });
  await seedFlowStatus(store, flow.flow_id, {
    status: 'backlog_ready',
    current_phase: 'implementation',
    epic_external_id: 'ADO-1',
    architecture_mode: 'new',
    codebase_status: 'greenfield',
  });
  const epicRef = await taskSystem.createEpic(
    { project_key: 'demo', title: 'Login', description: 'x' },
    ctx(),
  );
  const storyRef = await taskSystem.createStory(
    {
      project_key: 'demo',
      epic_id: epicRef.external_id,
      title: 'User logs in',
      description: 'happy login',
      acceptance_criteria: ['email/password works', 'failure shows error'],
    },
    ctx(),
  );
  const story = await store.createStory({
    flow_id: flow.flow_id,
    external_id: storyRef.external_id,
    external_url: storyRef.url,
    title: 'User logs in',
    acceptance_criteria: ['email/password works', 'failure shows error'],
  });
  return { flow, story };
}

describe('claim_story', () => {
  it('claims a created story, transitions adapter, emits event', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, story } = await seedReadyFlow(store, taskSystem);

    const tool = registry.get('claim_story');
    expect(tool).toBeDefined();

    const out = (await tool!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    )) as { ok: boolean; data?: { story: { status: string; assignee?: string } } };

    expect(out.ok).toBe(true);
    expect(out.data?.story.status).toBe('claimed');
    expect(out.data?.story.assignee).toBe('alice');

    const adapterItem = await taskSystem.getItem(story.external_id, ctx());
    expect(adapterItem.status).toBe('Active');

    const events = await store.listEvents(flow.flow_id);
    expect(events.some((e) => e.type === 'story.claimed')).toBe(true);
  });

  it('is idempotent for the same developer', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    const tool = registry.get('claim_story')!;

    const first = await tool.handler({ story_id: story.story_id, developer_id: 'alice' }, ctx());
    const second = await tool.handler({ story_id: story.story_id, developer_id: 'alice' }, ctx());

    expect((first as { ok: boolean }).ok).toBe(true);
    expect((second as { ok: boolean }).ok).toBe(true);

    const events = await store.listEvents(story.flow_id);
    expect(events.filter((e) => e.type === 'story.claimed')).toHaveLength(1);
  });

  it('rejects claim if already taken by another developer', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    const tool = registry.get('claim_story')!;
    await tool.handler({ story_id: story.story_id, developer_id: 'alice' }, ctx());
    const out = (await tool.handler(
      { story_id: story.story_id, developer_id: 'bob' },
      ctx({ userId: 'bob' }),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/already claimed/i);
  });

  it('rejects when developer_id does not match ctx.userId', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    const out = (await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'someone_else' },
      ctx(),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/developer_id.*userId|impersonat/i);
  });
});

describe('report_progress', () => {
  it('moves claimed → in_progress, then in_progress → in_review with pr_url', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );

    const report = registry.get('report_progress')!;
    const a = (await report.handler(
      { story_id: story.story_id, status: 'in_progress' },
      ctx(),
    )) as { ok: boolean; data?: { story: { status: string } } };
    expect(a.ok).toBe(true);
    expect(a.data?.story.status).toBe('in_progress');

    const b = (await report.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://example.com/pr/1' },
      ctx(),
    )) as { ok: boolean; data?: { story: { status: string; pr_url?: string } } };
    expect(b.ok).toBe(true);
    expect(b.data?.story.status).toBe('in_review');
    expect(b.data?.story.pr_url).toBe('https://example.com/pr/1');

    const item = await taskSystem.getItem(story.external_id, ctx());
    expect(item.status).toBe('Resolved');

    const events = await store.listEvents(story.flow_id);
    const progressEvents = events.filter((e) => e.type === 'progress.reported');
    expect(progressEvents).toHaveLength(2);
    expect((progressEvents[0]?.payload as { status: string }).status).toBe('in_progress');
    expect((progressEvents[1]?.payload as { status: string }).status).toBe('in_review');
  });

  it('rejects in_review without pr_url', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    const out = (await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review' },
      ctx(),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/pr_url/i);
  });

  it('rejects when caller is not the assignee', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    const out = (await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_progress' },
      ctx({ userId: 'mallory' }),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/assignee/i);
  });

  it('rejects FSM-invalid transitions (e.g. in_review → in_progress)', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    const report = registry.get('report_progress')!;
    await report.handler({ story_id: story.story_id, status: 'in_progress' }, ctx());
    await report.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://example.com/pr/1' },
      ctx(),
    );
    // in_review → in_progress is not in the FSM (in_review only allows qa_passed/blocked)
    const out = (await report.handler(
      { story_id: story.story_id, status: 'in_progress' },
      ctx(),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/invalid transition/i);
  });
});

describe('get_implementation_context', () => {
  it('returns story + flow refs + null excerpt when no rfc_markdown is passed', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    const out = (await registry.get('get_implementation_context')!.handler(
      { story_id: story.story_id },
      qaCtx(),
    )) as { ok: boolean; data?: { rfc_excerpt: string | null; story: { status: string } } };
    expect(out.ok).toBe(true);
    expect(out.data?.rfc_excerpt).toBeNull();
    expect(out.data?.story.status).toBe('claimed');
  });

  it('extracts Design + Risks sections from rfc_markdown when supplied', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    const rfc = [
      '# RFC',
      '## Goals',
      'Goal A',
      '## Design',
      'Use Postgres + Drizzle.',
      '## Risks',
      'Migration takes the table offline briefly.',
      '## Other',
      'irrelevant',
    ].join('\n');
    const out = (await registry.get('get_implementation_context')!.handler(
      { story_id: story.story_id, rfc_markdown: rfc },
      qaCtx(),
    )) as { ok: boolean; data?: { rfc_excerpt: string } };
    expect(out.ok).toBe(true);
    expect(out.data?.rfc_excerpt).toMatch(/Postgres \+ Drizzle/);
    expect(out.data?.rfc_excerpt).toMatch(/Migration takes the table offline/);
    expect(out.data?.rfc_excerpt).not.toMatch(/irrelevant/);
  });

  it('rejects when story is still in created status', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    const out = (await registry.get('get_implementation_context')!.handler(
      { story_id: story.story_id },
      qaCtx(),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not.*claimed|created/i);
  });

  it('returns null excerpt when rfc_markdown has no Design/Risks sections', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    const rfc = ['# RFC', '## Goals', 'Goal A', '## Other', 'nothing relevant'].join('\n');
    const out = (await registry.get('get_implementation_context')!.handler(
      { story_id: story.story_id, rfc_markdown: rfc },
      qaCtx(),
    )) as { ok: boolean; data?: { rfc_excerpt: string | null } };
    expect(out.ok).toBe(true);
    expect(out.data?.rfc_excerpt).toBeNull();
  });
});

describe('generate_qa_plan', () => {
  it('rejects when story is not at least in_review', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    const out = (await registry.get('generate_qa_plan')!.handler(
      { story_id: story.story_id },
      qaCtx(),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/in_review|qa_passed|blocked/i);
  });

  it('rejects status=in_progress too (not just claimed)', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_progress' },
      ctx(),
    );
    const out = (await registry.get('generate_qa_plan')!.handler(
      { story_id: story.story_id },
      qaCtx(),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/in_review|qa_passed|blocked/i);
  });

  it('persists the plan on the story row and emits qa.plan.generated', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://example.com/pr/1' },
      ctx(),
    );
    const out = (await registry.get('generate_qa_plan')!.handler(
      { story_id: story.story_id },
      qaCtx(),
    )) as { ok: boolean; data?: { qa_plan: { cases: Array<{ case_id: string }> } } };
    expect(out.ok).toBe(true);
    expect(out.data?.qa_plan.cases.map((c) => c.case_id)).toEqual([
      'AC-1', 'AC-2', 'EDGE-1', 'EDGE-2',
    ]);

    const stored = await store.getStory(story.story_id);
    expect(stored?.qa_plan?.cases.length).toBe(4);

    const events = await store.listEvents(story.flow_id);
    expect(events.filter((e) => e.type === 'qa.plan.generated')).toHaveLength(1);
  });

  it('regenerates and replaces qa_plan on a second call', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://example.com/pr/1' },
      ctx(),
    );
    const tool = registry.get('generate_qa_plan')!;
    const first = (await tool.handler(
      { story_id: story.story_id },
      qaCtx(),
    )) as { data: { qa_plan: { generated_at: string; cases: unknown[] } } };
    // Force a different timestamp on the second call
    await new Promise((r) => setTimeout(r, 5));
    const second = (await tool.handler(
      { story_id: story.story_id },
      qaCtx(),
    )) as { data: { qa_plan: { generated_at: string; cases: unknown[] } } };

    expect(second.data.qa_plan.generated_at >= first.data.qa_plan.generated_at).toBe(true);

    const stored = await store.getStory(story.story_id);
    expect(stored?.qa_plan?.generated_at).toBe(second.data.qa_plan.generated_at);

    const events = await store.listEvents(story.flow_id);
    expect(events.filter((e) => e.type === 'qa.plan.generated')).toHaveLength(2);
  });
});

describe('submit_qa_results', () => {
  async function setupReadyForQa() {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://example.com/pr/1' },
      ctx(),
    );
    await registry.get('generate_qa_plan')!.handler(
      { story_id: story.story_id },
      qaCtx(),
    );
    return { store, taskSystem, registry, story };
  }

  it('marks the story qa_passed and closes the work item', async () => {
    const { taskSystem, registry, story } = await setupReadyForQa();
    const out = (await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: [
          { case_id: 'AC-1', status: 'passed', evidence_url: evidence('ac-1') },
          { case_id: 'AC-2', status: 'passed', evidence_url: evidence('ac-2') },
          { case_id: 'EDGE-1', status: 'passed', evidence_url: evidence('edge-1') },
          { case_id: 'EDGE-2', status: 'passed', evidence_url: evidence('edge-2') },
        ],
        envelope: envelope(),
        verdict: 'passed',
      },
      qaCtx(),
    )) as { ok: boolean; data?: { story: { status: string; qa_verdict?: string } } };
    expect(out.ok).toBe(true);
    expect(out.data?.story.status).toBe('qa_passed');
    expect(out.data?.story.qa_verdict).toBe('passed');
    const item = await taskSystem.getItem(story.external_id, ctx());
    expect(item.status).toBe('Closed');
  });

  it('marks the story blocked with a reason and reopens the work item', async () => {
    const { taskSystem, registry, story } = await setupReadyForQa();
    const out = (await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: [
          { case_id: 'AC-1', status: 'passed', evidence_url: evidence('ac-1') },
          {
            case_id: 'AC-2',
            status: 'failed',
            evidence_url: evidence('log/42'),
            notes: 'wrong error message',
          },
          { case_id: 'EDGE-1', status: 'passed', evidence_url: evidence('edge-1') },
          { case_id: 'EDGE-2', status: 'passed', evidence_url: evidence('edge-2') },
        ],
        envelope: failedEnvelope(),
        verdict: 'blocked',
        block_reason: 'AC-2 fails with wrong copy',
      },
      qaCtx(),
    )) as { ok: boolean; data?: { story: { status: string; qa_block_reason?: string } } };
    expect(out.ok).toBe(true);
    expect(out.data?.story.status).toBe('blocked');
    expect(out.data?.story.qa_block_reason).toBe('AC-2 fails with wrong copy');
    const item = await taskSystem.getItem(story.external_id, ctx());
    expect(item.status).toBe('Active');
  });

  it('rejects when plan is missing', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://example.com/pr/1' },
      ctx(),
    );
    const out = (await registry.get('submit_qa_results')!.handler(
      { story_id: story.story_id, results: [], verdict: 'passed' },
      qaCtx(),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/plan/i);
  });

  it('rejects passed verdict with any failed case', async () => {
    const { registry, story } = await setupReadyForQa();
    const out = (await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: [
          { case_id: 'AC-1', status: 'failed', evidence_url: evidence('log') },
          { case_id: 'AC-2', status: 'passed', evidence_url: evidence('ac-2') },
          { case_id: 'EDGE-1', status: 'passed', evidence_url: evidence('edge-1') },
          { case_id: 'EDGE-2', status: 'passed', evidence_url: evidence('edge-2') },
        ],
        envelope: failedEnvelope(),
        verdict: 'passed',
      },
      qaCtx(),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/passed.*failed|inconsistent/i);
  });

  it('rejects blocked verdict without block_reason or without evidence', async () => {
    const { registry, story } = await setupReadyForQa();
    const noReason = (await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: [
          { case_id: 'AC-1', status: 'passed', evidence_url: evidence('ac-1') },
          { case_id: 'AC-2', status: 'failed', evidence_url: evidence('log') },
          { case_id: 'EDGE-1', status: 'passed', evidence_url: evidence('edge-1') },
          { case_id: 'EDGE-2', status: 'passed', evidence_url: evidence('edge-2') },
        ],
        envelope: failedEnvelope(),
        verdict: 'blocked',
      },
      qaCtx(),
    )) as { ok: boolean; error?: string };
    expect(noReason.ok).toBe(false);

    const noEvidence = (await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: [
          { case_id: 'AC-1', status: 'passed', evidence_url: evidence('ac-1') },
          { case_id: 'AC-2', status: 'failed' },
          { case_id: 'EDGE-1', status: 'passed', evidence_url: evidence('edge-1') },
          { case_id: 'EDGE-2', status: 'passed', evidence_url: evidence('edge-2') },
        ],
        envelope: failedEnvelope(),
        verdict: 'blocked',
        block_reason: 'why',
      },
      qaCtx(),
    )) as { ok: boolean; error?: string };
    expect(noEvidence.ok).toBe(false);
    expect(noEvidence.error).toMatch(/evidence/i);
  });

  it('rejects unknown case_id and incomplete coverage', async () => {
    const { registry, story } = await setupReadyForQa();
    const unknown = (await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: [
          { case_id: 'AC-1', status: 'passed', evidence_url: evidence('ac-1') },
          { case_id: 'AC-2', status: 'passed', evidence_url: evidence('ac-2') },
          { case_id: 'EDGE-1', status: 'passed', evidence_url: evidence('edge-1') },
          { case_id: 'EDGE-2', status: 'passed', evidence_url: evidence('edge-2') },
          { case_id: 'AC-99', status: 'passed', evidence_url: evidence('ac-99') },
        ],
        envelope: envelope(),
        verdict: 'passed',
      },
      qaCtx(),
    )) as { ok: boolean; error?: string };
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/AC-99|unknown case/i);

    const incomplete = (await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: [
          { case_id: 'AC-1', status: 'passed', evidence_url: evidence('ac-1') },
          { case_id: 'AC-2', status: 'passed', evidence_url: evidence('ac-2') },
          { case_id: 'EDGE-1', status: 'passed', evidence_url: evidence('edge-1') },
        ],
        envelope: envelope(),
        verdict: 'passed',
      },
      qaCtx(),
    )) as { ok: boolean; error?: string };
    expect(incomplete.ok).toBe(false);
    expect(incomplete.error).toMatch(/missing|coverage|EDGE-2/i);
  });

  it('rejects duplicate case_id in results', async () => {
    const { registry, story } = await setupReadyForQa();
    const out = (await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: [
          { case_id: 'AC-1', status: 'passed', evidence_url: evidence('ac-1') },
          // duplicado a propósito
          { case_id: 'AC-1', status: 'passed', evidence_url: evidence('ac-1') },
          { case_id: 'AC-2', status: 'passed', evidence_url: evidence('ac-2') },
          { case_id: 'EDGE-1', status: 'passed', evidence_url: evidence('edge-1') },
          { case_id: 'EDGE-2', status: 'passed', evidence_url: evidence('edge-2') },
        ],
        envelope: envelope(),
        verdict: 'passed',
      },
      qaCtx(),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/duplicate/i);
  });

  it('clears qa_block_reason when a previously blocked story now passes', async () => {
    const { store, taskSystem, registry, story } = await setupReadyForQa();
    // First round: block
    await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: [
          { case_id: 'AC-1', status: 'passed', evidence_url: evidence('ac-1') },
          { case_id: 'AC-2', status: 'failed', evidence_url: evidence('log') },
          { case_id: 'EDGE-1', status: 'passed', evidence_url: evidence('edge-1') },
          { case_id: 'EDGE-2', status: 'passed', evidence_url: evidence('edge-2') },
        ],
        envelope: failedEnvelope(),
        verdict: 'blocked',
        block_reason: 'first round failure',
      },
      qaCtx(),
    );
    let stored = await store.getStory(story.story_id);
    expect(stored?.qa_block_reason).toBe('first round failure');

    // Dev fixes; advance back to in_review and regenerate the plan
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_progress' },
      ctx(),
    );
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://example.com/pr/2' },
      ctx(),
    );
    await registry.get('generate_qa_plan')!.handler(
      { story_id: story.story_id },
      qaCtx(),
    );

    // Second round: pass
    await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: [
          { case_id: 'AC-1', status: 'passed', evidence_url: evidence('ac-1') },
          { case_id: 'AC-2', status: 'passed', evidence_url: evidence('ac-2') },
          { case_id: 'EDGE-1', status: 'passed', evidence_url: evidence('edge-1') },
          { case_id: 'EDGE-2', status: 'passed', evidence_url: evidence('edge-2') },
        ],
        envelope: envelope({ test_output_hash: hash('c') }),
        verdict: 'passed',
      },
      qaCtx(),
    );
    stored = await store.getStory(story.story_id);
    expect(stored?.status).toBe('qa_passed');
    expect(stored?.qa_verdict).toBe('passed');
    expect(stored?.qa_block_reason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// El gate de QA: evidencia obligatoria, evidencia plausible, separación de funciones
// ---------------------------------------------------------------------------

describe('submit_qa_results: gate de evidencia y roles', () => {
  const ALLOWLIST_ENV = 'QA_EVIDENCE_HOST_ALLOWLIST';

  afterEach(() => {
    delete process.env[ALLOWLIST_ENV];
  });

  async function setupReadyForQa() {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://example.com/pr/1' },
      ctx(),
    );
    await registry.get('generate_qa_plan')!.handler({ story_id: story.story_id }, qaCtx());
    return { store, taskSystem, registry, story };
  }

  /** Los 4 casos del plan, con evidencia real salvo la que se pise por caso. */
  const allCases = (overrides: Record<string, unknown> = {}) =>
    ['AC-1', 'AC-2', 'EDGE-1', 'EDGE-2'].map((case_id) => ({
      case_id,
      status: 'passed',
      evidence_url: evidence(case_id.toLowerCase()),
      ...((overrides[case_id] as Record<string, unknown>) ?? {}),
    }));

  const submit = async (
    registry: Awaited<ReturnType<typeof makeRegistry>>['registry'],
    story_id: string,
    results: unknown[],
    callerCtx: TenantCtx = qaCtx(),
  ) =>
    (await registry.get('submit_qa_results')!.handler(
      { story_id, results, envelope: envelope(), verdict: 'passed' },
      callerCtx,
    )) as { ok: boolean; error?: string; data?: { story: { status: string } } };

  it('rechaza un verdict passed sin evidencia y nombra TODOS los casos que faltan', async () => {
    const { taskSystem, registry, story } = await setupReadyForQa();
    const results = allCases({
      'AC-1': { evidence_url: undefined },
      'EDGE-2': { evidence_url: undefined },
    });
    const out = await submit(registry, story.story_id, results);

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/AC-1/);
    expect(out.error).toMatch(/EDGE-2/);
    // No los casos que sí traen evidencia.
    expect(out.error).not.toMatch(/AC-2/);
    // Y nombra la salida ejecutable.
    expect(out.error).toMatch(/submit_qa_results/);
    expect(out.error).toMatch(/block_story/);

    // Guarda antes del side-effect: el work item no se movió.
    const item = await taskSystem.getItem(story.external_id, ctx());
    expect(item.status).toBe('Resolved');
  });

  it('rechaza evidencia con hosts de relleno (example.com, subdominio, loopback, sin punto)', async () => {
    const { registry, story } = await setupReadyForQa();
    for (const url of [
      'https://example.com/log/1',
      'https://ci.example.com/log/1',
      'http://localhost:3000/log/1',
      'http://127.0.0.1/log/1',
      'http://[::1]/log/1',
      'https://intranet/log/1',
    ]) {
      const out = await submit(
        registry,
        story.story_id,
        allCases({ 'AC-1': { evidence_url: url } }),
      );
      expect(out.ok, `debería rechazar ${url}`).toBe(false);
      expect(out.error).toMatch(/AC-1/);
      expect(out.error).toMatch(/relleno/i);
      expect(out.error).toMatch(/submit_qa_results/);
    }
  });

  // Los cinco que pasaron el gate anterior, textuales del reporte del reviewer.
  // Cada uno es sintácticamente una URL http(s) impecable con un host que tiene
  // punto: por eso pasaban. Ninguno lleva a una corrida que alguien más pueda ver.
  it('rechaza los hosts y paths de relleno que el reviewer usó para pasar el gate', async () => {
    const { taskSystem, registry, story } = await setupReadyForQa();
    const rotos: Array<[string, RegExp]> = [
      // El comentario del código decía que mataba "TODO"; no había ningún regex.
      ['https://ci.acme.dev/TODO', /path o la query/i],
      // "n/a" percent-encodeado para que no se vea como slash.
      ['https://n.ai/n%2Fa', /path o la query/i],
      // .test e .invalid son de la misma RFC 2606 que .example, que sí estaba.
      ['https://foo.test/log', /relleno/i],
      ['https://foo.invalid/log', /relleno/i],
      // Rango privado: puede ser un link real en la máquina del agente y aun así
      // no lo puede abrir nadie que audite la story después.
      ['http://192.168.0.10/log', /relleno/i],
    ];
    for (const [url, motivo] of rotos) {
      const out = await submit(registry, story.story_id, allCases({ 'AC-1': { evidence_url: url } }));
      expect(out.ok, `debería rechazar ${url}`).toBe(false);
      expect(out.error, url).toMatch(/AC-1/);
      expect(out.error, url).toMatch(motivo);
      // Y nombra la salida ejecutable.
      expect(out.error, url).toMatch(/submit_qa_results/);
    }
    // Ninguno de los cinco tocó el work item.
    const item = await taskSystem.getItem(story.external_id, ctx());
    expect(item.status).toBe('Resolved');
  });

  it('rechaza el resto de los rangos privados y de los TLDs reservados', async () => {
    const { registry, story } = await setupReadyForQa();
    for (const url of [
      'http://10.0.0.5/log',
      'http://172.16.4.9/log',
      'http://172.31.255.1/log',
      'http://127.0.0.2/log',
      'http://169.254.1.1/log',
      'https://runs.example/log',
      'https://ci.acme.local/log',
      'https://ci.acme.internal/log',
    ]) {
      const out = await submit(registry, story.story_id, allCases({ 'AC-2': { evidence_url: url } }));
      expect(out.ok, `debería rechazar ${url}`).toBe(false);
      expect(out.error, url).toMatch(/relleno/i);
    }
  });

  it('acepta un host público con un rango que sólo se parece a uno privado', async () => {
    // 172.15 y 172.32 quedan fuera de 172.16/12: rechazarlos sería falso positivo.
    const { registry, story } = await setupReadyForQa();
    const out = await submit(
      registry,
      story.story_id,
      allCases({
        'AC-1': { evidence_url: 'http://172.15.0.1/runs/1' },
        'AC-2': { evidence_url: 'http://172.32.0.1/runs/2' },
        'EDGE-1': { evidence_url: 'https://ci.acme-corp.dev/runs/todo-list/3' },
        'EDGE-2': { evidence_url: 'https://ci.acme-corp.dev/runs/4?job=none-of-that' },
      }),
    );
    expect(out.ok).toBe(true);
  });

  it('rechaza esquemas que no son http/https', async () => {
    const { registry, story } = await setupReadyForQa();
    for (const url of ['ftp://ci.acme-corp.dev/log', 'file:///tmp/log.txt', 'n/a']) {
      const out = await submit(
        registry,
        story.story_id,
        allCases({ 'AC-2': { evidence_url: url } }),
      );
      expect(out.ok, `debería rechazar ${url}`).toBe(false);
      expect(out.error).toMatch(/AC-2/);
      expect(out.error).toMatch(/http/i);
    }
  });

  it('con QA_EVIDENCE_HOST_ALLOWLIST seteado rechaza un host de afuera', async () => {
    const { registry, story } = await setupReadyForQa();
    process.env[ALLOWLIST_ENV] = 'ci.miempresa.com, dev.azure.com';
    const out = await submit(
      registry,
      story.story_id,
      allCases({ 'EDGE-1': { evidence_url: 'https://pastebin.dev/abc' } }),
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/EDGE-1/);
    expect(out.error).toMatch(/QA_EVIDENCE_HOST_ALLOWLIST/);
    expect(out.error).toMatch(/ci\.miempresa\.com/);
  });

  it('con allowlist seteado acepta un host de adentro (y sus subdominios)', async () => {
    const { taskSystem, registry, story } = await setupReadyForQa();
    process.env[ALLOWLIST_ENV] = 'miempresa.com';
    const out = await submit(
      registry,
      story.story_id,
      allCases({
        'AC-1': { evidence_url: 'https://miempresa.com/runs/1' },
        'AC-2': { evidence_url: 'https://ci.miempresa.com/runs/2' },
        'EDGE-1': { evidence_url: 'https://ci.miempresa.com/runs/3' },
        'EDGE-2': { evidence_url: 'https://ci.miempresa.com/runs/4' },
      }),
    );
    expect(out.ok).toBe(true);
    expect(out.data?.story.status).toBe('qa_passed');
    const item = await taskSystem.getItem(story.external_id, ctx());
    expect(item.status).toBe('Closed');
  });

  it('sin allowlist, cualquier host plausible pasa y el work item se cierra', async () => {
    const { taskSystem, registry, story } = await setupReadyForQa();
    const out = await submit(registry, story.story_id, allCases());
    expect(out.ok).toBe(true);
    expect(out.data?.story.status).toBe('qa_passed');
    const item = await taskSystem.getItem(story.external_id, ctx());
    expect(item.status).toBe('Closed');
  });

  it('rechaza al rol equivocado y nombra quién puede firmar', async () => {
    const { taskSystem, registry, story } = await setupReadyForQa();
    const out = await submit(
      registry,
      story.story_id,
      allCases(),
      ctx({ userId: 'dave', roles: ['developer'] }),
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/rol qa o tech-lead/i);
    const item = await taskSystem.getItem(story.external_id, ctx());
    expect(item.status).toBe('Resolved');
  });

  it('acepta a tech-lead como firmante', async () => {
    const { registry, story } = await setupReadyForQa();
    const out = await submit(
      registry,
      story.story_id,
      allCases(),
      ctx({ userId: 'tina', roles: ['tech-lead'] }),
    );
    expect(out.ok).toBe(true);
  });

  it('evalúa los roles contra el workspace del flow, no contra el tenant', async () => {
    const { registry, story } = await setupReadyForQa();
    // Es qa en otro workspace, pero sólo developer en "demo" (el project del flow).
    const out = await submit(
      registry,
      story.story_id,
      allCases(),
      ctx({
        userId: 'quinn',
        roles: ['qa'],
        workspaces: { demo: ['developer'], otro: ['qa'] },
      }),
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/demo/);
  });

  it('el assignee no puede firmar su propio QA', async () => {
    const { taskSystem, registry, story } = await setupReadyForQa();
    // alice tiene la story asignada; aunque además sea qa, no firma.
    const out = await submit(
      registry,
      story.story_id,
      allCases(),
      ctx({ userId: 'alice', roles: ['qa'] }),
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/alice/);
    expect(out.error).toMatch(/su propio trabajo|otra persona/i);
    const item = await taskSystem.getItem(story.external_id, ctx());
    expect(item.status).toBe('Resolved');
  });

  it('el camino feliz con evidencia real sigue transicionando el work item', async () => {
    const { store, taskSystem, registry, story } = await setupReadyForQa();
    const out = await submit(registry, story.story_id, allCases());
    expect(out.ok).toBe(true);

    const stored = await store.getStory(story.story_id);
    expect(stored?.status).toBe('qa_passed');
    expect(stored?.qa_verdict).toBe('passed');
    const item = await taskSystem.getItem(story.external_id, ctx());
    expect(item.status).toBe('Closed');

    const events = await store.listEvents(story.flow_id);
    const submitted = events.filter((e) => e.type === 'qa.results.submitted');
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.actor).toBe('quinn');
  });
});

// ---------------------------------------------------------------------------
// El envelope de la corrida: el veredicto se deriva de él, no de la prosa
// ---------------------------------------------------------------------------

describe('submit_qa_results: envelope de la corrida', () => {
  async function setupReadyForQa() {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://example.com/pr/1' },
      ctx(),
    );
    await registry.get('generate_qa_plan')!.handler({ story_id: story.story_id }, qaCtx());
    return { store, taskSystem, registry, story };
  }

  const allPassed = () =>
    ['AC-1', 'AC-2', 'EDGE-1', 'EDGE-2'].map((case_id) => ({
      case_id,
      status: 'passed',
      evidence_url: evidence(case_id.toLowerCase()),
    }));

  const allButOne = () =>
    allPassed().map((r) =>
      r.case_id === 'AC-2'
        ? { ...r, status: 'failed', evidence_url: evidence('runs/42'), notes: 'copy equivocado' }
        : r,
    );

  const send = async (
    registry: Awaited<ReturnType<typeof makeRegistry>>['registry'],
    story_id: string,
    input: Record<string, unknown>,
  ) =>
    (await registry.get('submit_qa_results')!.handler(
      { story_id, results: allPassed(), verdict: 'passed', ...input },
      qaCtx(),
    )) as {
      ok: boolean;
      error?: string;
      data?: { story: { status: string }; envelope?: { test_output_hash: string } };
    };

  it('rechaza la corrida sin envelope y muestra el bloque que hay que mandar', async () => {
    const { registry, story } = await setupReadyForQa();
    const out = await send(registry, story.story_id, {});
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/envelope/i);
    expect(out.error).toMatch(/sdlc\.qa-result\/v1/);
    expect(out.error).toMatch(/test_command/);
    expect(out.error).toMatch(/test_exit_code/);
    expect(out.error).toMatch(/test_output_hash/);
    expect(out.error).toMatch(/acceptance_criteria/);
    // Nombra las dos salidas ejecutables.
    expect(out.error).toMatch(/submit_qa_results/);
    expect(out.error).toMatch(/block_story/);
  });

  it('rechaza un schema tag que no es el que este server entiende', async () => {
    const { registry, story } = await setupReadyForQa();
    const out = await send(registry, story.story_id, {
      envelope: envelope({ schema: 'sdlc.qa-result/v2' }),
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/sdlc\.qa-result\/v1/);
  });

  it('rechaza verdict "passed" con test_exit_code distinto de 0', async () => {
    const { store, taskSystem, registry, story } = await setupReadyForQa();
    const out = await send(registry, story.story_id, {
      envelope: envelope({ test_exit_code: 1 }),
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/test_exit_code=1/);
    // La continuación: o blocked con razón, o volver a correr hasta exit 0.
    expect(out.error).toMatch(/blocked/);
    expect(out.error).toMatch(/block_reason/);
    expect(out.error).toMatch(/submit_qa_results/);
    // Y no escribió nada.
    expect((await store.getStory(story.story_id))?.status).toBe('in_review');
    expect((await taskSystem.getItem(story.external_id, ctx())).status).toBe('Resolved');
  });

  it('rechaza el denominador de acceptance_criteria que no coincide con la story', async () => {
    const { registry, story } = await setupReadyForQa();
    // La story tiene 2 criterios; el agente declara 10 para que "6/10" suene bien.
    const out = await send(registry, story.story_id, {
      envelope: envelope({ acceptance_criteria: '6/10' }),
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/denominador/i);
    expect(out.error).toMatch(/declaraste 10/);
    expect(out.error).toMatch(/story tiene 2/);
  });

  it('rechaza verdict passed con cobertura de criterios incompleta', async () => {
    // El caso extremo que pasaba: declarar que cubriste CERO de los criterios y
    // cerrar la story igual. El denominador ya lo ponía el server, pero el
    // numerador no tenía piso ni entraba en la coherencia con el veredicto.
    const { store, taskSystem, registry, story } = await setupReadyForQa();
    for (const ac of ['0/2', '1/2']) {
      const out = await send(registry, story.story_id, {
        envelope: envelope({ acceptance_criteria: ac }),
      });
      expect(out.ok, `debería rechazar passed con ${ac}`).toBe(false);
      expect(out.error, ac).toMatch(/acceptance_criteria/);
      expect(out.error, ac).toMatch(/blocked/);
    }
    // No se escribió nada: la story y el work item quedaron como estaban.
    expect((await store.getStory(story.story_id))?.status).toBe('in_review');
    expect((await taskSystem.getItem(story.external_id, ctx())).status).toBe('Resolved');
  });

  it('acepta verdict passed sólo con la cobertura completa', async () => {
    const { store, registry, story } = await setupReadyForQa();
    const out = await send(registry, story.story_id, {
      envelope: envelope({ acceptance_criteria: '2/2' }),
    });
    expect(out.ok, out.error).toBe(true);
    const stored = await store.getStory(story.story_id);
    expect(stored?.qa_envelope?.acceptance_criteria).toEqual({ covered: 2, total: 2 });
  });

  it('acepta una cobertura parcial en un blocked: ahí no cubrir todo es lo esperable', async () => {
    // La asimetría es el punto: un `blocked` se manda justamente porque la
    // verificación no llegó hasta el final, así que exigirle cobertura completa
    // dejaría sin forma de reportar el bloqueo.
    const { store, registry, story } = await setupReadyForQa();
    const out = await send(registry, story.story_id, {
      results: allButOne(),
      verdict: 'blocked',
      block_reason: 'el copy del error no coincide',
      envelope: failedEnvelope({ acceptance_criteria: '1/2' }),
    });
    expect(out.ok, out.error).toBe(true);
    const stored = await store.getStory(story.story_id);
    expect(stored?.status).toBe('blocked');
    expect(stored?.qa_envelope?.acceptance_criteria).toEqual({ covered: 1, total: 2 });
  });

  it('rechaza relleno en los campos de texto libre del envelope', async () => {
    const { registry, story } = await setupReadyForQa();
    for (const command of ['n/a', 'N/A', 'TODO', 'tbd', 'none', '  ---  ', '???']) {
      const out = await send(registry, story.story_id, {
        envelope: envelope({ test_command: command }),
      });
      expect(out.ok, `debería rechazar test_command=${JSON.stringify(command)}`).toBe(false);
      expect(out.error, command).toMatch(/test_command/);
    }
  });

  it('no confunde un comando real que contiene una palabra de relleno', async () => {
    const { registry, story } = await setupReadyForQa();
    const out = await send(registry, story.story_id, {
      envelope: envelope({ test_command: 'pnpm test -- --grep "todo list"' }),
    });
    expect(out.ok).toBe(true);
  });

  it('rechaza un test_output_hash que no tiene la forma sha256:<64 hex>', async () => {
    const { registry, story } = await setupReadyForQa();
    for (const bad of ['deadbeef', 'sha256:zz', 'sha1:' + 'a'.repeat(40), 'n/a']) {
      const out = await send(registry, story.story_id, {
        envelope: envelope({ test_output_hash: bad }),
      });
      expect(out.ok, `debería rechazar ${bad}`).toBe(false);
      expect(out.error, bad).toMatch(/test_output_hash/);
    }
  });

  it('junta todos los problemas del envelope en un solo mensaje', async () => {
    const { registry, story } = await setupReadyForQa();
    const out = await send(registry, story.story_id, {
      envelope: {
        schema: 'otra-cosa/v9',
        test_command: 'n/a',
        test_exit_code: 7,
        test_output_hash: 'nope',
        acceptance_criteria: '3/99',
      },
    });
    expect(out.ok).toBe(false);
    // Cinco problemas, uno por campo: si fueran round-trips serían cinco llamadas.
    expect(out.error).toMatch(/5 problema/);
    expect(out.error).toMatch(/schema/);
    expect(out.error).toMatch(/test_command/);
    expect(out.error).toMatch(/test_output_hash/);
    expect(out.error).toMatch(/denominador/);
    expect(out.error).toMatch(/test_exit_code=7/);
  });

  it('una admisión fallida no toca la story, ni el work item, ni el log', async () => {
    const { store, taskSystem, registry, story } = await setupReadyForQa();

    // Ronda 1: un blocked VÁLIDO. Deja resultado y evidencia persistidos.
    const blocked = (await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: allButOne(),
        envelope: failedEnvelope(),
        verdict: 'blocked',
        block_reason: 'AC-2 muestra el copy equivocado',
      },
      qaCtx(),
    )) as { ok: boolean };
    expect(blocked.ok).toBe(true);
    const round1 = await store.getStory(story.story_id);
    expect(round1?.qa_results).toHaveLength(4);

    // El dev "arregla" y vuelve a in_review.
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_progress' },
      ctx(),
    );
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://example.com/pr/2' },
      ctx(),
    );
    await registry.get('generate_qa_plan')!.handler({ story_id: story.story_id }, qaCtx());

    const antes = await store.getStory(story.story_id);
    const eventosAntes = (await store.listEvents(story.flow_id)).length;
    const itemAntes = (await taskSystem.getItem(story.external_id, ctx())).status;

    // Ronda 2: envelope inválido. Un agente que no puede producir un resultado
    // válido tampoco debería poder pisar el resultado válido anterior.
    const out = await send(registry, story.story_id, {
      envelope: envelope({ test_output_hash: 'no-es-un-hash' }),
    });
    expect(out.ok).toBe(false);

    const despues = await store.getStory(story.story_id);
    expect(despues?.status).toBe(antes?.status);
    expect(despues?.qa_verdict).toBe(antes?.qa_verdict);
    expect(despues?.qa_block_reason).toBe(antes?.qa_block_reason);
    // La evidencia de la ronda 1 sigue intacta: no la pisó.
    expect(despues?.qa_results).toEqual(antes?.qa_results);
    expect(despues?.qa_envelope).toEqual(antes?.qa_envelope);
    expect((await taskSystem.getItem(story.external_id, ctx())).status).toBe(itemAntes);
    expect((await store.listEvents(story.flow_id)).length).toBe(eventosAntes);
  });

  it('un blocked válido SÍ se persiste con sus evidencias', async () => {
    const { store, taskSystem, registry, story } = await setupReadyForQa();
    const out = (await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: allButOne(),
        envelope: failedEnvelope(),
        verdict: 'blocked',
        block_reason: 'AC-2 muestra el copy equivocado',
      },
      qaCtx(),
    )) as { ok: boolean };
    expect(out.ok).toBe(true);

    // Validez y readiness son decisiones separadas: el resultado es válido, así
    // que se escribe, aunque la story no avance.
    const stored = await store.getStory(story.story_id);
    expect(stored?.status).toBe('blocked');
    expect(stored?.qa_results?.map((r) => r.case_id)).toEqual([
      'AC-1', 'AC-2', 'EDGE-1', 'EDGE-2',
    ]);
    expect(stored?.qa_results?.find((r) => r.case_id === 'AC-2')).toMatchObject({
      status: 'failed',
      evidence_url: evidence('runs/42'),
      notes: 'copy equivocado',
    });
    expect(stored?.qa_envelope?.test_exit_code).toBe(1);
    expect((await taskSystem.getItem(story.external_id, ctx())).status).toBe('Active');

    const evento = (await store.listEvents(story.flow_id)).find(
      (e) => e.type === 'qa.results.submitted',
    );
    const payload = evento?.payload as {
      results: Array<{ case_id: string; evidence_url?: string }>;
      envelope: { test_exit_code: number };
      block_reason?: string | null;
    };
    expect(payload.results).toHaveLength(4);
    expect(payload.envelope.test_exit_code).toBe(1);
    expect(payload.block_reason).toBe('AC-2 muestra el copy equivocado');
  });

  it('después de un passed los resultados quedan recuperables desde la story y desde el log', async () => {
    const { store, registry, story } = await setupReadyForQa();
    const out = await send(registry, story.story_id, {
      envelope: envelope({ test_output_hash: hash('f') }),
    });
    expect(out.ok).toBe(true);

    // (a) desde la story
    const stored = await store.getStory(story.story_id);
    expect(stored?.qa_results?.map((r) => r.evidence_url)).toEqual([
      evidence('ac-1'), evidence('ac-2'), evidence('edge-1'), evidence('edge-2'),
    ]);
    expect(stored?.qa_envelope).toMatchObject({
      schema: 'sdlc.qa-result/v1',
      test_command: 'pnpm --filter @sdlc/server test',
      test_exit_code: 0,
      test_output_hash: hash('f'),
      acceptance_criteria: { covered: 2, total: 2 },
    });

    // (b) desde el log de eventos — un replay recupera qué evidencia se presentó,
    //     que es lo que antes se tiraba.
    const evento = (await store.listEvents(story.flow_id)).find(
      (e) => e.type === 'qa.results.submitted',
    );
    const payload = evento?.payload as {
      case_count: number;
      failed_count: number;
      results: Array<{ case_id: string; evidence_url?: string }>;
      envelope: { test_output_hash: string; acceptance_criteria: { covered: number; total: number } };
    };
    expect(payload.case_count).toBe(4); // los contadores viejos siguen ahí
    expect(payload.failed_count).toBe(0);
    expect(payload.results.map((r) => r.evidence_url)).toEqual([
      evidence('ac-1'), evidence('ac-2'), evidence('edge-1'), evidence('edge-2'),
    ]);
    expect(payload.envelope.test_output_hash).toBe(hash('f'));
    expect(payload.envelope.acceptance_criteria).toEqual({ covered: 2, total: 2 });
  });

  it('dos corridas que dicen lo mismo con outputs distintos quedan distinguibles', async () => {
    // Lo único que aporta el hash: no verifica nada (el server no corrió los
    // tests), pero deja ver a posteriori que fueron dos corridas y no una.
    const { store, registry, story } = await setupReadyForQa();
    await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: allButOne(),
        envelope: failedEnvelope({ test_output_hash: hash('1') }),
        verdict: 'blocked',
        block_reason: 'rompe AC-2',
      },
      qaCtx(),
    );
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_progress' },
      ctx(),
    );
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://example.com/pr/2' },
      ctx(),
    );
    await registry.get('generate_qa_plan')!.handler({ story_id: story.story_id }, qaCtx());
    await send(registry, story.story_id, { envelope: envelope({ test_output_hash: hash('2') }) });

    const hashes = (await store.listEvents(story.flow_id))
      .filter((e) => e.type === 'qa.results.submitted')
      .map((e) => (e.payload as { envelope: { test_output_hash: string } }).envelope.test_output_hash);
    expect(hashes).toEqual([hash('1'), hash('2')]);
  });

  it('rechaza un bloque de resultados que se pasa del techo del payload, sin recortarlo', async () => {
    const { store, taskSystem, registry, story } = await setupReadyForQa();
    const gordos = allPassed().map((r) => ({ ...r, notes: 'x'.repeat(20_000) }));
    const out = (await registry.get('submit_qa_results')!.handler(
      { story_id: story.story_id, results: gordos, envelope: envelope(), verdict: 'passed' },
      qaCtx(),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/notes/);
    expect(out.error).toMatch(/submit_qa_results/);
    // Se rechaza, no se recorta: nada escrito.
    expect((await store.getStory(story.story_id))?.qa_results).toBeUndefined();
    expect((await taskSystem.getItem(story.external_id, ctx())).status).toBe('Resolved');
  });

  it('el techo mide el payload del evento entero, no sólo results + envelope', async () => {
    // El techo se medía sobre `{results, envelope}`, pero el payload del evento
    // lleva además `block_reason`, que no tenía cota: 2 MB de block_reason
    // entraban al event log y a `story.qa_block_reason` con el techo intacto.
    const { store, taskSystem, registry, story } = await setupReadyForQa();
    const out = (await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: allButOne(),
        envelope: failedEnvelope(),
        verdict: 'blocked',
        block_reason: 'x'.repeat(200_000),
      },
      qaCtx(),
    )) as { ok: boolean; error?: string };

    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/block_reason/);
    expect(out.error).toMatch(/submit_qa_results/);
    // Nada escrito: ni la story ni el log llevan el bloque gigante.
    const stored = await store.getStory(story.story_id);
    expect(stored?.qa_block_reason ?? null).toBeNull();
    expect(stored?.status).toBe('in_review');
    expect((await store.listEvents(story.flow_id)).some((e) => e.type === 'qa.results.submitted')).toBe(
      false,
    );
    expect((await taskSystem.getItem(story.external_id, ctx())).status).toBe('Resolved');
  });
});

describe('block_story', () => {
  async function setupInReview() {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://example.com/pr/1' },
      ctx(),
    );
    return { store, taskSystem, registry, story };
  }

  it('blocks an in_review story without a plan', async () => {
    const { store, taskSystem, registry, story } = await setupInReview();
    const out = (await registry.get('block_story')!.handler(
      { story_id: story.story_id, reason: 'smoke test fails locally' },
      qaCtx(),
    )) as { ok: boolean; data?: { story: { status: string; qa_block_reason?: string } } };
    expect(out.ok).toBe(true);
    expect(out.data?.story.status).toBe('blocked');
    expect(out.data?.story.qa_block_reason).toBe('smoke test fails locally');
    const item = await taskSystem.getItem(story.external_id, ctx());
    expect(item.status).toBe('Active');
    const events = await store.listEvents(story.flow_id);
    expect(events.some((e) => e.type === 'story.blocked')).toBe(true);
  });

  it('rejects empty reason', async () => {
    const { registry, story } = await setupInReview();
    const out = (await registry.get('block_story')!.handler(
      { story_id: story.story_id, reason: '   ' },
      qaCtx(),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/reason/i);
  });

  it('rejects block on a story not in_review', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);
    // still created
    const out = (await registry.get('block_story')!.handler(
      { story_id: story.story_id, reason: 'x' },
      qaCtx(),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/in_review/i);
  });
});

describe('integration: dev↔QA loop', () => {
  it('blocked story can be reworked and finally pass', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { story } = await seedReadyFlow(store, taskSystem);

    // dev claims and opens PR
    await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'alice' },
      ctx(),
    );
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://example.com/pr/1' },
      ctx(),
    );
    await registry.get('generate_qa_plan')!.handler(
      { story_id: story.story_id },
      qaCtx(),
    );

    // QA blocks
    const blocked = (await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: [
          { case_id: 'AC-1', status: 'passed', evidence_url: evidence('ac-1') },
          { case_id: 'AC-2', status: 'failed', evidence_url: evidence('log') },
          { case_id: 'EDGE-1', status: 'passed', evidence_url: evidence('edge-1') },
          { case_id: 'EDGE-2', status: 'passed', evidence_url: evidence('edge-2') },
        ],
        envelope: failedEnvelope(),
        verdict: 'blocked',
        block_reason: 'AC-2 fails',
      },
      qaCtx(),
    )) as { ok: boolean; data?: { story: { status: string } } };
    expect(blocked.data?.story.status).toBe('blocked');

    // dev fixes and reopens
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_progress' },
      ctx(),
    );
    await registry.get('report_progress')!.handler(
      { story_id: story.story_id, status: 'in_review', pr_url: 'https://example.com/pr/2' },
      ctx(),
    );
    // QA regenerates plan and passes
    await registry.get('generate_qa_plan')!.handler(
      { story_id: story.story_id },
      qaCtx(),
    );
    const passed = (await registry.get('submit_qa_results')!.handler(
      {
        story_id: story.story_id,
        results: [
          { case_id: 'AC-1', status: 'passed', evidence_url: evidence('ac-1') },
          { case_id: 'AC-2', status: 'passed', evidence_url: evidence('ac-2') },
          { case_id: 'EDGE-1', status: 'passed', evidence_url: evidence('edge-1') },
          { case_id: 'EDGE-2', status: 'passed', evidence_url: evidence('edge-2') },
        ],
        envelope: envelope({ test_output_hash: hash('c') }),
        verdict: 'passed',
      },
      qaCtx(),
    )) as { ok: boolean; data?: { story: { status: string } } };
    expect(passed.data?.story.status).toBe('qa_passed');

    const item = await taskSystem.getItem(story.external_id, ctx());
    expect(item.status).toBe('Closed');

    const events = await store.listEvents(story.flow_id);
    const types = events.map((e) => e.type);
    expect(types).toContain('story.claimed');
    expect(types.filter((t) => t === 'progress.reported').length).toBeGreaterThanOrEqual(3);
    expect(types.filter((t) => t === 'qa.plan.generated').length).toBe(2);
    expect(types.filter((t) => t === 'qa.results.submitted').length).toBe(2);
  });
});
