import { describe, expect, it } from 'vitest';
import { workspaceFromResourceId, resolveFlowForCtx, resolveStoryForCtx } from '../src/mcp/tools/flow-access.js';
import { testCtx } from './helpers/tenant-ctx.js';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import type { FlowStore } from '../src/state/index.js';

const ctx = testCtx({ tenantId: 't1', workspaces: ['platform'] });

describe('workspaceFromResourceId', () => {
  it('flow_id del tenant propio: devuelve el segmento del workspace', () => {
    expect(workspaceFromResourceId(ctx, 't1:platform:checkout')).toEqual({
      kind: 'ok',
      workspaceId: 'platform',
    });
  });

  it('story_id: el workspace sale igual, el sufijo :: es ruido', () => {
    expect(workspaceFromResourceId(ctx, 't1:platform:checkout::AB-123')).toEqual({
      kind: 'ok',
      workspaceId: 'platform',
    });
  });

  it('otro tenant: no se intenta adivinar el workspace', () => {
    expect(workspaceFromResourceId(ctx, 'otro:platform:checkout')).toEqual({
      kind: 'other-tenant',
    });
  });

  it('id sin separador: no direccionable, no "otro tenant"', () => {
    // Un typo no es un id ajeno. Decirle "otro tenant" a quien se equivocó tipeando
    // lo manda a investigar en la dirección equivocada.
    expect(workspaceFromResourceId(ctx, 'abc')).toEqual({ kind: 'unaddressable' });
  });

  it('prefijo correcto pero sin workspace: no direccionable', () => {
    expect(workspaceFromResourceId(ctx, 't1:')).toEqual({ kind: 'unaddressable' });
  });

  it('un tenantId con ":" adentro no rompe el parseo', () => {
    // El caso que rompe un split(':')[1] ingenuo: `tenantId` viene de TENANT_ID como
    // z.string().default('default'), SIN restricción de charset. Del otro lado el
    // parseo sí es seguro: workspace_id está validado ^[a-z0-9_-]+$ en la ruta admin
    // y slugify sólo produce [a-z0-9-], así que ninguno puede contener ":".
    const raro = testCtx({ tenantId: 'a:b', workspaces: ['platform'] });
    expect(workspaceFromResourceId(raro, 'a:b:platform:checkout')).toEqual({
      kind: 'ok',
      workspaceId: 'platform',
    });
  });

  it('un tenant que es prefijo de otro no se confunde', () => {
    // "t1" no debe matchear "t10:...": el separador es parte del prefijo.
    expect(workspaceFromResourceId(ctx, 't10:platform:checkout')).toEqual({
      kind: 'other-tenant',
    });
  });
});

async function seedFlow(store: InMemoryFlowStore, project = 'platform') {
  return store.createFlow({
    tenant_id: 't1',
    project,
    slug: 'checkout',
    title: 'Checkout',
  });
}

/**
 * Store que explota al leer. Es lo que prueba que el gate temprano corre ANTES del
 * `getFlow`: si alguien mueve el chequeo de membresía debajo de la lectura, estos
 * tests fallan con el mensaje de abajo en vez de con el de la guarda.
 *
 * El mensaje no tiene ni una palabra del vocabulario del dominio a propósito: si
 * dijera "workspace" o "acceso", una aserción escrita como /workspace/i pasaría por
 * el motivo equivocado.
 */
const explodingStore = {
  getFlow: async () => { throw new Error('PROBE_SHOULD_NOT_READ'); },
  getStory: async () => { throw new Error('PROBE_SHOULD_NOT_READ'); },
} as unknown as FlowStore;

describe('resolveFlowForCtx', () => {
  it('camino feliz: devuelve el flow', async () => {
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store);

    const res = await resolveFlowForCtx(store, ctx, flow.flow_id);

    expect(res.ok).toBe(true);
    expect(res.ok && res.flow.flow_id).toBe(flow.flow_id);
  });

  it('otro tenant: rechaza sin leer el store', async () => {
    const res = await resolveFlowForCtx(explodingStore, ctx, 'otro:platform:checkout');

    expect(res).toEqual({ ok: false, error: 'Flow belongs to a different tenant' });
  });

  it('id no direccionable: "no existe", sin leer el store', async () => {
    const res = await resolveFlowForCtx(explodingStore, ctx, 'abc');

    expect(res).toEqual({ ok: false, error: 'Unknown flow: abc' });
  });

  it('sin membresía en el workspace del id: rechaza sin leer el store', async () => {
    const res = await resolveFlowForCtx(explodingStore, ctx, 't1:ajeno:checkout');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain('No tenés acceso al workspace "ajeno"');
  });

  it('miembro, flow inexistente: "no existe"', async () => {
    const store = new InMemoryFlowStore();

    const res = await resolveFlowForCtx(store, ctx, 't1:platform:no-existe');

    expect(res).toEqual({ ok: false, error: 'Unknown flow: t1:platform:no-existe' });
  });

  it('EL PUNTO DEL CAMBIO: para un no-miembro, existir o no da la misma respuesta', async () => {
    // Es la aserción que le da sentido a todo el helper. Antes, un flow ajeno que
    // existía devolvía el error de acceso y uno inexistente devolvía "Unknown flow":
    // un bit por llamada, suficiente para mapear qué iniciativas tiene otro equipo
    // probando slugs.
    const store = new InMemoryFlowStore();
    await seedFlow(store, 'ajeno');

    const existe = await resolveFlowForCtx(store, ctx, 't1:ajeno:checkout');
    const noExiste = await resolveFlowForCtx(store, ctx, 't1:ajeno:no-existe');

    expect(existe.ok).toBe(false);
    expect(noExiste.ok).toBe(false);
    expect(existe.ok === false && existe.error).toBe(noExiste.ok === false && noExiste.error);
  });

  it('backstop: un flow cuyo project contradice al id se rechaza igual', async () => {
    // El parseo es una heurística sobre un string que manda el caller; la autoridad
    // es el record. Este caso no debería existir —`project` no está en
    // UpdateFlowInput, así que el segmento no puede driftear— pero si algún día el
    // flow_id deja de derivarse de (tenant, project, slug), el paso final es lo que
    // hace que falle cerrado en vez de autorizar mirando el lugar equivocado.
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, 'platform');
    const mentiroso = {
      getFlow: async () => ({ ...flow, project: 'ajeno' }),
    } as unknown as FlowStore;

    const res = await resolveFlowForCtx(mentiroso, ctx, 't1:platform:checkout');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain('No tenés acceso al workspace "ajeno"');
  });
});

async function seedStory(store: InMemoryFlowStore, project = 'platform') {
  const flow = await seedFlow(store, project);
  const story = await store.createStory({
    flow_id: flow.flow_id,
    external_id: 'AB-1',
    external_url: 'https://dev.azure.com/acme/p/_workitems/edit/1',
    title: 'Implementar',
    acceptance_criteria: ['anda'],
  });
  return { flow, story };
}

describe('resolveStoryForCtx', () => {
  it('camino feliz: devuelve la story y su flow', async () => {
    const store = new InMemoryFlowStore();
    const { flow, story } = await seedStory(store);

    const res = await resolveStoryForCtx(store, ctx, story.story_id);

    expect(res.ok).toBe(true);
    expect(res.ok && res.story.story_id).toBe(story.story_id);
    // Devuelve las dos entidades porque los nueve callers usan las dos: la story para
    // su status y su assignee, el flow para el workspace y el status del flow.
    expect(res.ok && res.flow.flow_id).toBe(flow.flow_id);
  });

  it('sin membresía: rechaza sin leer el store', async () => {
    const res = await resolveStoryForCtx(explodingStore, ctx, 't1:ajeno:checkout::AB-1');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain('No tenés acceso al workspace "ajeno"');
  });

  it('el sustantivo es el del recurso pedido: "Unknown story", no "Unknown flow"', async () => {
    // Decir "Unknown flow" sobre un story_id manda a buscar el recurso equivocado.
    const store = new InMemoryFlowStore();

    const res = await resolveStoryForCtx(store, ctx, 't1:platform:checkout::NO-EXISTE');

    expect(res).toEqual({
      ok: false,
      error: 'Unknown story: t1:platform:checkout::NO-EXISTE',
    });
  });

  it('id de story no direccionable: "Unknown story"', async () => {
    const res = await resolveStoryForCtx(explodingStore, ctx, 'abc');

    expect(res).toEqual({ ok: false, error: 'Unknown story: abc' });
  });

  it('story huérfana: nombra el flow que falta', async () => {
    const store = new InMemoryFlowStore();
    const { story } = await seedStory(store);
    const huerfana = {
      getStory: async () => ({ ...story, flow_id: 't1:platform:borrado' }),
      getFlow: async () => undefined,
    } as unknown as FlowStore;

    const res = await resolveStoryForCtx(huerfana, ctx, story.story_id);

    expect(res).toEqual({ ok: false, error: 'Unknown flow: t1:platform:borrado' });
  });

  it('para un no-miembro, existir o no da la misma respuesta', async () => {
    const store = new InMemoryFlowStore();
    const { story } = await seedStory(store, 'ajeno');

    const existe = await resolveStoryForCtx(store, ctx, story.story_id);
    const noExiste = await resolveStoryForCtx(store, ctx, 't1:ajeno:checkout::NO-EXISTE');

    expect(existe.ok).toBe(false);
    expect(existe.ok === false && existe.error).toBe(noExiste.ok === false && noExiste.error);
  });

  it('backstop: un flow cuyo project contradice al story_id se rechaza igual', async () => {
    // El story_id parsea a un workspace del que el ctx SÍ es miembro ("platform"), así
    // que el gate temprano (paso 4) lo deja pasar sin leer el store. La denegación
    // tiene que salir entonces del backstop (paso 6, dentro de la delegación a
    // resolveFlowForCtx): la story apunta a un flow_id de "platform", pero el record
    // que `getFlow` devuelve para ese id tiene `project: 'ajeno'`. Si alguien
    // reemplazara la delegación por un `getFlow` directo sin volver a pasar por
    // `assertFlowAccess`, este test fallaría: el flow ajeno se devolvería sin más.
    const store = new InMemoryFlowStore();
    const flow = await seedFlow(store, 'platform');
    const story = await store.createStory({
      flow_id: flow.flow_id,
      external_id: 'AB-1',
      external_url: 'https://dev.azure.com/acme/p/_workitems/edit/1',
      title: 'Implementar',
      acceptance_criteria: ['anda'],
    });
    const mentiroso = {
      getStory: async () => ({
        ...story,
        // La story apunta a un flow_id de un workspace donde el ctx SÍ es miembro,
        // para que el gate temprano no la frene y la denegación salga del backstop.
        flow_id: 't1:platform:otro',
      }),
      getFlow: async () => ({ ...flow, project: 'ajeno' }),
    } as unknown as FlowStore;

    const res = await resolveStoryForCtx(mentiroso, ctx, story.story_id);

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain('No tenés acceso al workspace "ajeno"');
  });
});
