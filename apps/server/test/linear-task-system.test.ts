/**
 * Seam bajo test: el contrato `TaskSystemAdapter` implementado por
 * LinearTaskSystemAdapter, con `fetch` stubbeado. Entra un tipo del contrato,
 * sale un tipo del contrato, y en el medio se observa la operación GraphQL que
 * el adapter manda. Ningún test toca un helper privado.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import {
  LinearApiError,
  LinearRateLimitError,
  LinearTaskSystemAdapter,
} from '../src/adapters/linear-task-system.js';

const BASE_OPTS = { apiKey: 'lin_api_secret', teamId: 'team-uuid' };

const ctx: TenantCtx = {
  tenantId: 't1',
  userId: 'u',
  roles: [],
  resolveSecret: async () => '',
};

interface GqlOp {
  query: string;
  variables: Record<string, unknown>;
}

/** Stub de fetch que responde según la operación GraphQL recibida. */
function gqlMock(respond: (op: GqlOp) => unknown, status = 200): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (_url: string, init: RequestInit) => {
    const op = JSON.parse(init.body as string) as GqlOp;
    return new Response(JSON.stringify(respond(op)), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', spy);
  return spy as unknown as ReturnType<typeof vi.fn>;
}

function issueCreated(id: string, identifier = 'ENG-1'): unknown {
  return {
    data: {
      issueCreate: {
        success: true,
        issue: { id, identifier, url: `https://linear.app/acme/issue/${identifier}` },
      },
    },
  };
}

function lastVariables(spy: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const calls = spy.mock.calls;
  const init = calls[calls.length - 1]![1] as RequestInit;
  return (JSON.parse(init.body as string) as GqlOp).variables;
}

// ---------------------------------------------------------------------------

describe('LinearTaskSystemAdapter — construcción y auth', () => {
  afterEach(() => vi.restoreAllMocks());

  it('falla si falta teamId', () => {
    expect(() => new LinearTaskSystemAdapter({ apiKey: 'k', teamId: '' })).toThrow(
      /missing required settings/,
    );
  });

  it('falla si falta la apiKey', () => {
    expect(() => new LinearTaskSystemAdapter({ apiKey: '', teamId: 't' })).toThrow(
      /missing required settings/,
    );
  });

  it('expone kind = linear', () => {
    expect(new LinearTaskSystemAdapter(BASE_OPTS).kind).toBe('linear');
  });

  it('manda una personal API key cruda en Authorization', async () => {
    const spy = gqlMock(() => issueCreated('i1'));
    const adapter = new LinearTaskSystemAdapter(BASE_OPTS);
    await adapter.createEpic({ project_key: 'p', title: 'T', description: 'D' }, ctx);
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('lin_api_secret');
  });

  it('manda un token OAuth con el esquema Bearer', async () => {
    const spy = gqlMock(() => issueCreated('i1'));
    const adapter = new LinearTaskSystemAdapter({ ...BASE_OPTS, apiKey: 'oauth-token' });
    await adapter.createEpic({ project_key: 'p', title: 'T', description: 'D' }, ctx);
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer oauth-token');
  });
});

describe('LinearTaskSystemAdapter — errores', () => {
  afterEach(() => vi.restoreAllMocks());

  it('tira LinearRateLimitError en HTTP 429', async () => {
    gqlMock(() => ({}), 429);
    const adapter = new LinearTaskSystemAdapter(BASE_OPTS);
    await expect(adapter.getItem('i1', ctx)).rejects.toBeInstanceOf(LinearRateLimitError);
  });

  it('tira LinearApiError en HTTP 401', async () => {
    gqlMock(() => ({}), 401);
    const adapter = new LinearTaskSystemAdapter(BASE_OPTS);
    await expect(adapter.getItem('i1', ctx)).rejects.toBeInstanceOf(LinearApiError);
  });

  it('tira LinearApiError cuando la respuesta 200 trae errors[]', async () => {
    gqlMock(() => ({ errors: [{ message: 'Entity not found: Issue' }] }));
    const adapter = new LinearTaskSystemAdapter(BASE_OPTS);
    await expect(adapter.getItem('i1', ctx)).rejects.toThrow(/Entity not found/);
  });
});

describe('LinearTaskSystemAdapter — createEpic', () => {
  afterEach(() => vi.restoreAllMocks());

  it('devuelve ExternalRef con el uuid del issue y su URL', async () => {
    gqlMock(() => issueCreated('uuid-42', 'ENG-42'));
    const adapter = new LinearTaskSystemAdapter(BASE_OPTS);
    const ref = await adapter.createEpic(
      { project_key: 'p', title: 'Mi epic', description: 'desc' },
      ctx,
    );
    expect(ref.external_id).toBe('uuid-42');
    expect(ref.url).toBe('https://linear.app/acme/issue/ENG-42');
  });

  it('crea el issue en el team de settings, sin parent', async () => {
    const spy = gqlMock(() => issueCreated('i1'));
    const adapter = new LinearTaskSystemAdapter(BASE_OPTS);
    await adapter.createEpic({ project_key: 'ignorado', title: 'T', description: 'D' }, ctx);
    const vars = lastVariables(spy).input as Record<string, unknown>;
    expect(vars.teamId).toBe('team-uuid');
    expect(vars.title).toBe('T');
    expect(vars.parentId).toBeUndefined();
  });

  it('adjunta el issue al projectId cuando está configurado', async () => {
    const spy = gqlMock(() => issueCreated('i1'));
    const adapter = new LinearTaskSystemAdapter({ ...BASE_OPTS, projectId: 'proj-uuid' });
    await adapter.createEpic({ project_key: 'p', title: 'T', description: 'D' }, ctx);
    const vars = lastVariables(spy).input as Record<string, unknown>;
    expect(vars.projectId).toBe('proj-uuid');
  });

  it('resuelve labels por nombre y crea las que faltan', async () => {
    const spy = gqlMock((op) => {
      if (op.query.includes('labels(')) {
        return { data: { team: { labels: { nodes: [{ id: 'l-front', name: 'frontend' }] } } } };
      }
      if (op.query.includes('issueLabelCreate')) {
        return { data: { issueLabelCreate: { success: true, issueLabel: { id: 'l-new', name: 'prio-1' } } } };
      }
      return issueCreated('i1');
    });
    const adapter = new LinearTaskSystemAdapter(BASE_OPTS);
    await adapter.createEpic(
      { project_key: 'p', title: 'T', description: 'D', labels: ['frontend', 'prio-1'] },
      ctx,
    );
    const vars = lastVariables(spy).input as Record<string, unknown>;
    expect(vars.labelIds).toEqual(['l-front', 'l-new']);
    // La query de labels del team se hace una sola vez y queda cacheada.
    const labelQueries = spy.mock.calls.filter((c) =>
      ((JSON.parse((c[1] as RequestInit).body as string) as GqlOp).query).includes('labels('),
    );
    expect(labelQueries).toHaveLength(1);
  });
});

describe('LinearTaskSystemAdapter — createStory / createSubtask', () => {
  afterEach(() => vi.restoreAllMocks());

  it('cuelga la story del epic y pasa el estimate', async () => {
    const spy = gqlMock(() => issueCreated('s1'));
    const adapter = new LinearTaskSystemAdapter(BASE_OPTS);
    await adapter.createStory(
      {
        project_key: 'p',
        epic_id: 'epic-uuid',
        title: 'Story',
        description: 'desc',
        acceptance_criteria: [],
        estimate: 3,
      },
      ctx,
    );
    const input = lastVariables(spy).input as Record<string, unknown>;
    expect(input.parentId).toBe('epic-uuid');
    expect(input.estimate).toBe(3);
  });

  it('serializa los criterios de aceptación como checklist en la descripción', async () => {
    const spy = gqlMock(() => issueCreated('s1'));
    const adapter = new LinearTaskSystemAdapter(BASE_OPTS);
    await adapter.createStory(
      {
        project_key: 'p',
        epic_id: 'e1',
        title: 'S',
        description: 'cuerpo',
        acceptance_criteria: ['AC1', 'AC2'],
      },
      ctx,
    );
    const input = lastVariables(spy).input as Record<string, unknown>;
    expect(input.description).toContain('cuerpo');
    expect(input.description).toContain('- [ ] AC1');
    expect(input.description).toContain('- [ ] AC2');
  });

  it('cuelga la subtask de la story', async () => {
    const spy = gqlMock(() => issueCreated('t1'));
    const adapter = new LinearTaskSystemAdapter(BASE_OPTS);
    await adapter.createSubtask(
      { project_key: 'p', parent_story_id: 'story-uuid', title: 'Task' },
      ctx,
    );
    const input = lastVariables(spy).input as Record<string, unknown>;
    expect(input.parentId).toBe('story-uuid');
  });
});

describe('LinearTaskSystemAdapter — linkChildToParent', () => {
  afterEach(() => vi.restoreAllMocks());

  it('actualiza el parentId del hijo', async () => {
    const spy = gqlMock(() => ({ data: { issueUpdate: { success: true } } }));
    const adapter = new LinearTaskSystemAdapter(BASE_OPTS);
    await adapter.linkChildToParent('padre', 'hijo', ctx);
    const vars = lastVariables(spy);
    expect(vars.id).toBe('hijo');
    expect((vars.input as Record<string, unknown>).parentId).toBe('padre');
  });
});

describe('LinearTaskSystemAdapter — getItem', () => {
  afterEach(() => vi.restoreAllMocks());

  function issue(overrides: Record<string, unknown> = {}): unknown {
    return {
      data: {
        issue: {
          id: 'i1',
          identifier: 'ENG-7',
          url: 'https://linear.app/acme/issue/ENG-7',
          title: 'Título',
          description: 'cuerpo',
          state: { name: 'In Progress' },
          labels: { nodes: [{ name: 'frontend' }] },
          parent: null,
          ...overrides,
        },
      },
    };
  }

  it('mapea el estado de Linear al status del contrato', async () => {
    gqlMock(() => issue());
    const adapter = new LinearTaskSystemAdapter(BASE_OPTS);
    const item = await adapter.getItem('i1', ctx);
    expect(item.status).toBe('In Progress');
    expect(item.title).toBe('Título');
    expect(item.labels).toEqual(['frontend']);
    expect(item.url).toBe('https://linear.app/acme/issue/ENG-7');
  });

  it('un issue sin padre es un epic', async () => {
    gqlMock(() => issue({ parent: null }));
    const adapter = new LinearTaskSystemAdapter(BASE_OPTS);
    expect((await adapter.getItem('i1', ctx)).type).toBe('epic');
  });

  it('un issue con padre sin abuelo es una story', async () => {
    gqlMock(() => issue({ parent: { id: 'p1', parent: null } }));
    const adapter = new LinearTaskSystemAdapter(BASE_OPTS);
    const item = await adapter.getItem('i1', ctx);
    expect(item.type).toBe('story');
    expect(item.parent_id).toBe('p1');
  });

  it('un issue con abuelo es una subtask', async () => {
    gqlMock(() => issue({ parent: { id: 'p1', parent: { id: 'g1' } } }));
    const adapter = new LinearTaskSystemAdapter(BASE_OPTS);
    expect((await adapter.getItem('i1', ctx)).type).toBe('subtask');
  });
});

describe('LinearTaskSystemAdapter — transition', () => {
  afterEach(() => vi.restoreAllMocks());

  const states = {
    data: {
      team: {
        states: {
          nodes: [
            { id: 'st-prog', name: 'In Progress' },
            { id: 'st-done', name: 'Done' },
            { id: 'st-cancel', name: 'Canceled' },
          ],
        },
      },
    },
  };

  it('traduce el vocabulario del server al workflow state de Linear', async () => {
    const spy = gqlMock((op) =>
      op.query.includes('states(') ? states : { data: { issueUpdate: { success: true } } },
    );
    const adapter = new LinearTaskSystemAdapter(BASE_OPTS);
    await adapter.transition('i1', 'Closed', ctx);
    const vars = lastVariables(spy);
    expect((vars.input as Record<string, unknown>).stateId).toBe('st-done');
  });

  it('respeta el stateMap configurado por el operador', async () => {
    const spy = gqlMock((op) =>
      op.query.includes('states(') ? states : { data: { issueUpdate: { success: true } } },
    );
    const adapter = new LinearTaskSystemAdapter({
      ...BASE_OPTS,
      stateMap: { Closed: 'Canceled' },
    });
    await adapter.transition('i1', 'Closed', ctx);
    expect((lastVariables(spy).input as Record<string, unknown>).stateId).toBe('st-cancel');
  });

  it('falla explícito cuando el team no tiene ese estado, y lista los que sí', async () => {
    gqlMock((op) => (op.query.includes('states(') ? states : { data: {} }));
    const adapter = new LinearTaskSystemAdapter(BASE_OPTS);
    await expect(adapter.transition('i1', 'Resolved', ctx)).rejects.toThrow(
      /In Progress, Done, Canceled/,
    );
  });
});

describe('LinearTaskSystemAdapter — search', () => {
  afterEach(() => vi.restoreAllMocks());

  it('arma el filtro con team, estado, texto y parent', async () => {
    const spy = gqlMock(() => ({ data: { issues: { nodes: [] } } }));
    const adapter = new LinearTaskSystemAdapter(BASE_OPTS);
    await adapter.search({ status: 'Closed', text: 'pago', parent_id: 'p1', limit: 10 }, ctx);
    const vars = lastVariables(spy);
    expect(vars.first).toBe(10);
    expect(vars.filter).toEqual({
      team: { id: { eq: 'team-uuid' } },
      state: { name: { eq: 'Done' } },
      title: { contains: 'pago' },
      parent: { id: { eq: 'p1' } },
    });
  });

  it('mapea los nodos a TaskItem', async () => {
    gqlMock(() => ({
      data: {
        issues: {
          nodes: [
            {
              id: 'i1',
              identifier: 'ENG-1',
              url: 'https://linear.app/acme/issue/ENG-1',
              title: 'Uno',
              description: null,
              state: { name: 'Todo' },
              labels: { nodes: [] },
              parent: { id: 'p1', parent: null },
            },
          ],
        },
      },
    }));
    const adapter = new LinearTaskSystemAdapter(BASE_OPTS);
    const items = await adapter.search({}, ctx);
    expect(items).toHaveLength(1);
    expect(items[0]!.external_id).toBe('i1');
    expect(items[0]!.type).toBe('story');
    expect(items[0]!.description).toBe('');
  });
});
