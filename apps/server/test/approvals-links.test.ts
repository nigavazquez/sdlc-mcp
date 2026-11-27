import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { Flow } from '@sdlc/core';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { NoOpDocStoreAdapter, type DocStoreProvider } from '../src/adapters/doc-store-provider.js';
import { makeSubmitPrdTool } from '../src/mcp/tools/submit-prd.js';
import { makeSubmitRfcTool } from '../src/mcp/tools/submit-rfc.js';
import { makeRequestApprovalTool } from '../src/mcp/tools/request-approval.js';
import { makeGetFlowStateTool } from '../src/mcp/tools/get-flow-state.js';
import { approvalPolicyFrom } from '../src/approvals/policy.js';
import { APPROVAL_LINK_TTL_MS, hashApprovalToken } from '../src/approvals/links.js';
import { testCtx } from './helpers/tenant-ctx.js';
import { seedFlowStatus } from './helpers/flow-status.js';

/**
 * Historia A3 (#68): links de aprobación, `request_approval` y las aprobaciones en
 * `get_flow_state`. Seam: las tools MCP con un store en memoria.
 */

const ctx: TenantCtx = testCtx({
  tenantId: 't1',
  userId: 'autor@example.com',
  roles: ['product-manager', 'tech-lead'],
  workspaces: ['p1'],
  resolveSecret: async () => {
    throw new Error('not used');
  },
});
const devCtx: TenantCtx = testCtx({
  tenantId: 't1', userId: 'dev@example.com', roles: ['developer'], workspaces: ['p1'],
  resolveSecret: async () => { throw new Error('not used'); },
});

const gates = readFileSync(resolve(__dirname, 'submit-gates.test.ts'), 'utf8');
const fixture = (name: string) => gates.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`))![1]!;
const PRD = fixture('VALID_PRD');
const RFC = fixture('VALID_RFC');

const policy = approvalPolicyFrom(['p1'], { publicUrl: 'https://sdlc.example.com/' });
const docs: DocStoreProvider = { resolve: async () => new NoOpDocStoreAdapter() };

type Approval = { status: string; artifact: string; url: string; owner_role: string; expires_at: string };
type R = { ok: boolean; error?: string; data?: { flow: Flow; approval?: Approval } };

function tokenOf(url: string): string {
  const m = url.match(/^https:\/\/sdlc\.example\.com\/approve\/([A-Za-z0-9_-]{43})$/);
  if (!m) throw new Error(`url inesperada: ${url}`);
  return m[1]!;
}

describe('links de aprobación', () => {
  let store: InMemoryFlowStore;
  let flow: Flow;
  const submitPrd = () => makeSubmitPrdTool(store, docs, undefined, policy);
  const submitRfc = () => makeSubmitRfcTool(store, docs, undefined, policy);
  const requestApproval = () => makeRequestApprovalTool(store, policy);
  const getState = () => makeGetFlowStateTool(store, undefined, policy);

  beforeEach(async () => {
    store = new InMemoryFlowStore();
    flow = await store.createFlow({ tenant_id: 't1', project: 'p1', slug: 'links', title: 'Links' });
  });

  it('submit_prd devuelve approval.url, owner_role y expires_at, y la base guarda sólo el hash del token', async () => {
    const antes = Date.now();
    const r = (await submitPrd().handler({ flow_id: flow.flow_id, prd_markdown: PRD }, ctx)) as R;
    expect(r.ok, r.error).toBe(true);
    const a = r.data!.approval!;
    expect(a).toMatchObject({ status: 'pending', artifact: 'prd', owner_role: 'product-manager' });
    const token = tokenOf(a.url);
    const vence = Date.parse(a.expires_at) - antes;
    expect(vence).toBeGreaterThanOrEqual(APPROVAL_LINK_TTL_MS - 5_000);
    expect(vence).toBeLessThanOrEqual(APPROVAL_LINK_TTL_MS + 5_000);

    // Lo guardado: el hash, atado al sha256 del PRD; el token no aparece en ningún lado.
    const req = await store.getApprovalRequest(hashApprovalToken(token));
    expect(req).toMatchObject({ artifact: 'prd', sha256: r.data!.flow.prd_ref!.sha256, requested_by: 'autor@example.com' });
    expect(await store.getApprovalRequest(token)).toBeUndefined();
    const eventos = JSON.stringify(await store.listEvents(flow.flow_id));
    expect(eventos).not.toContain(token);
    expect(eventos).toContain('approval.requested');
  });

  it('submit_rfc devuelve el link con owner_role tech-lead', async () => {
    await submitPrd().handler({ flow_id: flow.flow_id, prd_markdown: PRD }, ctx);
    const f = (await store.getFlow(flow.flow_id))!;
    await store.recordApproval({
      tenant_id: 't1', flow_id: flow.flow_id, artifact: 'prd', sha256: f.prd_ref!.sha256!,
      approved_by: 'pm@example.com', approver_roles: ['product-manager'], self_signed: false,
    });
    await seedFlowStatus(store, flow.flow_id, { status: 'prd_ready', current_phase: 'rfc' });
    const r = (await submitRfc().handler({ flow_id: flow.flow_id, rfc_markdown: RFC, repo_path: 'docs/rfc/x.md' }, ctx)) as R;
    expect(r.ok, r.error).toBe(true);
    expect(r.data!.approval).toMatchObject({ artifact: 'rfc', owner_role: 'tech-lead' });
    tokenOf(r.data!.approval!.url);
  });

  it('cada link es distinto aunque sea de la misma versión', async () => {
    const r = (await submitPrd().handler({ flow_id: flow.flow_id, prd_markdown: PRD }, ctx)) as R;
    const otro = (await requestApproval().handler({ flow_id: flow.flow_id, artifact: 'prd' }, devCtx)) as {
      ok: boolean; error?: string; data?: { approval: Approval };
    };
    expect(otro.ok, otro.error).toBe(true);
    expect(otro.data!.approval.url).not.toBe(r.data!.approval!.url);
  });

  it('request_approval genera un link nuevo para el sha256 vigente y no registra ninguna aprobación', async () => {
    const r = (await submitPrd().handler({ flow_id: flow.flow_id, prd_markdown: PRD }, ctx)) as R;
    const sha = r.data!.flow.prd_ref!.sha256!;
    const res = (await requestApproval().handler({ flow_id: flow.flow_id, artifact: 'prd' }, devCtx)) as {
      ok: boolean; error?: string; data?: { approval: Approval };
    };
    expect(res.ok, res.error).toBe(true);
    const req = await store.getApprovalRequest(hashApprovalToken(tokenOf(res.data!.approval.url)));
    expect(req).toMatchObject({ sha256: sha, requested_by: 'dev@example.com' });
    expect(await store.listApprovals(flow.flow_id)).toEqual([]);
    expect((await store.getFlow(flow.flow_id))?.status).toBe('prd_in_review');
  });

  it('request_approval rechaza: sin PRD, ya aprobado, o workspace sin la exigencia', async () => {
    const sinPrd = (await requestApproval().handler({ flow_id: flow.flow_id, artifact: 'prd' }, devCtx)) as R;
    expect(sinPrd.ok).toBe(false);
    expect(sinPrd.error).toMatch(/todavía no tiene PRD/);

    const r = (await submitPrd().handler({ flow_id: flow.flow_id, prd_markdown: PRD }, ctx)) as R;
    await store.recordApproval({
      tenant_id: 't1', flow_id: flow.flow_id, artifact: 'prd', sha256: r.data!.flow.prd_ref!.sha256!,
      approved_by: 'pm@example.com', approver_roles: ['product-manager'], self_signed: false,
    });
    const ya = (await requestApproval().handler({ flow_id: flow.flow_id, artifact: 'prd' }, devCtx)) as R;
    expect(ya.ok).toBe(false);
    expect(ya.error).toMatch(/ya está aprobado/);

    const off = (await makeRequestApprovalTool(store, approvalPolicyFrom([])).handler(
      { flow_id: flow.flow_id, artifact: 'prd' },
      devCtx,
    )) as R;
    expect(off.ok).toBe(false);
    expect(off.error).toMatch(/no exige aprobación/);
  });

  it('request_approval no deja pedir links de otro workspace', async () => {
    const ajeno = await store.createFlow({ tenant_id: 't1', project: 'otro', slug: 'x', title: 'X' });
    await store.updateFlow(ajeno.flow_id, { prd_ref: { sha256: 'a'.repeat(64) } });
    const res = (await requestApproval().handler({ flow_id: ajeno.flow_id, artifact: 'prd' }, devCtx)) as R;
    expect(res.ok).toBe(false);
  });

  it('get_flow_state muestra la aprobación pendiente con su rol dueño y, aprobado, la vigente', async () => {
    await submitPrd().handler({ flow_id: flow.flow_id, prd_markdown: PRD }, ctx);
    type S = { data: { approvals: Record<string, { approved_by: string; sha256: string }>; pending_approval: unknown } };
    let s = (await getState().handler({ flow_id: flow.flow_id }, devCtx)) as S;
    expect(s.data.pending_approval).toEqual({ artifact: 'prd', owner_role: 'product-manager' });
    expect(s.data.approvals).toEqual({});

    const f = (await store.getFlow(flow.flow_id))!;
    await store.recordApproval({
      tenant_id: 't1', flow_id: flow.flow_id, artifact: 'prd', sha256: f.prd_ref!.sha256!,
      approved_by: 'pm@example.com', approver_roles: ['product-manager'], self_signed: false,
    });
    await seedFlowStatus(store, flow.flow_id, { status: 'prd_ready', current_phase: 'rfc' });
    s = (await getState().handler({ flow_id: flow.flow_id }, devCtx)) as S;
    expect(s.data.pending_approval).toBeNull();
    expect(s.data.approvals.prd).toMatchObject({ approved_by: 'pm@example.com', sha256: f.prd_ref!.sha256 });

    await submitRfc().handler({ flow_id: flow.flow_id, rfc_markdown: RFC, repo_path: 'docs/rfc/x.md' }, ctx);
    s = (await getState().handler({ flow_id: flow.flow_id }, devCtx)) as S;
    expect(s.data.pending_approval).toEqual({ artifact: 'rfc', owner_role: 'tech-lead' });
  });

  it('un flow viejo en rfc_ready sin aprobación muestra pendiente la del RFC', async () => {
    await store.updateFlow(flow.flow_id, { prd_ref: { sha256: 'a'.repeat(64) }, rfc_ref: { sha256: 'b'.repeat(64) } });
    await seedFlowStatus(store, flow.flow_id, { status: 'rfc_ready', current_phase: 'shaping' });
    const s = (await getState().handler({ flow_id: flow.flow_id }, devCtx)) as { data: { pending_approval: unknown } };
    expect(s.data.pending_approval).toEqual({ artifact: 'rfc', owner_role: 'tech-lead' });

    const sinExigencia = (await makeGetFlowStateTool(store, undefined, approvalPolicyFrom([])).handler(
      { flow_id: flow.flow_id },
      devCtx,
    )) as { data: { pending_approval: unknown } };
    expect(sinExigencia.data.pending_approval).toBeNull();
  });
});
