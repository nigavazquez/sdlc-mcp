import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { Catalog } from '@sdlc/catalog';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';
import { ConfigBackedTaskSystemProvider } from '../src/adapters/task-system-provider.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import { buildToolRegistry } from '../src/mcp/tools/index.js';
import { testCtx, type TestCtxOptions } from './helpers/tenant-ctx.js';
import { seedFlowStatus } from './helpers/flow-status.js';

// El claim `workspaces` va explícito: las guardas de workspace ya no dejan pasar un ctx sin él.
//
// Los overrides entran *por* `testCtx` en vez de spreadearse encima del ctx ya construido:
// las tools evalúan el rol contra `ctx.workspaces[flow.project]`, así que un override de
// `roles` tiene que rederivar el mapa del claim. Spreadeado por arriba quedaba `ctx.roles`
// nuevo con el mapa viejo y todo se rechazaba por rol.
const ctx = (overrides: Partial<TestCtxOptions> = {}): TenantCtx =>
  testCtx({
    tenantId: 't1',
    userId: 'alice',
    roles: ['developer'],
    workspaces: ['demo'],
    resolveSecret: async () => {
      throw new Error('no secrets');
    },
    ...overrides,
  });

/**
 * Ctx del shaping, para las llamadas a `create_stories`.
 *
 * Va separado del de `alice` (developer) a propósito: `create_stories` copia el
 * `target_repo` de cada story desde el registro de componentes del RFC, y ese dato es
 * contra lo que después se verifica el PR en el code review. Si lo pudiera escribir el
 * mismo developer que abre el PR, el gate sería tautológico. El ctx partido es la forma de
 * que el test refleje esa separación en vez de esconderla.
 */
const shapingCtx = (): TenantCtx => ctx({ userId: 'pat', roles: ['pmo'] });

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

/** Seeds a backlog-ready, multi-component flow with an epic already created. */
async function seedMultiComponentFlow(store: InMemoryFlowStore, taskSystem: InMemoryTaskSystemAdapter) {
  const flow = await store.createFlow({
    tenant_id: 't1',
    project: 'demo',
    slug: 'checkout',
    title: 'Checkout revamp',
  });
  const epicRef = await taskSystem.createEpic(
    { project_key: 'demo', title: 'Checkout', description: 'x' },
    ctx(),
  );
  await seedFlowStatus(store, flow.flow_id, {
    status: 'backlog_ready',
    current_phase: 'shaping',
    epic_external_id: epicRef.external_id,
    architecture_mode: 'hybrid',
    codebase_status: 'existing',
    components: [
      { name: 'checkout-api', kind: 'app', repo: 'https://github.com/acme/checkout' },
      { name: 'checkout-infra', kind: 'infra', repo: 'https://github.com/acme/platform-infra' },
    ],
  });
  return { flow, epicId: epicRef.external_id };
}

describe('create_stories — component assignment', () => {
  it('tags each story with its target repo + component kind', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, epicId } = await seedMultiComponentFlow(store, taskSystem);

    const out = (await registry.get('create_stories')!.handler(
      {
        flow_id: flow.flow_id,
        epic_id: epicId,
        stories: [
          {
            title: 'Add coupon endpoint',
            description: 'app work',
            acceptance_criteria: ['endpoint returns 200'],
            component: 'checkout-api',
          },
          {
            title: 'Provision coupons queue',
            description: 'infra work',
            acceptance_criteria: ['SQS queue exists'],
            component: 'checkout-infra',
          },
        ],
      },
      shapingCtx(),
    )) as { ok: boolean };
    expect(out.ok).toBe(true);

    const stories = await store.listStoriesByFlow(flow.flow_id);
    const api = stories.find((s) => s.component === 'checkout-api');
    const infra = stories.find((s) => s.component === 'checkout-infra');
    expect(api?.target_repo).toBe('https://github.com/acme/checkout');
    expect(api?.component_kind).toBe('app');
    expect(infra?.target_repo).toBe('https://github.com/acme/platform-infra');
    expect(infra?.component_kind).toBe('infra');
  });

  it('rejects a story referencing an unknown component', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, epicId } = await seedMultiComponentFlow(store, taskSystem);

    const out = (await registry.get('create_stories')!.handler(
      {
        flow_id: flow.flow_id,
        epic_id: epicId,
        stories: [
          {
            title: 'Mystery work',
            description: 'x',
            acceptance_criteria: ['y'],
            component: 'does-not-exist',
          },
        ],
      },
      shapingCtx(),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/unknown component "does-not-exist"/);
  });

  it('rejects a story omitting component when the flow declares more than one', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, epicId } = await seedMultiComponentFlow(store, taskSystem);

    const out = (await registry.get('create_stories')!.handler(
      {
        flow_id: flow.flow_id,
        epic_id: epicId,
        stories: [{ title: 'Untagged work', description: 'x', acceptance_criteria: ['y'] }],
      },
      shapingCtx(),
    )) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/must specify "component"/);
    expect(await store.listStoriesByFlow(flow.flow_id)).toHaveLength(0);
  });

  it('defaults to the sole component when a single-component flow omits component', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const flow = await store.createFlow({
      tenant_id: 't1',
      project: 'demo',
      slug: 'solo',
      title: 'Solo repo',
    });
    const epicRef = await taskSystem.createEpic(
      { project_key: 'demo', title: 'Solo', description: 'x' },
      ctx(),
    );
    await seedFlowStatus(store, flow.flow_id, {
      status: 'backlog_ready',
      epic_external_id: epicRef.external_id,
      components: [{ name: 'the-app', kind: 'app', repo: 'https://github.com/acme/solo' }],
    });

    await registry.get('create_stories')!.handler(
      {
        flow_id: flow.flow_id,
        epic_id: epicRef.external_id,
        stories: [{ title: 'Do a thing', description: 'x', acceptance_criteria: ['y'] }],
      },
      shapingCtx(),
    );
    const [story] = await store.listStoriesByFlow(flow.flow_id);
    expect(story?.component).toBe('the-app');
    expect(story?.target_repo).toBe('https://github.com/acme/solo');
  });
});

describe('claim_story — surfaces component + infra skill', () => {
  it('returns target_repo and the terraform skill for an infra story', async () => {
    const { store, taskSystem, registry } = await makeRegistry();
    const { flow, epicId } = await seedMultiComponentFlow(store, taskSystem);
    await registry.get('create_stories')!.handler(
      {
        flow_id: flow.flow_id,
        epic_id: epicId,
        stories: [
          {
            title: 'Provision coupons queue',
            description: 'infra work',
            acceptance_criteria: ['SQS queue exists'],
            component: 'checkout-infra',
          },
        ],
      },
      shapingCtx(),
    );
    const [story] = await store.listStoriesByFlow(flow.flow_id);

    const out = (await registry.get('claim_story')!.handler(
      { story_id: story!.story_id, developer_id: 'alice' },
      ctx(),
    )) as {
      ok: boolean;
      data?: {
        target_repo: string | null;
        component_kind: string | null;
        skills: Array<{ id: string }>;
      };
    };
    expect(out.ok).toBe(true);
    expect(out.data?.target_repo).toBe('https://github.com/acme/platform-infra');
    expect(out.data?.component_kind).toBe('infra');
    expect(out.data?.skills.map((s) => s.id)).toContain('skill-terraform-implementation');
  });
});
