import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Flow } from '@sdlc/core';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { PullRequestAdapter } from '@sdlc/adapters-contracts';
import { Catalog } from '@sdlc/catalog';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';
import { ConfigBackedTaskSystemProvider } from '../src/adapters/task-system-provider.js';
import { type PullRequestProvider } from '../src/adapters/pull-request-provider.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import { buildToolRegistry, type ToolRegistry } from '../src/mcp/tools/index.js';
import { testCtx } from './helpers/tenant-ctx.js';
import { reviewOk } from './helpers/review-envelope.js';

const CATALOG_ROOT = resolve(__dirname, '../../../packages/catalog');

/**
 * Envelope de corrida verde para `submit_qa_results`. `acTotal` es la cantidad de
 * criterios de aceptación de la story: el server verifica el denominador contra
 * `story.acceptance_criteria.length`, así que no es un número libre.
 */
const qaEnvelope = (acTotal: number) => ({
  schema: 'sdlc.qa-result/v1',
  test_command: 'pnpm test',
  test_exit_code: 0,
  test_output_hash: `sha256:${'a'.repeat(64)}`,
  acceptance_criteria: `${acTotal}/${acTotal}`,
});

/**
 * Adapter de PR falso que se comporta como uno real: parsea, y reporta el PR abierto.
 *
 * `_parsed` ya no puede quedar vacío: las tools de review comparan el repo del PR
 * contra el repo declarado de la story leyendo `owner`/`repo` de ahí, igual que
 * hace el adapter real de GitHub para armar el request. Un fake que no los llena
 * no es "permisivo", es un adapter que la guarda no puede verificar — y frente a
 * eso el gate falla cerrado, como debe.
 */
function fakePrAdapter(): PullRequestAdapter {
  return {
    kind: 'github',
    parsePrUrl: (url: string) => {
      const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i.exec(url);
      if (!m) throw new Error(`fakePrAdapter: cannot parse PR URL: ${url}`);
      return { url, pr_id: m[3]!, _parsed: { owner: m[1]!, repo: m[2]!, number: m[3]! } };
    },
    requestReview: async () => {},
    submitOutcome: async () => {},
    getPullRequest: async (ref) => ({
      pr_id: ref.pr_id, url: ref.url, title: 'PR', status: 'open', created_by: 'alice',
    }),
  };
}

// El claim `workspaces` va explícito: las guardas de workspace ya no dejan pasar un ctx sin él.
//
// Los tres ctx se construyen *por* `testCtx`, cada uno con sus roles. Antes `dev` y `qa`
// se armaban spreadeando `{ ...pm(), roles: [...] }`, que es justo el error que el helper
// documenta: el spread pisaba `ctx.roles` pero dejaba el mapa del claim `workspaces`
// derivado de los roles de `pm`, así que `ctx.workspaces.demo` seguía diciendo
// product-manager/tech-lead/pmo. Mientras nadie miraba el rol la incoherencia era
// invisible; con las guardas puestas, `claim_story` rechazaba a `alice` diciendo que sus
// roles en "demo" eran los del PM.
const base = {
  tenantId: 't1',
  workspaces: ['demo'],
  resolveSecret: async () => { throw new Error('no secrets'); },
} as const;
const pm = (): TenantCtx =>
  testCtx({ ...base, userId: 'pam', roles: ['product-manager', 'tech-lead', 'pmo'] });
const dev = (): TenantCtx => testCtx({ ...base, userId: 'alice', roles: ['developer'] });
const qa = (): TenantCtx => testCtx({ ...base, userId: 'quincy', roles: ['qa'] });

// RFC declaring two components in different repos: an app service + a Terraform module.
const MULTI_RFC = `---
architecture_mode: hybrid
codebase_status: existing
components:
  - name: checkout-api
    kind: app
    repo: https://github.com/acme/checkout
  - name: checkout-infra
    kind: infra
    repo: https://github.com/acme/platform-infra
    repo_project: platform
---

# RFC: Cuotas en checkout (multi-repo)

## Context
Implementa el feature del PRD. Toca el servicio de checkout y la infra que lo soporta.

## Architecture context

### Architecture mode
Hybrid: extendemos checkout-api y agregamos recursos nuevos de infraestructura en platform-infra.

### Existing components reused
- packages/checkout/service
- módulo terraform sqs base

### Codebase context
Monorepo TS pnpm + turbo para la app; HCL/Terraform para la infra. Convenciones kebab-case.

### Integration points
- checkout-api consume la cola de cuotas que crea checkout-infra (orden: infra primero).
- Evento checkout.installments.requested.

## Goals
- Cuotas 3/6/12, p99 < 800ms.

## Non-goals
- Refinanciación post-compra.

## Design
Cola SQS dedicada provista por terraform en platform-infra.
checkout-api publica a la cola con cliente idempotente.
Migración online de la tabla installments_plans.

## Risks
Fraude con cuotas: M/H, mitigado con 3DS obligatorio.
Drift de terraform: M/M, mitigado con plan en el PR.
Performance de pagos: L/H, mitigado con circuit breaker.

## Rollout
Feature flag por tribu, 10% → 50% → 100%.

## Rollback
Desactivar feature flag y revertir el PR de checkout-api; la cola queda sin consumidores.
`;

const VALID_PRD = `# PRD: Cuotas en checkout

## Problem
Compradores premium abandonan el checkout con ticket alto por falta de cuotas.

## Users
- Comprador premium recurrente.
- Comprador ocasional.

## Success Metrics
| Métrica | Baseline | Target | Plazo |
|---|---|---|---|
| Conversion premium | 1.8% | 2.5% | 60 días |

## Scope
- Cuotas 3/6/12 sin interés.

## Out of Scope
- Cuotas con interés.

## Risks
| Riesgo | Probabilidad | Impacto | Mitigación |
| Fraude | M | H | 3DS |
`;

async function makeRegistry(): Promise<{
  registry: ToolRegistry;
  store: InMemoryFlowStore;
  resolvedProjects: string[];
}> {
  const catalog = await Catalog.load(CATALOG_ROOT);
  const store = new InMemoryFlowStore();
  const taskSystem = new InMemoryTaskSystemAdapter();
  const taskSystemProvider = new ConfigBackedTaskSystemProvider({
    configStore: new InMemoryIntegrationConfigStore(),
    inMemory: taskSystem,
  });
  // Spy PR provider: records which integration project each resolution used.
  // Devuelve un adapter falso pero "real" (no el no-op): las tools de review
  // rechazan el no-op a propósito, así que un E2E que quiere ejercitar el
  // camino feliz necesita un adapter que responda como uno de verdad.
  const resolvedProjects: string[] = [];
  const pullRequestProvider: PullRequestProvider = {
    resolve: async (_ctx: TenantCtx, flow: Flow, opts?: { project?: string }): Promise<PullRequestAdapter> => {
      resolvedProjects.push(opts?.project ?? flow.project);
      return fakePrAdapter();
    },
  };
  const registry = buildToolRegistry({ catalog, store, taskSystemProvider, pullRequestProvider });
  return { registry, store, resolvedProjects };
}

async function call<T = any>(registry: ToolRegistry, name: string, input: unknown, ctx: TenantCtx): Promise<T> {
  const tool = registry.get(name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  const out = (await tool.handler(input as never, ctx)) as { ok: boolean; error?: string } & T;
  if (!out.ok) throw new Error(`${name} failed: ${out.error}`);
  return out;
}

describe('E2E: multi-repo + Terraform epic from the implementer perspective', () => {
  it('drives start_flow → RFC(components) → epic → stories → claim(infra) → QA → request_code_review per-repo', async () => {
    const { registry, store, resolvedProjects } = await makeRegistry();
    const log = (m: string) => console.log(`  · ${m}`);

    // 1. PM/Tech-lead set up the flow up to a validated multi-component RFC.
    const started = await call(registry, 'start_flow', { project: 'demo', title: 'Cuotas en checkout', initiative_type: 'feature' }, pm());
    const flowId = (started.data as Flow).flow_id;
    log(`start_flow → ${flowId}`);

    await call(registry, 'submit_prd', { flow_id: flowId, prd_markdown: VALID_PRD, repo_path: 'docs/prd.md' }, pm());
    log('submit_prd → prd_ready');

    const rfc = await call(registry, 'submit_rfc', { flow_id: flowId, rfc_markdown: MULTI_RFC, repo_path: 'docs/rfc.md' }, pm());
    expect((rfc.data as { validation: { ok: boolean } }).validation.ok).toBe(true);
    const flowAfterRfc = await store.getFlow(flowId);
    expect(flowAfterRfc?.components?.map((c) => `${c.name}:${c.kind}`)).toEqual([
      'checkout-api:app',
      'checkout-infra:infra',
    ]);
    log(`submit_rfc → components persisted: ${flowAfterRfc?.components?.map((c) => c.name).join(', ')}`);

    await call(registry, 'validate_rfc', { flow_id: flowId, rfc_markdown: MULTI_RFC }, pm());
    log('validate_rfc → ok');

    // 2. PMO breaks the epic into one story per repo/component.
    await call(registry, 'create_epic', { flow_id: flowId, epic: { title: 'Cuotas', description: 'epic' } }, pm());
    const epicId = (await store.getFlow(flowId))!.epic_external_id!;
    log(`create_epic → ${epicId}`);

    await call(registry, 'create_stories', {
      flow_id: flowId,
      epic_id: epicId,
      stories: [
        { title: 'Publicar a la cola de cuotas', description: 'app', acceptance_criteria: ['publica evento'], component: 'checkout-api' },
        { title: 'Provisionar cola SQS de cuotas', description: 'infra', acceptance_criteria: ['cola existe'], component: 'checkout-infra' },
      ],
    }, pm());
    const stories = await store.listStoriesByFlow(flowId);
    const infra = stories.find((s) => s.component === 'checkout-infra')!;
    const app = stories.find((s) => s.component === 'checkout-api')!;
    log(`create_stories → app→${app.target_repo} | infra→${infra.target_repo}`);
    expect(app.target_repo).toBe('https://github.com/acme/checkout');
    expect(infra.target_repo).toBe('https://github.com/acme/platform-infra');

    // 3. Implementer claims the INFRA story → gets the infra repo + terraform skill.
    const claim = await call(registry, 'claim_story', { story_id: infra.story_id, developer_id: 'alice' }, dev());
    const claimData = claim.data as { target_repo: string; component_kind: string; skills: Array<{ id: string }> };
    log(`claim_story(infra) → repo=${claimData.target_repo} kind=${claimData.component_kind} skills=[${claimData.skills.map((s) => s.id).join(', ')}]`);
    expect(claimData.target_repo).toBe('https://github.com/acme/platform-infra');
    expect(claimData.component_kind).toBe('infra');
    expect(claimData.skills.map((s) => s.id)).toContain('skill-terraform-implementation');

    // 4. Implementer opens the PR against the infra repo and moves to review.
    await call(registry, 'report_progress', { story_id: infra.story_id, status: 'in_progress' }, dev());
    await call(registry, 'report_progress', { story_id: infra.story_id, status: 'in_review', pr_url: 'https://github.com/acme/platform-infra/pull/7' }, dev());
    log('report_progress → in_review (PR on infra repo)');

    // 5. QA passes.
    const plan = await call(registry, 'generate_qa_plan', { story_id: infra.story_id }, qa());
    const caseIds = (plan.data as { qa_plan: { cases: Array<{ case_id: string }> } }).qa_plan.cases.map((c) => c.case_id);
    await call(registry, 'submit_qa_results', {
      story_id: infra.story_id,
      // Todo caso reportado necesita evidencia http(s) a un host real (el gate de submit_qa_results).
      results: caseIds.map((id) => ({
        case_id: id,
        status: 'passed',
        evidence_url: `https://ci.acme-corp.dev/runs/${id.toLowerCase()}`,
      })),
      // El envelope de la corrida: sin él la admisión rechaza. El denominador de
      // acceptance_criteria lo verifica el server contra la story (1 criterio acá).
      envelope: qaEnvelope(1),
      verdict: 'passed',
    }, qa());
    log(`QA → qa_passed (cases: ${caseIds.join(', ')})`);

    // 6. Request review → PR provider must resolve for the INFRA component's repo_project ("platform").
    //    Lo pide QA (rol habilitado), no el dev que implementó: separación de funciones.
    await call(registry, 'request_code_review', { story_id: infra.story_id, reviewer_ids: ['rob'] }, qa());
    log(`request_code_review → PR provider resolved with project="${resolvedProjects.at(-1)}"`);
    expect(resolvedProjects.at(-1)).toBe('platform');

    const finalInfra = await store.getStory(infra.story_id);
    expect(finalInfra?.status).toBe('qa_passed');

    // 7. Review outcome must resolve the SAME adapter as the request (repo_project).
    await call(registry, 'submit_review_outcome', { story_id: infra.story_id, outcome: 'approved' , review: reviewOk() }, pm());
    log(`submit_review_outcome → PR provider resolved with project="${resolvedProjects.at(-1)}"`);
    expect(resolvedProjects.at(-1)).toBe('platform');
    expect((await store.getStory(infra.story_id))?.status).toBe('merged');

    // 8. La story de infra está merged, pero la de la app sigue sin tocarse: el
    //    flow NO cierra. Antes, aprobar una sola story dejaba el epic entero en
    //    merged/done con el resto en `created`.
    const flowAfterFirstApproval = await store.getFlow(flowId);
    expect(flowAfterFirstApproval?.current_phase).not.toBe('done');
    expect(flowAfterFirstApproval?.status).not.toBe('merged');
    expect((await store.getStory(app.story_id))?.status).toBe('created');
    log(`primera story aprobada → flow sigue en ${flowAfterFirstApproval?.current_phase} (la story de app está pendiente)`);
    log('E2E OK ✔');
  });
});

// ---------------------------------------------------------------------------
// La cadena del reviewer adversarial
// ---------------------------------------------------------------------------

/** mallory: developer del workspace demo. Es quien implementa y quien intenta el bypass. */
const mallory = (): TenantCtx => testCtx({
  tenantId: 't1', userId: 'mallory', roles: ['developer'], workspaces: ['demo'],
  resolveSecret: async () => { throw new Error('no secrets'); },
});

/** lead: tech-lead del workspace demo. Cierra la QA y firma el review. */
const lead = (): TenantCtx => testCtx({
  tenantId: 't1', userId: 'lead', roles: ['tech-lead'], workspaces: ['demo'],
  resolveSecret: async () => { throw new Error('no secrets'); },
});

/**
 * Deja el flow con tres stories y la primera en `qa_passed`, con el `pr_url`
 * apuntando al repo que le pasen. Es la cadena del reviewer hasta el paso
 * anterior a `submit_review_outcome`, sin pasar nunca por `request_code_review`.
 */
async function drivePreReviewChain(prUrl: string) {
  const { registry, store } = await makeRegistry();

  const started = await call(registry, 'start_flow', { project: 'demo', title: 'Cuotas en checkout', initiative_type: 'feature' }, pm());
  const flowId = (started.data as Flow).flow_id;
  await call(registry, 'submit_prd', { flow_id: flowId, prd_markdown: VALID_PRD, repo_path: 'docs/prd.md' }, pm());
  await call(registry, 'submit_rfc', { flow_id: flowId, rfc_markdown: MULTI_RFC, repo_path: 'docs/rfc.md' }, pm());
  await call(registry, 'create_epic', { flow_id: flowId, epic: { title: 'Cuotas', description: 'epic' } }, pm());
  const epicId = (await store.getFlow(flowId))!.epic_external_id!;

  // Tres stories, como en el reporte: mallory se queda con una y las otras dos
  // nunca se tocan.
  await call(registry, 'create_stories', {
    flow_id: flowId,
    epic_id: epicId,
    stories: [
      { title: 'Publicar a la cola de cuotas', description: 'app', acceptance_criteria: ['publica evento'], component: 'checkout-api' },
      { title: 'Mostrar cuotas en el checkout', description: 'app', acceptance_criteria: ['render de cuotas'], component: 'checkout-api' },
      { title: 'Provisionar cola SQS de cuotas', description: 'infra', acceptance_criteria: ['cola existe'], component: 'checkout-infra' },
    ],
  }, pm());

  const stories = await store.listStoriesByFlow(flowId);
  const target = stories.find((s) => s.title === 'Publicar a la cola de cuotas')!;
  expect(target.target_repo).toBe('https://github.com/acme/checkout');

  // claim → in_progress → in_review con el PR que mallory quiera.
  await call(registry, 'claim_story', { story_id: target.story_id, developer_id: 'mallory' }, mallory());
  await call(registry, 'report_progress', { story_id: target.story_id, status: 'in_progress' }, mallory());
  await call(registry, 'report_progress', { story_id: target.story_id, status: 'in_review', pr_url: prUrl }, mallory());

  // QA la cierra el tech-lead (mallory no puede firmar su propio trabajo).
  const plan = await call(registry, 'generate_qa_plan', { story_id: target.story_id }, lead());
  const caseIds = (plan.data as { qa_plan: { cases: Array<{ case_id: string }> } }).qa_plan.cases.map((c) => c.case_id);
  await call(registry, 'submit_qa_results', {
    story_id: target.story_id,
    results: caseIds.map((id) => ({ case_id: id, status: 'passed', evidence_url: `https://ci.acme-corp.dev/runs/${id.toLowerCase()}` })),
    envelope: qaEnvelope(1),
    verdict: 'passed',
  }, lead());

  return { registry, store, flowId, stories, target };
}

describe('bypass del reviewer adversarial: la cadena completa ya no llega a merged', () => {
  it('claim → report_progress(PR ajeno) → QA passed → submit_review_outcome(approved) queda frenada', async () => {
    // El PR del reporte: el repo personal de mallory, no el declarado por la story.
    const { registry, store, flowId, target } = await drivePreReviewChain('https://github.com/mallory/scratch/pull/1');

    // El último eslabón de la cadena. Antes devolvía ok:true.
    const out = (await registry.get('submit_review_outcome')!.handler(
      { story_id: target.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      lead(),
    )) as { ok: boolean; error?: string };

    expect(out.ok).toBe(false);
    // Frena en el primer eslabón que falta: nunca se pidió el review de esta story.
    expect(out.error).toMatch(/review\.requested/);
    expect(out.error).toMatch(/request_code_review/);

    // Y nada del estado que reportó el reviewer se materializa.
    const flow = await store.getFlow(flowId);
    expect(flow?.status).not.toBe('merged');
    expect(flow?.current_phase).not.toBe('done');
    expect((await store.getStory(target.story_id))?.status).toBe('qa_passed');

    const events = await store.listEvents(flowId);
    expect(events.some((e) => e.type === 'review.outcome.submitted')).toBe(false);
  });

  it('aun pidiendo el review, el PR del repo de mallory se rechaza en las dos mitades', async () => {
    const { registry, store, flowId, target } = await drivePreReviewChain('https://github.com/mallory/scratch/pull/1');

    // Segundo eslabón: pedir el review sobre un PR de otro repo tampoco pasa, así
    // que el atacante no puede fabricarse el `review.requested` que le falta.
    const requested = (await registry.get('request_code_review')!.handler(
      { story_id: target.story_id, reviewer_ids: ['rob'] },
      lead(),
    )) as { ok: boolean; error?: string };

    expect(requested.ok).toBe(false);
    expect(requested.error).toMatch(/mallory\/scratch/);
    expect(requested.error).toMatch(/acme\/checkout/);
    const events = await store.listEvents(flowId);
    expect(events.some((e) => e.type === 'review.requested')).toBe(false);

    // Y si el evento existiera igual (p.ej. sembrado de otra vuelta), la firma
    // sigue frenando por el repo antes de postear el APPROVE. El evento se siembra
    // con el `pr_url` actual a propósito: sin él frenaría antes, en el chequeo de
    // que el review haya sido pedido para *este* PR, y este test dejaría de
    // ejercitar la guarda del repo que dice estar probando.
    await store.appendEvent({
      flow_id: flowId, type: 'review.requested', actor: 'lead',
      payload: {
        story_id: target.story_id, reviewer_ids: ['rob'],
        pr_url: (await store.getStory(target.story_id))?.pr_url,
      },
    });
    const signed = (await registry.get('submit_review_outcome')!.handler(
      { story_id: target.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() },
      lead(),
    )) as { ok: boolean; error?: string };

    expect(signed.ok).toBe(false);
    expect(signed.error).toMatch(/mallory\/scratch/);
    expect(signed.error).toMatch(/report_progress/);
    expect((await store.getStory(target.story_id))?.status).toBe('qa_passed');
  });

  it('con el PR en el repo correcto la cadena avanza, pero el flow no cierra con 2 stories pendientes', async () => {
    // Contraprueba: las guardas nuevas no rompen el camino legítimo.
    const { registry, store, flowId, target } = await drivePreReviewChain('https://github.com/acme/checkout/pull/1');

    await call(registry, 'request_code_review', { story_id: target.story_id, reviewer_ids: ['rob'] }, lead());
    const out = await call(registry, 'submit_review_outcome', { story_id: target.story_id, outcome: 'approved', comment: 'LGTM' , review: reviewOk() }, lead());

    expect((out.data as { story: { status: string } }).story.status).toBe('merged');
    const flow = await store.getFlow(flowId);
    expect(flow?.current_phase).not.toBe('done');
    expect(flow?.status).not.toBe('merged');
    const pendientes = (await store.listStoriesByFlow(flowId)).filter((s) => s.status !== 'merged');
    expect(pendientes).toHaveLength(2);
  });
});

describe('submit_rfc — component registry lifecycle', () => {
  it('does not overwrite the registry when the resubmitted RFC fails validation', async () => {
    const { registry, store } = await makeRegistry();
    const started = await call(registry, 'start_flow', { project: 'demo', title: 'Cuotas', initiative_type: 'feature' }, pm());
    const flowId = (started.data as Flow).flow_id;
    await call(registry, 'submit_prd', { flow_id: flowId, prd_markdown: VALID_PRD, repo_path: 'docs/prd.md' }, pm());
    await call(registry, 'submit_rfc', { flow_id: flowId, rfc_markdown: MULTI_RFC, repo_path: 'docs/rfc.md' }, pm());
    expect((await store.getFlow(flowId))?.components).toHaveLength(2);

    // Broken resubmission: one component has an invalid kind → validation fails.
    const broken = MULTI_RFC.replace('kind: infra', 'kind: database');
    const out = (await registry.get('submit_rfc')!.handler(
      { flow_id: flowId, rfc_markdown: broken, repo_path: 'docs/rfc.md' },
      pm(),
    )) as { ok: boolean };
    expect(out.ok).toBe(false);
    expect((await store.getFlow(flowId))?.components).toHaveLength(2);
  });

  it('clears a stale registry when a valid resubmission drops the components block', async () => {
    const { registry, store } = await makeRegistry();
    const started = await call(registry, 'start_flow', { project: 'demo', title: 'Cuotas', initiative_type: 'feature' }, pm());
    const flowId = (started.data as Flow).flow_id;
    await call(registry, 'submit_prd', { flow_id: flowId, prd_markdown: VALID_PRD, repo_path: 'docs/prd.md' }, pm());
    await call(registry, 'submit_rfc', { flow_id: flowId, rfc_markdown: MULTI_RFC, repo_path: 'docs/rfc.md' }, pm());
    expect((await store.getFlow(flowId))?.components).toHaveLength(2);

    // Pivot to a greenfield single-repo epic: no components, no existing_repo.
    const greenfield = MULTI_RFC.replace(
      /^---[\s\S]*?---/,
      '---\narchitecture_mode: new\ncodebase_status: greenfield\n---',
    );
    await call(registry, 'submit_rfc', { flow_id: flowId, rfc_markdown: greenfield, repo_path: 'docs/rfc.md' }, pm());
    expect((await store.getFlow(flowId))?.components).toEqual([]);
  });
});
