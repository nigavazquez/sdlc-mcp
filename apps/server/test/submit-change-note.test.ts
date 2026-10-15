import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Catalog } from '@sdlc/catalog';
import type { TaskSystemAdapter } from '@sdlc/adapters-contracts';
import { InMemoryFlowStore } from '../src/state/index.js';
import { InMemoryTaskSystemAdapter, ConfigBackedTaskSystemProvider } from '../src/adapters/index.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import { buildToolRegistry } from '../src/mcp/tools/index.js';
import { testCtx } from './helpers/tenant-ctx.js';
import { NOTA_OK as NOTA, STORY_OK as STORY, conRepro } from './helpers/change-note.js';

const CATALOG_ROOT = resolve(__dirname, '../../../packages/catalog');

// El ctx es `developer` a propósito: el punto del track liviano es que quien encuentra
// el bug pueda abrirlo y describirlo sin ir a buscar un pmo.
const DEV = testCtx({ tenantId: 'default', userId: 'nico', roles: ['developer'], workspaces: ['platform'] });
const TL = testCtx({ tenantId: 'default', userId: 'lee', roles: ['tech-lead'], workspaces: ['platform'] });

/** Cuenta las llamadas a createEpic sin cambiar el comportamiento del adapter. */
function contandoEpics(inner: TaskSystemAdapter) {
  const contador = { epics: 0 };
  const spy: TaskSystemAdapter = {
    ...inner,
    kind: inner.kind,
    createEpic: (...args: Parameters<TaskSystemAdapter['createEpic']>) => {
      contador.epics += 1;
      return inner.createEpic(...args);
    },
    createStory: (...args: Parameters<TaskSystemAdapter['createStory']>) => inner.createStory(...args),
    createSubtask: (...args: Parameters<TaskSystemAdapter['createSubtask']>) => inner.createSubtask(...args),
    linkChildToParent: (...args: Parameters<TaskSystemAdapter['linkChildToParent']>) =>
      inner.linkChildToParent(...args),
    getItem: (...args: Parameters<TaskSystemAdapter['getItem']>) => inner.getItem(...args),
    transition: (...args: Parameters<TaskSystemAdapter['transition']>) => inner.transition(...args),
    search: (...args: Parameters<TaskSystemAdapter['search']>) => inner.search(...args),
  };
  return { spy, contador };
}

async function armar(opts: { taskSystem?: TaskSystemAdapter } = {}) {
  const store = new InMemoryFlowStore();
  const catalog = await Catalog.load(CATALOG_ROOT);
  const registry = buildToolRegistry({
    catalog,
    store,
    taskSystemProvider: new ConfigBackedTaskSystemProvider({
      configStore: new InMemoryIntegrationConfigStore(),
      inMemory: opts.taskSystem ?? new InMemoryTaskSystemAdapter(),
    }),
  });
  return { store, registry };
}

/** Crea un flow directo en el store, sin pasar por start_flow. */
async function flowEn(store: InMemoryFlowStore, initiative_type: 'fix' | 'feature') {
  return store.createFlow({
    tenant_id: 'default',
    project: 'platform',
    slug: `nota-${initiative_type}`,
    title: 'El claim de workspaces no llega en el refresh',
    initiative_type,
  });
}

type Resultado = { ok: boolean; error?: string; data?: Record<string, unknown> };

describe('submit_change_note — guardas', () => {
  it('un flow de otro workspace se rechaza sin decir si existe', async () => {
    const { registry } = await armar();
    const tool = registry.get('submit_change_note')!;

    const res = (await tool.handler(
      { flow_id: 'default:ajeno:no-existe', change_note_markdown: NOTA, stories: [STORY] } as never,
      DEV,
    )) as Resultado;

    expect(res.ok).toBe(false);
    expect(res.error).toContain('No tenés acceso al workspace "ajeno"');
  });

  it('sin rol no pasa', async () => {
    const { store, registry } = await armar();
    const flow = await flowEn(store, 'fix');
    const qa = testCtx({ tenantId: 'default', userId: 'ana', roles: ['qa'], workspaces: ['platform'] });

    const res = (await registry.get('submit_change_note')!.handler(
      { flow_id: flow.flow_id, change_note_markdown: NOTA, stories: [STORY] } as never,
      qa,
    )) as Resultado;

    expect(res.ok).toBe(false);
    expect(res.error).toContain('submit_change_note requiere rol');
  });

  it('un flow del track completo se rechaza y se lo manda a submit_prd', async () => {
    const { store, registry } = await armar();
    const flow = await flowEn(store, 'feature');

    const res = (await registry.get('submit_change_note')!.handler(
      { flow_id: flow.flow_id, change_note_markdown: NOTA, stories: [STORY] } as never,
      TL,
    )) as Resultado;

    expect(res.ok).toBe(false);
    expect(res.error).toContain('submit_prd');
    // No se degrada una feature a nota de cambio: ese sería el agujero.
    expect((await store.getFlow(flow.flow_id))?.status).toBe('draft');
  });

  it('un flow que ya salió de draft se rechaza', async () => {
    const { store, registry } = await armar();
    const flow = await flowEn(store, 'fix');
    await store.updateFlowStatus(flow.flow_id, { status: 'backlog_ready', current_phase: 'implementation' }, []);

    const res = (await registry.get('submit_change_note')!.handler(
      { flow_id: flow.flow_id, change_note_markdown: NOTA, stories: [STORY] } as never,
      DEV,
    )) as Resultado;

    expect(res.ok).toBe(false);
    expect(res.error).toContain('backlog_ready');
  });

  it('una nota sin repro ni no_repro no escribe nada, ni el evento', async () => {
    const { store, registry } = await armar();
    const flow = await flowEn(store, 'fix');

    const res = (await registry.get('submit_change_note')!.handler(
      { flow_id: flow.flow_id, change_note_markdown: conRepro(''), stories: [STORY] } as never,
      DEV,
    )) as Resultado;

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no_repro/);
    expect((await store.getFlow(flow.flow_id))?.status).toBe('draft');
    expect((await store.listEvents(flow.flow_id)).some((e) => e.type === 'change_note.submitted')).toBe(false);
  });
});

describe('submit_change_note — la validación corre antes de escribir', () => {
  it('una nota sin la sección de evidencia no escribe nada', async () => {
    const { store, registry } = await armar();
    const flow = await flowEn(store, 'fix');
    const sinEvidencia = NOTA.replace(/## Cómo lo sé[\s\S]*?(?=## Qué cambio)/, '');

    const res = (await registry.get('submit_change_note')!.handler(
      { flow_id: flow.flow_id, change_note_markdown: sinEvidencia, stories: [STORY] } as never,
      DEV,
    )) as Resultado;

    expect(res.ok).toBe(false);
    const despues = await store.getFlow(flow.flow_id);
    expect(despues?.status).toBe('draft');
    expect(despues?.change_note_ref).toBeUndefined();
    expect(despues?.epic_external_id).toBeUndefined();
    expect(await store.listStoriesByFlow(flow.flow_id)).toEqual([]);
  });

  it('una nota sin repo declarado no escribe nada', async () => {
    const { store, registry } = await armar();
    const flow = await flowEn(store, 'fix');

    const res = (await registry.get('submit_change_note')!.handler(
      {
        flow_id: flow.flow_id,
        change_note_markdown: NOTA.replace(/^repo:.*\n/m, ''),
        stories: [STORY],
      } as never,
      DEV,
    )) as Resultado;

    expect(res.ok).toBe(false);
    expect((await store.getFlow(flow.flow_id))?.status).toBe('draft');
  });
});

describe('submit_change_note — el camino feliz', () => {
  it('deja el flow listo para implementar en una sola llamada', async () => {
    const { store, registry } = await armar();
    const flow = await flowEn(store, 'fix');

    const res = (await registry.get('submit_change_note')!.handler(
      { flow_id: flow.flow_id, change_note_markdown: NOTA, stories: [STORY] } as never,
      DEV,
    )) as Resultado;

    expect(res.ok).toBe(true);

    const despues = (await store.getFlow(flow.flow_id))!;
    expect(despues.status).toBe('backlog_ready');
    expect(despues.current_phase).toBe('implementation');
    // Referencia y sha256, nunca el cuerpo.
    expect(despues.change_note_ref?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(despues.prd_ref).toBeUndefined();
    expect(despues.rfc_ref).toBeUndefined();
    expect(despues.components).toEqual([{ name: 'sdlc-mcp', kind: 'app', repo: 'acme/sdlc-mcp' }]);
    expect(despues.epic_external_id).toBeTruthy();

    const stories = await store.listStoriesByFlow(flow.flow_id);
    expect(stories).toHaveLength(1);
    expect(stories[0]!.status).toBe('created');
    // El repo viaja a la story: es la mitad temprana del gate de code review.
    expect(stories[0]!.target_repo).toBe('acme/sdlc-mcp');
  });

  it('la story queda reclamable: de start_flow a claim_story en dos llamadas', async () => {
    const { store, registry } = await armar();
    const flow = await flowEn(store, 'fix');
    await registry.get('submit_change_note')!.handler(
      { flow_id: flow.flow_id, change_note_markdown: NOTA, stories: [STORY] } as never,
      DEV,
    );
    const story = (await store.listStoriesByFlow(flow.flow_id))[0]!;

    const res = (await registry.get('claim_story')!.handler(
      { story_id: story.story_id, developer_id: 'nico' } as never,
      DEV,
    )) as Resultado;

    expect(res.ok).toBe(true);
    expect((await store.getStory(story.story_id))?.status).toBe('claimed');
  });

  it('deja el evento con el sha256', async () => {
    const { store, registry } = await armar();
    const flow = await flowEn(store, 'fix');
    await registry.get('submit_change_note')!.handler(
      { flow_id: flow.flow_id, change_note_markdown: NOTA, stories: [STORY] } as never,
      DEV,
    );

    const eventos = await store.listEvents(flow.flow_id);
    const nota = eventos.find((e) => e.type === 'change_note.submitted');
    expect(nota).toBeTruthy();
    expect(nota!.actor).toBe('nico');
  });

  it('el evento lleva la declaración de repro, que es lo que permite medir si el campo sirve', async () => {
    const { store, registry } = await armar();
    const flow = await flowEn(store, 'fix');
    await registry.get('submit_change_note')!.handler(
      { flow_id: flow.flow_id, change_note_markdown: NOTA, stories: [STORY] } as never,
      DEV,
    );

    const nota = (await store.listEvents(flow.flow_id)).find((e) => e.type === 'change_note.submitted');
    expect(nota!.payload.repro).toEqual({
      kind: 'repro',
      value: 'pnpm --filter @sdlc/server test -- -t "refresh sin workspaces"',
    });
  });

  it('con no_repro, el evento lo registra igual', async () => {
    const { store, registry } = await armar();
    const flow = await flowEn(store, 'fix');
    await registry.get('submit_change_note')!.handler(
      {
        flow_id: flow.flow_id,
        change_note_markdown: conRepro('no_repro: sólo pasa con datos de prod'),
        stories: [STORY],
      } as never,
      DEV,
    );

    const nota = (await store.listEvents(flow.flow_id)).find((e) => e.type === 'change_note.submitted');
    expect(nota!.payload.repro).toEqual({ kind: 'no_repro', value: 'sólo pasa con datos de prod' });
  });
});

describe('submit_change_note — reintento tras una falla parcial', () => {
  it('no crea un segundo epic si el flow ya tiene uno', async () => {
    const { spy, contador } = contandoEpics(new InMemoryTaskSystemAdapter());
    const { store, registry } = await armar({ taskSystem: spy });
    const flow = await flowEn(store, 'fix');
    // El estado que deja una falla entre crear el epic y avanzar el flow: epic
    // creado y persistido, flow todavía en draft.
    await store.updateFlow(flow.flow_id, { epic_external_id: 'EPIC-YA-CREADO' });

    const res = (await registry.get('submit_change_note')!.handler(
      { flow_id: flow.flow_id, change_note_markdown: NOTA, stories: [STORY] } as never,
      DEV,
    )) as Resultado;

    expect(res.ok).toBe(true);
    expect(contador.epics).toBe(0);
    expect((await store.getFlow(flow.flow_id))?.epic_external_id).toBe('EPIC-YA-CREADO');
  });
});

describe('submit_change_note — la escalada sigue abierta', () => {
  it('un flow lite que resultó grande puede irse por submit_prd', async () => {
    const { store, registry } = await armar();
    const flow = await flowEn(store, 'fix');
    const pm = testCtx({ tenantId: 'default', userId: 'ana', roles: ['product-manager'], workspaces: ['platform'] });

    const prd = `# PRD\n\n## Problema\np\n\n## Usuarios\nu\nu2\n\n## Métricas de éxito\nm\nm2\nm3\n\n## Alcance\na\na2\n\n## Fuera de alcance\nf\nf2\n\n## Riesgos\nr\nr2\nr3\n`;
    const res = (await registry.get('submit_prd')!.handler(
      { flow_id: flow.flow_id, prd_markdown: prd } as never,
      pm,
    )) as Resultado;

    expect(res.ok).toBe(true);
    expect((await store.getFlow(flow.flow_id))?.status).toBe('prd_ready');
  });
});

describe('submit_change_note — los criterios de aceptación tienen que decir algo', () => {
  it('una story con un criterio en TBD no crea nada', async () => {
    const { store, registry } = await armar();
    const flow = await flowEn(store, 'fix');

    const res = (await registry.get('submit_change_note')!.handler(
      {
        flow_id: flow.flow_id,
        change_note_markdown: NOTA,
        stories: [{ ...STORY, acceptance_criteria: ['El token trae workspaces', 'TBD'] }],
      } as never,
      DEV,
    )) as Resultado;

    expect(res.ok).toBe(false);
    expect(res.error).toContain('sin contenido');
    // Nada escrito: la admisión corre antes de los side-effects.
    expect((await store.getFlow(flow.flow_id))?.status).toBe('draft');
    expect(await store.listStoriesByFlow(flow.flow_id)).toEqual([]);
  });
});
