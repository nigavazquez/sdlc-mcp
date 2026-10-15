import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Catalog } from '@sdlc/catalog';
import { InMemoryFlowStore } from '../src/state/index.js';
import { InMemoryTaskSystemAdapter, ConfigBackedTaskSystemProvider } from '../src/adapters/index.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import { buildToolRegistry } from '../src/mcp/tools/index.js';
import { testCtx } from './helpers/tenant-ctx.js';

const CATALOG_ROOT = resolve(__dirname, '../../../packages/catalog');

/**
 * Toda tool declara con qué tracks trabaja.
 *
 * Es la misma mecánica que `tools-resource-access.test.ts`: la tabla cruza contra el
 * registry, así que una tool nueva no puede olvidarse de decidir de qué lado está.
 * Sin esto, la próxima tool del track liviano se escribe sin la guarda de track y
 * nadie se entera hasta que una feature entre por la puerta chica.
 */

/** Rechazan un flow del track completo. Hoy es la única tool del track liviano. */
const SOLO_LITE = ['submit_change_note'];

/**
 * Andan en los dos tracks, y eso es una afirmación, no una omisión.
 *
 * Las de descubrimiento del track completo (`submit_prd`, `submit_rfc`, …) están acá
 * a propósito: **se sube de track, no se baja**. Un flow liviano que resultó más
 * grande de lo pensado llama `submit_prd` y sigue el camino largo. Al revés no, y de
 * eso se ocupa `SOLO_LITE`.
 *
 * Las de entrega (`claim_story` en adelante) están acá porque el track no las toca:
 * el plan de QA, el sobre con `test_exit_code` y la separación entre quien implementa
 * y quien firma son idénticos en los dos.
 */
const AMBOS = [
  'whoami', 'list_roles', 'get_role_prompt', 'start_flow', 'get_flow_state',
  'submit_prd', 'validate_prd', 'generate_rfc_skeleton', 'submit_rfc', 'validate_rfc',
  'submit_adr', 'verify_artifact', 'propose_breakdown', 'create_epic', 'create_stories',
  'link_subtasks', 'sync_backlog', 'claim_story', 'get_implementation_context',
  'report_progress', 'generate_qa_plan', 'submit_qa_results', 'block_story',
  'discard_story', 'request_code_review', 'submit_review_outcome', 'abort_flow',
];

function armarRegistry(store: InMemoryFlowStore, catalog: Catalog) {
  return buildToolRegistry({
    catalog,
    store,
    taskSystemProvider: new ConfigBackedTaskSystemProvider({
      configStore: new InMemoryIntegrationConfigStore(),
      inMemory: new InMemoryTaskSystemAdapter(),
    }),
  });
}

const CTX = testCtx({
  tenantId: 'default',
  userId: 'nico',
  roles: ['developer', 'tech-lead', 'pmo', 'product-manager', 'qa', 'reviewer'],
  workspaces: ['platform'],
});

describe('toda tool del registry declara con qué tracks trabaja', () => {
  it('cada tool está en una de las dos listas', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const registradas = armarRegistry(new InMemoryFlowStore(), catalog)
      .list()
      .map((t) => t.name)
      .sort();

    expect(registradas).toEqual([...SOLO_LITE, ...AMBOS].sort());
  });

  it('las listas no declaran tools que no existen ni repiten', () => {
    const todas = [...SOLO_LITE, ...AMBOS];
    expect(new Set(todas).size).toBe(todas.length);
  });
});

describe('las tools del track liviano rechazan un flow del completo', () => {
  for (const name of SOLO_LITE) {
    it(`${name}: sobre un feature rechaza y nombra la salida`, async () => {
      const store = new InMemoryFlowStore();
      const catalog = await Catalog.load(CATALOG_ROOT);
      const flow = await store.createFlow({
        tenant_id: 'default',
        project: 'platform',
        slug: 'iniciativa-grande',
        title: 'Iniciativa grande',
        initiative_type: 'feature',
      });

      const res = (await armarRegistry(store, catalog).get(name)!.handler(
        {
          flow_id: flow.flow_id,
          change_note_markdown: 'x'.repeat(60),
          stories: [{ title: 't', description: 'd', acceptance_criteria: ['ac'] }],
        } as never,
        CTX,
      )) as { ok: boolean; error?: string };

      expect(res.ok).toBe(false);
      expect(res.error).toContain('submit_prd');
      // El flow no se movió: degradar una feature a nota de cambio sería el agujero.
      expect((await store.getFlow(flow.flow_id))?.status).toBe('draft');
    });
  }
});

describe('ninguna tool de AMBOS rechaza por track', () => {
  // No enumera comportamientos —cada tool tiene sus propias guardas de status y de
  // rol, y varias van a rechazar por esas— sino que verifica la única propiedad que
  // el track promete: que el motivo del rechazo nunca sea el track. Es lo que
  // mantiene abierta la escalada de lite a full.
  for (const name of AMBOS) {
    it(`${name}: sobre un flow lite no falla por el track`, async () => {
      const store = new InMemoryFlowStore();
      const catalog = await Catalog.load(CATALOG_ROOT);
      const flow = await store.createFlow({
        tenant_id: 'default',
        project: 'platform',
        slug: 'un-fix',
        title: 'Un fix',
        initiative_type: 'fix',
      });

      // Un input con todos los campos que piden las 27: las tools reciben el handler
      // crudo, sin el parseo de zod del transporte, así que sin ellos varias explotan
      // antes de llegar a ninguna guarda y el test pasaría sin haber probado nada. Los
      // campos de más se ignoran; lo que importa es que cada tool llegue a decidir.
      const res = (await armarRegistry(store, catalog).get(name)!.handler(
        {
          flow_id: flow.flow_id,
          project: 'platform',
          title: 'Un fix',
          initiative_type: 'fix',
          role: 'developer',
          phase: 'implement',
          story_id: `${flow.flow_id}::NO-EXISTE`,
          developer_id: 'nico',
          epic_id: 'E-1',
          epic: { title: 'Un fix', description: 'd' },
          stories: [{ title: 't', description: 'd', acceptance_criteria: ['ac'] }],
          subtasks: [{ title: 't' }],
          kind: 'prd',
          prd_markdown: 'x'.repeat(60),
          rfc_markdown: 'x'.repeat(60),
          change_note_markdown: 'x'.repeat(60),
          status: 'in_progress',
          reason: 'motivo de prueba',
          verdict: 'passed',
          results: [],
          outcome: 'approved',
          reviewers: ['ana'],
          pr_url: 'https://github.com/nigavazquez/sdlc-mcp/pull/1',
        } as never,
        CTX,
      )) as { ok: boolean; error?: string };

      expect(res.error ?? '').not.toContain('track liviano');
      expect(res.error ?? '').not.toContain('track completo');
    });
  }
});
