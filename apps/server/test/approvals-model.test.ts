import { readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FlowStatus,
  OWNER_ROLE,
  approvalRefsOf,
  currentApprovals,
  isApprovalCurrent,
  type Flow,
} from '@sdlc/core';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { PostgresFlowStore } from '../src/state/postgres.js';
import type { FlowStore } from '../src/state/store.js';
import { seedFlowStatus } from './helpers/flow-status.js';

/**
 * Historia A1 (#66): modelo de aprobaciones. Seam: la interfaz `FlowStore`
 * (`recordApproval`, `listApprovals`, `invalidateApprovals`) y las funciones puras
 * de vigencia de `@sdlc/core`. Las mismas pruebas corren contra memoria siempre y
 * contra Postgres cuando hay `TEST_DATABASE_URL`.
 */

const MIGRATIONS_DIR = resolve(__dirname, '../migrations');
const SQL_0016 = readFileSync(join(MIGRATIONS_DIR, '0016_approvals.sql'), 'utf8');

describe('migración 0016 (approvals)', () => {
  it('crea flow_approvals con sha256, quién aprobó, sus roles y la firma propia', () => {
    expect(SQL_0016).toMatch(/CREATE TABLE IF NOT EXISTS "flow_approvals"/);
    for (const col of ['"sha256" text NOT NULL', '"approved_by" text NOT NULL', '"approver_roles" text[] NOT NULL', '"self_signed" boolean NOT NULL']) {
      expect(SQL_0016).toContain(col);
    }
  });

  it('crea approval_requests guardando sólo el hash del token', () => {
    expect(SQL_0016).toMatch(/CREATE TABLE IF NOT EXISTS "approval_requests"/);
    expect(SQL_0016).toContain('"token_hash" text PRIMARY KEY');
    expect(SQL_0016).not.toMatch(/"token" text/);
  });

  it('es aditiva: no borra ni renombra nada', () => {
    expect(SQL_0016.replace(/^--.*$/gm, '')).not.toMatch(/\b(DROP|RENAME|ALTER TABLE "flows")\b/);
  });
});

describe('FlowStatus con revisión', () => {
  it('acepta prd_in_review y rfc_in_review además de los estados de siempre', () => {
    for (const s of ['draft', 'prd_in_review', 'prd_ready', 'rfc_in_review', 'rfc_ready', 'backlog_ready']) {
      expect(FlowStatus.safeParse(s).success, s).toBe(true);
    }
    expect(FlowStatus.safeParse('aprobado').success).toBe(false);
  });

  it('el rol dueño es product-manager para PRD y criterios, tech-lead para RFC', () => {
    expect(OWNER_ROLE).toEqual({
      prd: 'product-manager',
      rfc: 'tech-lead',
      acceptance_criteria: 'product-manager',
    });
  });
});

const SHA_V1 = 'a'.repeat(64);
const SHA_V2 = 'b'.repeat(64);

/** Las pruebas de comportamiento, para cualquier implementación del store. */
function approvalSuite(nombre: string, make: () => Promise<FlowStore>) {
  describe(`aprobaciones en ${nombre}`, () => {
    let store: FlowStore;
    let flow: Flow;

    beforeEach(async () => {
      store = await make();
      flow = await store.createFlow({ tenant_id: 't1', project: 'p1', slug: 'aprob', title: 'Aprob' });
      flow = await store.updateFlow(flow.flow_id, { prd_ref: { sha256: SHA_V1, repo_path: 'docs/prd/aprob.md' } });
    });

    it('registra la aprobación con sha256, quién aprobó, sus roles y la firma propia', async () => {
      const a = await store.recordApproval({
        tenant_id: 't1',
        flow_id: flow.flow_id,
        artifact: 'prd',
        sha256: SHA_V1,
        approved_by: 'pm@example.com',
        approver_roles: ['product-manager', 'tech-lead'],
        self_signed: true,
      });
      expect(a).toMatchObject({
        flow_id: flow.flow_id,
        artifact: 'prd',
        sha256: SHA_V1,
        approved_by: 'pm@example.com',
        approver_roles: ['product-manager', 'tech-lead'],
        self_signed: true,
      });
      expect(a.id).toBeTruthy();
      expect(Number.isNaN(Date.parse(a.approved_at))).toBe(false);
      expect(a.invalidated_at).toBeUndefined();

      const listed = await store.listApprovals(flow.flow_id);
      expect(listed).toEqual([a]);
    });

    it('la aprobación de la versión actual está vigente', async () => {
      await store.recordApproval({
        tenant_id: 't1', flow_id: flow.flow_id, artifact: 'prd', sha256: SHA_V1,
        approved_by: 'pm@example.com', approver_roles: ['product-manager'], self_signed: false,
      });
      const vig = currentApprovals(await store.listApprovals(flow.flow_id), approvalRefsOf(flow));
      expect(vig.prd?.sha256).toBe(SHA_V1);
      expect(vig.rfc).toBeUndefined();
    });

    it('GIVEN el PRD cambió de sha256 WHEN se lee el flow THEN la aprobación vieja no está vigente', async () => {
      await store.recordApproval({
        tenant_id: 't1', flow_id: flow.flow_id, artifact: 'prd', sha256: SHA_V1,
        approved_by: 'pm@example.com', approver_roles: ['product-manager'], self_signed: false,
      });
      const reenviado = await store.updateFlow(flow.flow_id, { prd_ref: { sha256: SHA_V2 } });

      const approvals = await store.listApprovals(flow.flow_id);
      expect(approvals).toHaveLength(1); // sigue guardada para la auditoría
      expect(isApprovalCurrent(approvals[0]!, approvalRefsOf(reenviado))).toBe(false);
      expect(currentApprovals(approvals, approvalRefsOf(reenviado)).prd).toBeUndefined();
    });

    it('invalidar marca sólo las no invalidadas de esos artefactos y deja de estar vigente', async () => {
      flow = await store.updateFlow(flow.flow_id, { rfc_ref: { sha256: SHA_V2 } });
      const base = { tenant_id: 't1', flow_id: flow.flow_id, approved_by: 'x@example.com', approver_roles: ['tech-lead'], self_signed: false };
      await store.recordApproval({ ...base, artifact: 'prd', sha256: SHA_V1 });
      await store.recordApproval({ ...base, artifact: 'rfc', sha256: SHA_V2 });

      const marcadas = await store.invalidateApprovals(flow.flow_id, ['rfc'], 'upstream_resubmitted');
      expect(marcadas.map((a) => a.artifact)).toEqual(['rfc']);
      expect(marcadas[0]?.invalidated_reason).toBe('upstream_resubmitted');

      const vig = currentApprovals(await store.listApprovals(flow.flow_id), approvalRefsOf(flow));
      expect(vig.prd?.sha256).toBe(SHA_V1);
      expect(vig.rfc).toBeUndefined();

      // Idempotente: una segunda invalidación no vuelve a marcar nada.
      expect(await store.invalidateApprovals(flow.flow_id, ['rfc'], 'content_changed')).toEqual([]);
    });

    it('sin artefactos no invalida nada', async () => {
      await store.recordApproval({
        tenant_id: 't1', flow_id: flow.flow_id, artifact: 'prd', sha256: SHA_V1,
        approved_by: 'pm@example.com', approver_roles: ['product-manager'], self_signed: false,
      });
      expect(await store.invalidateApprovals(flow.flow_id, [], 'content_changed')).toEqual([]);
    });

    it('rechaza una aprobación de un flow que no existe', async () => {
      await expect(
        store.recordApproval({
          tenant_id: 't1', flow_id: 't1:p1:no-existe', artifact: 'prd', sha256: SHA_V1,
          approved_by: 'pm@example.com', approver_roles: [], self_signed: false,
        }),
      ).rejects.toThrow(/unknown flow/);
    });

    it('un link de aprobación se guarda por el hash del token y se vuelve a leer igual', async () => {
      const req = {
        token_hash: 'h'.repeat(64), tenant_id: 't1', flow_id: flow.flow_id, artifact: 'prd' as const,
        sha256: SHA_V1, requested_by: 'autor@example.com', expires_at: '2026-12-04T00:00:00.000Z',
      };
      expect(await store.createApprovalRequest(req)).toEqual(req);
      expect(await store.getApprovalRequest(req.token_hash)).toEqual(req);
      expect(await store.getApprovalRequest('otro')).toBeUndefined();
      await expect(store.createApprovalRequest(req)).rejects.toThrow();
    });

    it('un flow existente pasa por prd_in_review y rfc_in_review y vuelve a leerse igual', async () => {
      for (const status of ['prd_in_review', 'prd_ready', 'rfc_in_review', 'rfc_ready'] as const) {
        const w = await seedFlowStatus(store, flow.flow_id, { status });
        expect(w.status).toBe(status);
        expect((await store.getFlow(flow.flow_id))?.status).toBe(status);
      }
    });
  });
}

describe('vigencia sin referencia', () => {
  it('una aprobación de criterios no está vigente mientras el flow no tenga borrador', () => {
    const refs = approvalRefsOf({ prd_ref: { sha256: SHA_V1 } });
    const a = {
      id: '1', tenant_id: 't', flow_id: 'f', artifact: 'acceptance_criteria' as const, sha256: SHA_V1,
      approved_by: 'pm', approver_roles: ['product-manager'], self_signed: false, approved_at: '2026-11-27T00:00:00.000Z',
    };
    expect(isApprovalCurrent(a, refs)).toBe(false);
  });

  it('con dos aprobaciones vigentes de la misma versión gana la más reciente', () => {
    const base = {
      tenant_id: 't', flow_id: 'f', artifact: 'prd' as const, sha256: SHA_V1,
      approver_roles: ['product-manager'], self_signed: false,
    };
    const vieja = { ...base, id: '1', approved_by: 'a', approved_at: '2026-11-27T00:00:00.000Z' };
    const nueva = { ...base, id: '2', approved_by: 'b', approved_at: '2026-11-27T01:00:00.000Z' };
    expect(currentApprovals([nueva, vieja], { prd: SHA_V1 }).prd?.id).toBe('2');
  });
});

approvalSuite('memoria', async () => new InMemoryFlowStore());

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('Postgres (integración)', () => {
  // Schema propio: otras suites de integración migran la misma base en paralelo, y
  // dos corridas del DDL a la vez chocan en el catálogo de Postgres.
  const SCHEMA = 'approvals_model_test';
  let adminSql: ReturnType<typeof postgres>;
  let client: ReturnType<typeof postgres>;
  let pg: PostgresFlowStore;

  beforeAll(async () => {
    adminSql = postgres(TEST_DATABASE_URL!, { max: 1 });
    await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
    client = postgres(TEST_DATABASE_URL!, { max: 1, connection: { search_path: SCHEMA } });
    for (const file of (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()) {
      await client.unsafe(await readFile(join(MIGRATIONS_DIR, file), 'utf8'));
    }
    pg = new PostgresFlowStore({ databaseUrl: TEST_DATABASE_URL!, client });
  });

  afterAll(async () => {
    if (pg) await pg.close();
    if (adminSql) {
      await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await adminSql.end({ timeout: 5 });
    }
  });

  approvalSuite('Postgres', async () => {
    await client`TRUNCATE TABLE flow_events, flows, stories, flow_approvals, approval_requests CASCADE`;
    return pg;
  });
});
