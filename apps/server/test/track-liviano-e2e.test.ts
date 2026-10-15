import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Catalog } from '@sdlc/catalog';
import { InMemoryFlowStore } from '../src/state/index.js';
import { InMemoryTaskSystemAdapter, ConfigBackedTaskSystemProvider } from '../src/adapters/index.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import { buildToolRegistry } from '../src/mcp/tools/index.js';
import { testCtx } from './helpers/tenant-ctx.js';
import { NOTA_OK as NOTA } from './helpers/change-note.js';

const CATALOG_ROOT = resolve(__dirname, '../../../packages/catalog');

/**
 * El objetivo del track liviano, ejercitado de punta a punta.
 *
 * Corre contra el registry —que es exactamente lo que invoca `POST /mcp/tools/:name`
 * después de autenticar— y no contra el server HTTP, porque ese camino exige un JWT
 * emitido por el AS y lo que se prueba acá es el flujo, no el login.
 *
 * Existe porque la suite puede quedar verde con el objetivo incumplido: que
 * `submit_change_note` funcione no prueba que un fix se haga en dos llamadas.
 */
const CATALOG = await Catalog.load(CATALOG_ROOT);

const DEV = testCtx({ tenantId: 'default', userId: 'nico', roles: ['developer'], workspaces: ['platform'] });
const PM = testCtx({ tenantId: 'default', userId: 'ana', roles: ['product-manager'], workspaces: ['platform'] });

const STORY = {
  title: 'Propagar el claim workspaces en el refresh',
  description: 'El access token del refresh tiene que llevar el mismo claim que el del login.',
  acceptance_criteria: ['El token del refresh trae workspaces', 'Hay test que lo cubre'],
};

function armar() {
  const store = new InMemoryFlowStore();
  const registry = buildToolRegistry({
    catalog: CATALOG,
    store,
    taskSystemProvider: new ConfigBackedTaskSystemProvider({
      configStore: new InMemoryIntegrationConfigStore(),
      inMemory: new InMemoryTaskSystemAdapter(),
    }),
  });
  const llamar = async (name: string, input: unknown, ctx = DEV) =>
    (await registry.get(name)!.handler(input as never, ctx)) as {
      ok: boolean;
      error?: string;
      data?: Record<string, unknown>;
    };
  return { store, llamar };
}

describe('track liviano — de start_flow a implementar', () => {
  it('un fix llega a reclamable en dos llamadas', async () => {
    const { store, llamar } = armar();

    // 1 — un developer abre el flow de su propio bug.
    const abierto = await llamar('start_flow', {
      project: 'platform',
      title: 'El claim de workspaces no llega en el refresh',
      initiative_type: 'fix',
    });
    expect(abierto.ok).toBe(true);
    const flowId = (abierto.data as { flow_id: string }).flow_id;

    // 2 — la nota de cambio, y con eso el backlog.
    const nota = await llamar('submit_change_note', {
      flow_id: flowId,
      change_note_markdown: NOTA,
      stories: [STORY],
    });
    expect(nota.ok).toBe(true);

    // Y ya se puede trabajar: sin PRD, sin RFC, sin cuatro llamadas de shaping.
    const flow = (await store.getFlow(flowId))!;
    expect(flow.status).toBe('backlog_ready');
    expect(flow.prd_ref).toBeUndefined();
    expect(flow.rfc_ref).toBeUndefined();

    const story = (await store.listStoriesByFlow(flowId))[0]!;
    const reclamada = await llamar('claim_story', { story_id: story.story_id, developer_id: 'nico' });
    expect(reclamada.ok).toBe(true);

    // El camino real por el que la skill llega al developer de un fix.
    const skills = (reclamada.data as { skills: Array<{ id: string }> }).skills.map((s) => s.id);
    expect(skills).toContain('skill-repro-antes-del-fix');

    // 3 — y de acá en adelante el camino es el de siempre.
    const progreso = await llamar('report_progress', {
      story_id: story.story_id,
      developer_id: 'nico',
      status: 'in_review',
      pr_url: 'https://github.com/nigavazquez/sdlc-mcp/pull/42',
    });
    expect(progreso.ok).toBe(true);
    expect((await store.getStory(story.story_id))?.status).toBe('in_review');
  });

  it('la fase entrega su prompt y su template', async () => {
    const { llamar } = armar();

    const bundle = await llamar('get_role_prompt', { role: 'developer', phase: 'change-note' });

    expect(bundle.ok).toBe(true);
    const data = bundle.data as { templates: { id: string }[] };
    expect(data.templates.map((t) => t.id)).toContain('change-note-template');
  });

  it('las gates de entrega siguen puestas: QA no la firma quien implementó', async () => {
    const { store, llamar } = armar();
    const abierto = await llamar('start_flow', {
      project: 'platform',
      title: 'Otro fix',
      initiative_type: 'fix',
    });
    const flowId = (abierto.data as { flow_id: string }).flow_id;
    await llamar('submit_change_note', { flow_id: flowId, change_note_markdown: NOTA, stories: [STORY] });
    const story = (await store.listStoriesByFlow(flowId))[0]!;
    await llamar('claim_story', { story_id: story.story_id, developer_id: 'nico' });
    await llamar('report_progress', {
      story_id: story.story_id,
      developer_id: 'nico',
      status: 'in_review',
      pr_url: 'https://github.com/nigavazquez/sdlc-mcp/pull/42',
    });

    // El mismo usuario que implementó, ahora con rol qa: el track liviano no toca esto.
    const nicoQa = testCtx({ tenantId: 'default', userId: 'nico', roles: ['qa'], workspaces: ['platform'] });
    const firma = await llamar('submit_qa_results', { story_id: story.story_id, verdict: 'passed', results: [] }, nicoQa);

    expect(firma.ok).toBe(false);
    expect(firma.error).toContain('no puede firmar la verificación de su propio trabajo');
  });
});

describe('track liviano — los dos controles', () => {
  it('control negativo: una feature no entra por la puerta chica', async () => {
    const { store, llamar } = armar();
    const abierto = await llamar(
      'start_flow',
      { project: 'platform', title: 'Iniciativa grande', initiative_type: 'feature' },
      PM,
    );
    const flowId = (abierto.data as { flow_id: string }).flow_id;

    const nota = await llamar('submit_change_note', {
      flow_id: flowId,
      change_note_markdown: NOTA,
      stories: [STORY],
    });

    expect(nota.ok).toBe(false);
    expect(nota.error).toContain('submit_prd');
    expect((await store.getFlow(flowId))?.status).toBe('draft');
  });

  it('control de escalada: un fix que resultó grande se va por submit_prd', async () => {
    const { store, llamar } = armar();
    const abierto = await llamar('start_flow', {
      project: 'platform',
      title: 'Parecía chico',
      initiative_type: 'fix',
    });
    const flowId = (abierto.data as { flow_id: string }).flow_id;

    const prd = [
      '# PRD', '', '## Problema', 'p', '', '## Usuarios', 'u', 'u2', '',
      '## Métricas de éxito', 'm', 'm2', 'm3', '', '## Alcance', 'a', 'a2', '',
      '## Fuera de alcance', 'f', 'f2', '', '## Riesgos', 'r', 'r2', 'r3', '',
    ].join('\n');
    const enviado = await llamar('submit_prd', { flow_id: flowId, prd_markdown: prd }, PM);

    expect(enviado.ok).toBe(true);
    expect((await store.getFlow(flowId))?.status).toBe('prd_ready');
  });
});
