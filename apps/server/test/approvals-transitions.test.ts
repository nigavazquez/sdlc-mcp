import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { Flow } from '@sdlc/core';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';
import type { DocStoreProvider } from '../src/adapters/doc-store-provider.js';
import type { TaskSystemProvider } from '../src/adapters/task-system-provider.js';
import { makeSubmitPrdTool } from '../src/mcp/tools/submit-prd.js';
import { makeSubmitRfcTool } from '../src/mcp/tools/submit-rfc.js';
import { makeCreateEpicTool } from '../src/mcp/tools/create-epic.js';
import { makeCreateStoriesTool } from '../src/mcp/tools/create-stories.js';
import { APPROVALS_OFF, approvalPolicyFrom, parseApprovalsRequired } from '../src/approvals/policy.js';
import { testCtx } from './helpers/tenant-ctx.js';
import { seedFlowStatus } from './helpers/flow-status.js';

/**
 * Historia A2 (#67): las transiciones del flow exigen la aprobación vigente del
 * paso anterior cuando el workspace está en `APPROVALS_REQUIRED`. Seam: las tools
 * MCP (`submit_prd`, `submit_rfc`, `create_epic`, `create_stories`) con un store en
 * memoria, un doc store que registra lo que publica y un sistema de tareas espiado.
 * Las aprobaciones se siembran con `store.recordApproval`: la página que las
 * registra de verdad es la historia A4.
 */

const ctx: TenantCtx = testCtx({
  tenantId: 't1',
  userId: 'autor@example.com',
  roles: ['product-manager', 'tech-lead', 'pmo'],
  workspaces: ['p1'],
  resolveSecret: async () => {
    throw new Error('not used');
  },
});

// Fixtures válidos, los mismos que usa submit-gates.test.ts.
const gates = readFileSync(resolve(__dirname, 'submit-gates.test.ts'), 'utf8');
const fixture = (name: string): string => {
  const m = gates.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`));
  if (!m) throw new Error(`fixture ${name} no encontrado`);
  return m[1]!;
};
const PRD = fixture('VALID_PRD');
const PRD_V2 = PRD.replace('Pago en cuotas', 'Pago en cuotas v2');
const RFC = fixture('VALID_RFC');
const RFC_V2 = RFC.replace('# RFC: Test RFC', '# RFC: Test RFC v2');

function setup(policy = approvalPolicyFrom(['p1'])) {
  const store = new InMemoryFlowStore();
  const published: { doc_kind: string; title: string }[] = [];
  const docs: DocStoreProvider = {
    resolve: async () => ({
      publish: async (doc: { doc_kind: string; title: string }) => {
        published.push({ doc_kind: doc.doc_kind, title: doc.title });
        return { id: `doc-${published.length}`, url: `https://docs.example.com/${published.length}` };
      },
      fetch: async () => {
        throw new Error('not used');
      },
    }) as never,
  };
  const tasks = new InMemoryTaskSystemAdapter();
  const createEpic = vi.spyOn(tasks, 'createEpic');
  const createStory = vi.spyOn(tasks, 'createStory');
  const taskProvider: TaskSystemProvider = { resolve: async () => tasks } as unknown as TaskSystemProvider;
  return {
    store,
    published,
    createEpic,
    createStory,
    submitPrd: makeSubmitPrdTool(store, docs, undefined, policy),
    submitRfc: makeSubmitRfcTool(store, docs, undefined, policy),
    createEpicTool: makeCreateEpicTool(store, taskProvider, policy),
    createStoriesTool: makeCreateStoriesTool(store, taskProvider, policy),
  };
}

type Setup = ReturnType<typeof setup>;
type R = { ok: boolean; error?: string; data?: { flow: Flow } };

async function newFlow(s: Setup, slug = 'aprob'): Promise<Flow> {
  return s.store.createFlow({ tenant_id: 't1', project: 'p1', slug, title: `Flow ${slug}` });
}

async function approve(s: Setup, flowId: string, artifact: 'prd' | 'rfc') {
  const f = (await s.store.getFlow(flowId))!;
  const sha = artifact === 'prd' ? f.prd_ref!.sha256! : f.rfc_ref!.sha256!;
  await s.store.recordApproval({
    tenant_id: 't1', flow_id: flowId, artifact, sha256: sha,
    approved_by: 'aprobador@example.com', approver_roles: ['product-manager', 'tech-lead'], self_signed: false,
  });
  // Lo que hace la página de aprobación (A4): avanzar el flow.
  await seedFlowStatus(
    s.store,
    flowId,
    artifact === 'prd' ? { status: 'prd_ready', current_phase: 'rfc' } : { status: 'rfc_ready', current_phase: 'shaping' },
  );
}

const STORIES = [{ title: 'Una', description: 'd', acceptance_criteria: ['se ve el resultado'] }];

describe('APPROVALS_REQUIRED', () => {
  it('se parsea como lista separada por comas; * prende todos; vacío no prende ninguno', () => {
    expect(parseApprovalsRequired(' p1, p2 ,,')).toEqual(['p1', 'p2']);
    expect(approvalPolicyFrom(parseApprovalsRequired('p1,p2')).required('p2')).toBe(true);
    expect(approvalPolicyFrom(parseApprovalsRequired('p1')).required('otro')).toBe(false);
    expect(approvalPolicyFrom(['*']).required('cualquiera')).toBe(true);
    expect(approvalPolicyFrom(parseApprovalsRequired(undefined)).required('p1')).toBe(false);
  });
});

describe('con aprobación exigida', () => {
  let s: Setup;
  beforeEach(() => {
    s = setup();
  });

  it('GIVEN el workspace exigido WHEN submit_prd valida THEN publica el PRD y el flow queda en prd_in_review', async () => {
    const flow = await newFlow(s);
    const r = (await s.submitPrd.handler({ flow_id: flow.flow_id, prd_markdown: PRD }, ctx)) as R;
    expect(r.ok).toBe(true);
    expect(r.data?.flow.status).toBe('prd_in_review');
    expect(r.data?.flow.current_phase).toBe('prd');
    expect(s.published).toEqual([{ doc_kind: 'prd', title: `PRD: ${flow.title}` }]);
  });

  it('GIVEN un PRD sin aprobación WHEN submit_rfc THEN se rechaza diciendo que aprueba product-manager, sin publicar', async () => {
    const flow = await newFlow(s);
    await s.submitPrd.handler({ flow_id: flow.flow_id, prd_markdown: PRD }, ctx);
    const r = (await s.submitRfc.handler({ flow_id: flow.flow_id, rfc_markdown: RFC, repo_path: 'docs/rfc/x.md' }, ctx)) as R;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/product-manager/);
    expect(s.published.map((p) => p.doc_kind)).toEqual(['prd']);
    expect((await s.store.getFlow(flow.flow_id))?.rfc_ref).toBeUndefined();
  });

  it('un flow viejo en prd_ready sin aprobación tampoco pasa a RFC', async () => {
    const flow = await newFlow(s);
    await s.store.updateFlow(flow.flow_id, { prd_ref: { sha256: 'a'.repeat(64) } });
    await seedFlowStatus(s.store, flow.flow_id, { status: 'prd_ready', current_phase: 'rfc' });
    const r = (await s.submitRfc.handler({ flow_id: flow.flow_id, rfc_markdown: RFC, repo_path: 'docs/rfc/x.md' }, ctx)) as R;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/aprobación vigente/);
  });

  it('con el PRD aprobado, submit_rfc deja el RFC en rfc_in_review', async () => {
    const flow = await newFlow(s);
    await s.submitPrd.handler({ flow_id: flow.flow_id, prd_markdown: PRD }, ctx);
    await approve(s, flow.flow_id, 'prd');
    const r = (await s.submitRfc.handler({ flow_id: flow.flow_id, rfc_markdown: RFC, repo_path: 'docs/rfc/x.md' }, ctx)) as R;
    expect(r.ok, r.error).toBe(true);
    expect(r.data?.flow.status).toBe('rfc_in_review');
    expect(r.data?.flow.current_phase).toBe('rfc');
  });

  it('GIVEN un RFC sin aprobación vigente WHEN create_epic o create_stories THEN se rechaza sin tocar el sistema de tareas', async () => {
    const flow = await newFlow(s);
    await s.submitPrd.handler({ flow_id: flow.flow_id, prd_markdown: PRD }, ctx);
    await approve(s, flow.flow_id, 'prd');
    await s.submitRfc.handler({ flow_id: flow.flow_id, rfc_markdown: RFC, repo_path: 'docs/rfc/x.md' }, ctx);
    // Flow en rfc_ready sin aprobación del RFC (como los flows de antes de la exigencia).
    await seedFlowStatus(s.store, flow.flow_id, { status: 'rfc_ready', current_phase: 'shaping' });

    const e = (await s.createEpicTool.handler({ flow_id: flow.flow_id, epic: { title: 'E', description: 'd' } }, ctx)) as R;
    expect(e.ok).toBe(false);
    expect(e.error).toMatch(/tech-lead/);

    // La épica pudo haberse creado antes de prender la exigencia.
    await s.store.updateFlow(flow.flow_id, { epic_external_id: 'EPIC-1' });
    const st = (await s.createStoriesTool.handler({ flow_id: flow.flow_id, epic_id: 'EPIC-1', stories: STORIES }, ctx)) as R;
    expect(st.ok).toBe(false);
    expect(st.error).toMatch(/tech-lead/);

    expect(s.createEpic).not.toHaveBeenCalled();
    expect(s.createStory).not.toHaveBeenCalled();
  });

  it('con el RFC aprobado, create_epic y create_stories funcionan', async () => {
    const flow = await newFlow(s);
    await s.submitPrd.handler({ flow_id: flow.flow_id, prd_markdown: PRD }, ctx);
    await approve(s, flow.flow_id, 'prd');
    await s.submitRfc.handler({ flow_id: flow.flow_id, rfc_markdown: RFC, repo_path: 'docs/rfc/x.md' }, ctx);
    await approve(s, flow.flow_id, 'rfc');

    const e = (await s.createEpicTool.handler({ flow_id: flow.flow_id, epic: { title: 'E', description: 'd' } }, ctx)) as {
      ok: boolean; error?: string; data?: { epic_ref: { external_id: string } };
    };
    expect(e.ok, e.error).toBe(true);
    const st = (await s.createStoriesTool.handler(
      { flow_id: flow.flow_id, epic_id: e.data!.epic_ref.external_id, stories: STORIES },
      ctx,
    )) as R;
    expect(st.ok, st.error).toBe(true);
    expect(s.createStory).toHaveBeenCalledTimes(1);
  });

  it('GIVEN un PRD aprobado WHEN se reenvía con otro contenido THEN invalida PRD y RFC con approval.invalidated y vuelve a revisión', async () => {
    const flow = await newFlow(s);
    await s.submitPrd.handler({ flow_id: flow.flow_id, prd_markdown: PRD }, ctx);
    await approve(s, flow.flow_id, 'prd');
    await s.submitRfc.handler({ flow_id: flow.flow_id, rfc_markdown: RFC, repo_path: 'docs/rfc/x.md' }, ctx);
    await approve(s, flow.flow_id, 'rfc');

    const r = (await s.submitPrd.handler({ flow_id: flow.flow_id, prd_markdown: PRD_V2 }, ctx)) as R;
    expect(r.ok, r.error).toBe(true);
    expect(r.data?.flow.status).toBe('prd_in_review');

    const invalidadas = (await s.store.listEvents(flow.flow_id)).filter((ev) => ev.type === 'approval.invalidated');
    expect(invalidadas.map((ev) => [ev.payload.artifact, ev.payload.reason])).toEqual([
      ['prd', 'content_changed'],
      ['rfc', 'upstream_resubmitted'],
    ]);
    expect((await s.store.listApprovals(flow.flow_id)).every((a) => a.invalidated_at !== undefined)).toBe(true);
  });

  it('reenviar el mismo PRD ya aprobado no lo devuelve a revisión ni invalida nada', async () => {
    const flow = await newFlow(s);
    await s.submitPrd.handler({ flow_id: flow.flow_id, prd_markdown: PRD }, ctx);
    await approve(s, flow.flow_id, 'prd');
    const r = (await s.submitPrd.handler({ flow_id: flow.flow_id, prd_markdown: PRD }, ctx)) as R;
    expect(r.data?.flow.status).toBe('prd_ready');
    expect((await s.store.listEvents(flow.flow_id)).some((ev) => ev.type === 'approval.invalidated')).toBe(false);
  });

  it('reenviar el RFC con otro contenido invalida su aprobación y vuelve a rfc_in_review', async () => {
    const flow = await newFlow(s);
    await s.submitPrd.handler({ flow_id: flow.flow_id, prd_markdown: PRD }, ctx);
    await approve(s, flow.flow_id, 'prd');
    await s.submitRfc.handler({ flow_id: flow.flow_id, rfc_markdown: RFC, repo_path: 'docs/rfc/x.md' }, ctx);
    await approve(s, flow.flow_id, 'rfc');
    const r = (await s.submitRfc.handler({ flow_id: flow.flow_id, rfc_markdown: RFC_V2, repo_path: 'docs/rfc/x.md' }, ctx)) as R;
    expect(r.ok, r.error).toBe(true);
    expect(r.data?.flow.status).toBe('rfc_in_review');
    const inv = (await s.store.listEvents(flow.flow_id)).filter((ev) => ev.type === 'approval.invalidated');
    expect(inv.map((ev) => ev.payload.artifact)).toEqual(['rfc']);
  });

  it('con épica creada, reenviar el PRD o el RFC se rechaza sin publicar', async () => {
    const flow = await newFlow(s);
    await s.submitPrd.handler({ flow_id: flow.flow_id, prd_markdown: PRD }, ctx);
    await approve(s, flow.flow_id, 'prd');
    await s.submitRfc.handler({ flow_id: flow.flow_id, rfc_markdown: RFC, repo_path: 'docs/rfc/x.md' }, ctx);
    await approve(s, flow.flow_id, 'rfc');
    await s.createEpicTool.handler({ flow_id: flow.flow_id, epic: { title: 'E', description: 'd' } }, ctx);
    const antes = s.published.length;

    const p = (await s.submitPrd.handler({ flow_id: flow.flow_id, prd_markdown: PRD_V2 }, ctx)) as R;
    expect(p.ok).toBe(false);
    expect(p.error).toMatch(/épica/);
    const q = (await s.submitRfc.handler({ flow_id: flow.flow_id, rfc_markdown: RFC_V2, repo_path: 'docs/rfc/x.md' }, ctx)) as R;
    expect(q.ok).toBe(false);
    expect(q.error).toMatch(/épica/);
    expect(s.published.length).toBe(antes);
    expect((await s.store.listApprovals(flow.flow_id)).every((a) => a.invalidated_at === undefined)).toBe(true);
  });

  it('un workspace que no está en la lista sigue como hoy', async () => {
    const other = setup(approvalPolicyFrom(['otro-ws']));
    const flow = await newFlow(other);
    const r = (await other.submitPrd.handler({ flow_id: flow.flow_id, prd_markdown: PRD }, ctx)) as R;
    expect(r.data?.flow.status).toBe('prd_ready');
  });
});

describe('GIVEN APPROVALS_REQUIRED vacío', () => {
  it('WHEN se envían PRD y RFC THEN el flow avanza como hoy, sin aprobaciones', async () => {
    const s = setup(APPROVALS_OFF);
    const flow = await newFlow(s);
    const p = (await s.submitPrd.handler({ flow_id: flow.flow_id, prd_markdown: PRD }, ctx)) as R;
    expect(p.data?.flow.status).toBe('prd_ready');
    expect(p.data?.flow.current_phase).toBe('rfc');
    const r = (await s.submitRfc.handler({ flow_id: flow.flow_id, rfc_markdown: RFC, repo_path: 'docs/rfc/x.md' }, ctx)) as R;
    expect(r.ok, r.error).toBe(true);
    expect(r.data?.flow.status).toBe('rfc_ready');
    expect(r.data?.flow.current_phase).toBe('shaping');
    const e = (await s.createEpicTool.handler({ flow_id: flow.flow_id, epic: { title: 'E', description: 'd' } }, ctx)) as R;
    expect(e.ok, e.error).toBe(true);
  });
});
