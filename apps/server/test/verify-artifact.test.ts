import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { Flow } from '@sdlc/core';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { makeVerifyArtifactTool } from '../src/mcp/tools/verify-artifact.js';
import { NoOpDocStoreAdapter } from '../src/adapters/doc-store-provider.js';
import type { DocStoreProvider } from '../src/adapters/doc-store-provider.js';
import { testCtx } from './helpers/tenant-ctx.js';

// El claim `workspaces` va explícito y por dentro de testCtx: las guardas de
// workspace ya no dejan pasar un ctx sin él.
const ctx: TenantCtx = testCtx({
  tenantId: 't1', userId: 'u', roles: [], workspaces: ['p1'],
});

const PRD = `# PRD: Checkout

## Problema
El checkout se cae.

## Objetivo
Que no se caiga.
`;

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Adapter real (no no-op) que devuelve el markdown que le pasemos. */
function fakeAdapter(markdown: string | unknown, version = 'v1') {
  return {
    kind: 'google-drive' as const,
    publish: vi.fn(),
    fetch: vi.fn().mockResolvedValue({ markdown, version }),
  };
}

function fakeProvider(adapter: unknown): DocStoreProvider {
  return { resolve: vi.fn().mockResolvedValue(adapter) } as unknown as DocStoreProvider;
}

/** Crea un flow con la referencia ya seteada, como la dejaría submit_prd/submit_rfc. */
async function flowConRef(
  store: InMemoryFlowStore,
  kind: 'prd' | 'rfc' | 'change_note',
  ref: Record<string, unknown>,
  overrides: Partial<Flow> = {},
) {
  const flow = await store.createFlow({
    tenant_id: 't1', project: 'p1', slug: 'checkout', title: 'Checkout',
    ...overrides,
  } as Parameters<InMemoryFlowStore['createFlow']>[0]);
  return store.updateFlow(flow.flow_id, { [`${kind}_ref`]: ref } as Partial<Flow>);
}

describe('verify_artifact', () => {
  describe('hash que coincide', () => {
    it('devuelve ok y verdict=match cuando los bytes traídos hashean igual', async () => {
      const store = new InMemoryFlowStore();
      const flow = await flowConRef(store, 'prd', { sha256: sha(PRD), external_id: 'md-1' });
      const adapter = fakeAdapter(PRD);
      const tool = makeVerifyArtifactTool(store, fakeProvider(adapter));

      const res = await tool.handler({ flow_id: flow.flow_id, kind: 'prd' }, ctx);

      expect(res.ok).toBe(true);
      expect(res.data).toMatchObject({
        verdict: 'match',
        strict: true,
        expected_sha256: sha(PRD),
        actual_sha256: sha(PRD),
        normalizations_applied: [],
      });
      // Verifica contra el `.md` (external_id), no contra el Doc nativo.
      expect(adapter.fetch).toHaveBeenCalledWith('md-1', ctx);
    });

    it('verifica también el RFC', async () => {
      const store = new InMemoryFlowStore();
      const flow = await flowConRef(store, 'rfc', {
        sha256: sha(PRD), external_id: 'md-rfc', repo_path: 'docs/rfc.md',
      });
      const tool = makeVerifyArtifactTool(store, fakeProvider(fakeAdapter(PRD)));

      const res = await tool.handler({ flow_id: flow.flow_id, kind: 'rfc' }, ctx);

      expect(res.ok).toBe(true);
      expect(res.data).toMatchObject({ verdict: 'match', kind: 'rfc' });
      // repo_path viaja como dato informativo; la tool no lo resuelve contra nada.
      expect((res.data as { repo_path: string }).repo_path).toBe('docs/rfc.md');
    });

    it('no escribe nada en el flow (es de lectura)', async () => {
      const store = new InMemoryFlowStore();
      const flow = await flowConRef(store, 'prd', { sha256: sha(PRD), external_id: 'md-1' });
      const antes = await store.getFlow(flow.flow_id);
      const tool = makeVerifyArtifactTool(store, fakeProvider(fakeAdapter(PRD)));

      await tool.handler({ flow_id: flow.flow_id, kind: 'prd' }, ctx);

      const despues = await store.getFlow(flow.flow_id);
      expect(despues).toEqual(antes);
      expect(await store.listEvents(flow.flow_id)).toHaveLength(0);
    });
  });

  describe('hash que no coincide', () => {
    it('devuelve ok:false con los dos hashes en el mensaje', async () => {
      const store = new InMemoryFlowStore();
      const original = sha(PRD);
      const flow = await flowConRef(store, 'prd', { sha256: original, external_id: 'md-1' });
      const editado = PRD.replace('El checkout se cae.', 'El checkout anda perfecto.');
      const tool = makeVerifyArtifactTool(store, fakeProvider(fakeAdapter(editado)));

      const res = await tool.handler({ flow_id: flow.flow_id, kind: 'prd' }, ctx);

      expect(res.ok).toBe(false);
      expect(res.error).toContain(original);
      expect(res.error).toContain(sha(editado));
      // El mensaje nombra la salida ejecutable.
      expect(res.error).toContain('submit_prd');
      expect(res.data).toMatchObject({
        verdict: 'mismatch',
        strict: false,
        expected_sha256: original,
        actual_sha256: sha(editado),
      });
    });

    it('un cambio de espacios interiores NO se perdona', async () => {
      const store = new InMemoryFlowStore();
      const flow = await flowConRef(store, 'prd', { sha256: sha(PRD), external_id: 'md-1' });
      // Espacio al final de una línea interior: cambia bytes y no lo normalizamos.
      const conEspacio = PRD.replace('## Objetivo', '## Objetivo ');
      const tool = makeVerifyArtifactTool(store, fakeProvider(fakeAdapter(conEspacio)));

      const res = await tool.handler({ flow_id: flow.flow_id, kind: 'prd' }, ctx);

      expect(res.ok).toBe(false);
      expect((res.data as { verdict: string }).verdict).toBe('mismatch');
    });
  });

  describe('normalización', () => {
    it('perdona CRLF y lo reporta como match_normalized (no como match)', async () => {
      const store = new InMemoryFlowStore();
      const flow = await flowConRef(store, 'prd', { sha256: sha(PRD), external_id: 'md-1' });
      const crlf = PRD.replace(/\n/g, '\r\n');
      const tool = makeVerifyArtifactTool(store, fakeProvider(fakeAdapter(crlf)));

      const res = await tool.handler({ flow_id: flow.flow_id, kind: 'prd' }, ctx);

      expect(res.ok).toBe(true);
      expect(res.data).toMatchObject({
        verdict: 'match_normalized',
        strict: false,
        normalizations_applied: ['crlf'],
        actual_sha256: sha(crlf),
      });
      // El hash crudo reportado es el del documento tal cual vino, no el normalizado.
      expect((res.data as { actual_sha256: string }).actual_sha256).not.toBe(sha(PRD));
    });

    it('perdona el BOM UTF-8 al inicio', async () => {
      const store = new InMemoryFlowStore();
      const flow = await flowConRef(store, 'prd', { sha256: sha(PRD), external_id: 'md-1' });
      const tool = makeVerifyArtifactTool(store, fakeProvider(fakeAdapter(`﻿${PRD}`)));

      const res = await tool.handler({ flow_id: flow.flow_id, kind: 'prd' }, ctx);

      expect(res.ok).toBe(true);
      expect(res.data).toMatchObject({
        verdict: 'match_normalized',
        normalizations_applied: ['bom'],
      });
    });

    it('perdona saltos de línea de más al final del archivo', async () => {
      const store = new InMemoryFlowStore();
      // El ancla se calculó SIN salto final; el doc store devuelve dos de más.
      const sinTrailing = PRD.replace(/\n+$/, '');
      const flow = await flowConRef(store, 'prd', { sha256: sha(sinTrailing), external_id: 'md-1' });
      const tool = makeVerifyArtifactTool(store, fakeProvider(fakeAdapter(`${sinTrailing}\n\n`)));

      const res = await tool.handler({ flow_id: flow.flow_id, kind: 'prd' }, ctx);

      expect(res.ok).toBe(true);
      expect(res.data).toMatchObject({
        verdict: 'match_normalized',
        normalizations_applied: ['trailing_newline'],
      });
    });

    it('combina BOM + CRLF + salto final y las reporta todas', async () => {
      const store = new InMemoryFlowStore();
      const sinTrailing = PRD.replace(/\n+$/, '');
      const flow = await flowConRef(store, 'prd', { sha256: sha(sinTrailing), external_id: 'md-1' });
      const sucio = `﻿${sinTrailing.replace(/\n/g, '\r\n')}\r\n\r\n`;
      const tool = makeVerifyArtifactTool(store, fakeProvider(fakeAdapter(sucio)));

      const res = await tool.handler({ flow_id: flow.flow_id, kind: 'prd' }, ctx);

      expect(res.ok).toBe(true);
      expect((res.data as { normalizations_applied: string[] }).normalizations_applied)
        .toEqual(['bom', 'crlf', 'trailing_newline']);
    });
  });

  describe('documento que no se puede traer', () => {
    it('devuelve verdict=unreachable cuando fetch tira', async () => {
      const store = new InMemoryFlowStore();
      const flow = await flowConRef(store, 'prd', {
        sha256: sha(PRD), external_id: 'md-borrado',
        url: 'https://docs.google.com/document/d/g1/edit',
      });
      const adapter = {
        kind: 'google-drive' as const,
        publish: vi.fn(),
        fetch: vi.fn().mockRejectedValue(new Error('File not found: md-borrado')),
      };
      const tool = makeVerifyArtifactTool(store, fakeProvider(adapter));

      const res = await tool.handler({ flow_id: flow.flow_id, kind: 'prd' }, ctx);

      expect(res.ok).toBe(false);
      expect(res.error).toContain('File not found: md-borrado');
      expect(res.error).toContain('submit_prd');
      expect((res.data as { verdict: string }).verdict).toBe('unreachable');
    });

    it('devuelve verdict=unreachable cuando el provider no resuelve', async () => {
      const store = new InMemoryFlowStore();
      const flow = await flowConRef(store, 'prd', { sha256: sha(PRD), external_id: 'md-1' });
      const provider = {
        resolve: vi.fn().mockRejectedValue(new Error('secret_ref missing')),
      } as unknown as DocStoreProvider;
      const tool = makeVerifyArtifactTool(store, provider);

      const res = await tool.handler({ flow_id: flow.flow_id, kind: 'prd' }, ctx);

      expect(res.ok).toBe(false);
      expect(res.error).toContain('secret_ref missing');
      expect(res.error).toContain('verify_artifact');
      expect((res.data as { verdict: string }).verdict).toBe('unreachable');
    });

    it('no verifica cuando el doc store devuelve algo que no es texto', async () => {
      const store = new InMemoryFlowStore();
      const flow = await flowConRef(store, 'prd', { sha256: sha(PRD), external_id: 'md-1' });
      // gaxios puede parsear el body y devolver un objeto en vez de un string.
      const tool = makeVerifyArtifactTool(store, fakeProvider(fakeAdapter({ parsed: true })));

      const res = await tool.handler({ flow_id: flow.flow_id, kind: 'prd' }, ctx);

      expect(res.ok).toBe(false);
      expect((res.data as { verdict: string }).verdict).toBe('not_verifiable');
      expect(res.error).toContain('submit_prd');
    });
  });

  describe('no-op rechazado', () => {
    it('rechaza el adapter no-op en vez de verificar contra su markdown vacío', async () => {
      const store = new InMemoryFlowStore();
      const flow = await flowConRef(store, 'prd', { sha256: sha(PRD), external_id: 'md-1' });
      const noop = new NoOpDocStoreAdapter();
      const spy = vi.spyOn(noop, 'fetch');
      const tool = makeVerifyArtifactTool(store, fakeProvider(noop));

      const res = await tool.handler({ flow_id: flow.flow_id, kind: 'prd' }, ctx);

      expect(res.ok).toBe(false);
      expect(res.error).toContain('no-op');
      expect(res.error).toContain('doc_store');
      expect(res.error).toContain('verify_artifact');
      expect((res.data as { verdict: string }).verdict).toBe('not_verifiable');
      // La guarda corre ANTES del side-effect: no llegamos a pedirle nada al no-op.
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('flow sin la referencia pedida', () => {
    it('rechaza cuando el flow no tiene prd_ref', async () => {
      const store = new InMemoryFlowStore();
      const flow = await store.createFlow({
        tenant_id: 't1', project: 'p1', slug: 'sin-prd', title: 'Sin PRD',
      } as Parameters<InMemoryFlowStore['createFlow']>[0]);
      const tool = makeVerifyArtifactTool(store, fakeProvider(fakeAdapter(PRD)));

      const res = await tool.handler({ flow_id: flow.flow_id, kind: 'prd' }, ctx);

      expect(res.ok).toBe(false);
      expect(res.error).toContain('submit_prd');
      expect((res.data as { verdict: string }).verdict).toBe('not_verifiable');
    });

    it('rechaza cuando la referencia existe pero no tiene sha256', async () => {
      const store = new InMemoryFlowStore();
      const flow = await flowConRef(store, 'rfc', { external_id: 'md-1', repo_path: 'docs/rfc.md' });
      const tool = makeVerifyArtifactTool(store, fakeProvider(fakeAdapter(PRD)));

      const res = await tool.handler({ flow_id: flow.flow_id, kind: 'rfc' }, ctx);

      expect(res.ok).toBe(false);
      expect(res.error).toContain('sha256');
      expect(res.error).toContain('submit_rfc');
      expect((res.data as { verdict: string }).verdict).toBe('not_verifiable');
    });

    it('rechaza cuando la referencia no tiene external_id (nunca se publicó)', async () => {
      const store = new InMemoryFlowStore();
      const flow = await flowConRef(store, 'prd', { sha256: sha(PRD), repo_path: 'docs/prd.md' });
      const tool = makeVerifyArtifactTool(store, fakeProvider(fakeAdapter(PRD)));

      const res = await tool.handler({ flow_id: flow.flow_id, kind: 'prd' }, ctx);

      expect(res.ok).toBe(false);
      expect(res.error).toContain('external_id');
      expect(res.error).toContain('submit_prd');
      expect((res.data as { verdict: string }).verdict).toBe('not_verifiable');
    });

    it('marca no verificable cuando sólo hay gdoc_id (Doc nativo)', async () => {
      const store = new InMemoryFlowStore();
      const flow = await flowConRef(store, 'prd', { sha256: sha(PRD), gdoc_id: 'gdoc-1' });
      const tool = makeVerifyArtifactTool(store, fakeProvider(fakeAdapter(PRD)));

      const res = await tool.handler({ flow_id: flow.flow_id, kind: 'prd' }, ctx);

      expect(res.ok).toBe(false);
      expect(res.error).toContain('Doc nativo');
      expect(res.error).toContain('submit_prd');
      expect((res.data as { verdict: string }).verdict).toBe('not_verifiable');
    });

    it('rechaza el flow inexistente', async () => {
      const store = new InMemoryFlowStore();
      const tool = makeVerifyArtifactTool(store, fakeProvider(fakeAdapter(PRD)));

      const res = await tool.handler({ flow_id: 't1:p1:fantasma', kind: 'prd' }, ctx);

      expect(res.ok).toBe(false);
      expect(res.error).toContain('Unknown flow');
    });
  });

  describe('ADR', () => {
    it('rechaza kind=adr porque submit_adr no persiste sha256', async () => {
      const store = new InMemoryFlowStore();
      const flow = await store.createFlow({
        tenant_id: 't1', project: 'p1', slug: 'con-adr', title: 'Con ADR',
      } as Parameters<InMemoryFlowStore['createFlow']>[0]);
      await store.updateFlow(flow.flow_id, {
        adr_refs: [{ url: 'https://docs.google.com/document/d/a1/edit', external_id: 'adr-md-1' }],
        adr_count: 1,
      });
      const adapter = fakeAdapter(PRD);
      const tool = makeVerifyArtifactTool(store, fakeProvider(adapter));

      const res = await tool.handler({ flow_id: flow.flow_id, kind: 'adr' }, ctx);

      expect(res.ok).toBe(false);
      expect(res.error).toContain('sha256');
      expect(res.error).toContain('verify_artifact');
      expect(res.error).toContain('get_flow_state');
      expect((res.data as { verdict: string }).verdict).toBe('not_verifiable');
      // Ni siquiera se toca el doc store.
      expect(adapter.fetch).not.toHaveBeenCalled();
    });
  });

  describe('nota de cambio', () => {
    const NOTA = '---\nrepo: acme/sdlc-mcp\n---\n\n# Fix\n\n## Qué pasa\nse rompe\n';

    it('verifica la nota contra su sha256, igual que el PRD', async () => {
      const store = new InMemoryFlowStore();
      const flow = await flowConRef(store, 'change_note', { sha256: sha(NOTA), external_id: 'md-9' });
      const adapter = fakeAdapter(NOTA);
      const tool = makeVerifyArtifactTool(store, fakeProvider(adapter));

      const res = await tool.handler({ flow_id: flow.flow_id, kind: 'change_note' }, ctx);

      expect(res.ok).toBe(true);
      expect((res.data as { verdict: string }).verdict).toBe('match');
    });

    it('detecta que la nota publicada dejó de coincidir', async () => {
      const store = new InMemoryFlowStore();
      const flow = await flowConRef(store, 'change_note', { sha256: sha(NOTA), external_id: 'md-9' });
      const tool = makeVerifyArtifactTool(store, fakeProvider(fakeAdapter(NOTA + '\neditado a mano\n')));

      const res = await tool.handler({ flow_id: flow.flow_id, kind: 'change_note' }, ctx);

      expect(res.ok).toBe(false);
      expect((res.data as { verdict: string }).verdict).toBe('mismatch');
    });

    it('un flow sin nota manda a submit_change_note', async () => {
      const store = new InMemoryFlowStore();
      const flow = await store.createFlow({
        tenant_id: 't1', project: 'p1', slug: 'sin-nota', title: 'Sin nota',
      } as Parameters<InMemoryFlowStore['createFlow']>[0]);
      const adapter = fakeAdapter(NOTA);
      const tool = makeVerifyArtifactTool(store, fakeProvider(adapter));

      const res = await tool.handler({ flow_id: flow.flow_id, kind: 'change_note' }, ctx);

      expect(res.ok).toBe(false);
      expect(res.error).toContain('submit_change_note');
      expect(adapter.fetch).not.toHaveBeenCalled();
    });
  });

  describe('autorización', () => {
    it('deniega un flow de otro tenant', async () => {
      const store = new InMemoryFlowStore();
      const flow = await flowConRef(store, 'prd', { sha256: sha(PRD), external_id: 'md-1' });
      const ajeno = testCtx({ tenantId: 'otro-tenant', userId: 'u2', workspaces: ['p1'] });
      const adapter = fakeAdapter(PRD);
      const tool = makeVerifyArtifactTool(store, fakeProvider(adapter));

      const res = await tool.handler({ flow_id: flow.flow_id, kind: 'prd' }, ajeno);

      expect(res.ok).toBe(false);
      expect(res.error).toBe('Flow belongs to a different tenant');
      expect(adapter.fetch).not.toHaveBeenCalled();
    });

    it('deniega a un usuario del mismo tenant pero de otro workspace', async () => {
      const store = new InMemoryFlowStore();
      const flow = await flowConRef(store, 'prd', { sha256: sha(PRD), external_id: 'md-1' });
      // Mismo tenant, sin membresía en "p1": el chequeo de tenant solo lo dejaría pasar.
      const ajeno = testCtx({ tenantId: 't1', userId: 'u2', workspaces: ['otro-proyecto'] });
      const adapter = fakeAdapter(PRD);
      const tool = makeVerifyArtifactTool(store, fakeProvider(adapter));

      const res = await tool.handler({ flow_id: flow.flow_id, kind: 'prd' }, ajeno);

      expect(res.ok).toBe(false);
      expect(res.error).toContain('No tenés acceso al workspace "p1"');
      expect(res.error).toContain('otro-proyecto');
      expect(adapter.fetch).not.toHaveBeenCalled();
    });
  });
});
