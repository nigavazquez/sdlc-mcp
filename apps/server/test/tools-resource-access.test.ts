import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { Catalog } from '@sdlc/catalog';
import { buildToolRegistry } from '../src/mcp/tools/index.js';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { ConfigBackedTaskSystemProvider } from '../src/adapters/task-system-provider.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';
import { testCtx } from './helpers/tenant-ctx.js';

// Mismo patrón que abort-flow.test.ts:45 — `resolve(__dirname, ...)`, no `new URL()`.
const CATALOG_ROOT = resolve(__dirname, '../../../packages/catalog');

/**
 * Tools que resuelven un flow por `input.flow_id`.
 *
 * Límite de esta tabla: asume "una tool, un recurso". `link_subtasks` tiene además
 * `input.story_id`, pero ese campo nunca se ata a `input.flow_id` — va directo a
 * `taskSystem.createSubtask({parent_story_id})` como id *externo* del task system,
 * no como un recurso que este helper resuelva o autorice (el alcance ya queda dentro
 * del workspace del flow porque el adapter se resuelve por flow y usa
 * `project_key: flow.project`). Hoy no es un canal cruzado, pero si ese campo pasara
 * a ser un id interno, esta tabla no tendría forma de declarar la segunda entrada.
 */
const POR_FLOW_ID = [
  'abort_flow', 'create_epic', 'create_stories', 'generate_rfc_skeleton',
  'get_flow_state', 'get_role_prompt', 'link_subtasks', 'propose_breakdown',
  'submit_adr', 'submit_change_note', 'submit_prd', 'submit_rfc', 'sync_backlog',
  'validate_prd', 'validate_rfc', 'verify_artifact',
];

/** Tools que resuelven una story por `input.story_id` (y su flow). */
const POR_STORY_ID = [
  'block_story', 'claim_story', 'discard_story', 'generate_qa_plan',
  'get_implementation_context', 'report_progress', 'request_code_review',
  'submit_qa_results', 'submit_review_outcome',
];

/**
 * Las exentas, y por qué:
 *  - `whoami` y `list_roles` devuelven identidad y catálogo del servidor: no hay
 *    recurso que resolver ni workspace contra el cual chequear.
 *  - `start_flow` crea un flow nuevo. Filtra que un slug ya existe, pero su guarda de
 *    rol corre antes sobre `input.project`, así que sólo se entera de flows de un
 *    workspace donde ya tenés rol: no es un oráculo cruzado.
 */
const EXENTAS = ['whoami', 'list_roles', 'start_flow'];

function makeRegistry(catalog: Catalog) {
  return buildToolRegistry({
    catalog,
    store: new InMemoryFlowStore(),
    taskSystemProvider: new ConfigBackedTaskSystemProvider({
      configStore: new InMemoryIntegrationConfigStore(),
      inMemory: new InMemoryTaskSystemAdapter(),
    }),
  });
}

describe('toda tool del registry declara cómo resuelve su recurso', () => {
  it('cada tool está en una de las tres listas', async () => {
    // Esto es lo que hace que la tabla valga para las tools que se agreguen. El censo
    // NO se hace por substring sobre las fuentes: un `source.includes('resolveFlowForCtx(')`
    // pasa con el retorno ignorado, con la llamada comentada y con la llamada dentro de
    // un string — es la lección de la tanda 2, donde 8 de 12 evasiones pasaban el censo
    // por regex. Acá o la tool aparece en una lista y su caso corre de verdad contra un
    // recurso ajeno, o hay que declararla exenta, que es una afirmación que se lee y se
    // discute en el review.
    const catalog = await Catalog.load(CATALOG_ROOT);
    const registradas = makeRegistry(catalog).list().map((t) => t.name).sort();
    const cubiertas = [...POR_FLOW_ID, ...POR_STORY_ID, ...EXENTAS].sort();

    expect(registradas).toEqual(cubiertas);
  });

  it('las listas no declaran tools que no existen ni repiten', () => {
    // El otro lado: una entrada podrida (tool renombrada, typo) haría que el caso nunca
    // corriera y la cobertura fuera falsa.
    const todas = [...POR_FLOW_ID, ...POR_STORY_ID, ...EXENTAS];
    expect(new Set(todas).size).toBe(todas.length);
  });
});

describe('cada tool rutea por el helper de resolución y autorización', () => {
  // Un ctx que no es miembro de "ajeno". El claim va explícito: las guardas de
  // workspace no dejan pasar un ctx sin él.
  //
  // El store de `makeRegistry` está siempre vacío, así que estos casos sólo ejercitan
  // el lado inexistente (por eso el nombre habla de "rutea por el helper", no de
  // "responde igual que uno existente"). La comparación byte a byte de los dos
  // lados —ajeno-inexistente vs. ajeno-existente— ya la hace `flow-access.test.ts`
  // a nivel del helper (`resolveFlowForCtx`/`resolveStoryForCtx`); el trabajo de
  // este test es otro: probar que las 24 tools del registry, una por una, delegan
  // en ese helper en vez de resolver el recurso a mano.
  const ctx = testCtx({ tenantId: 'default', roles: ['tech-lead'], workspaces: ['propio'] });

  // `abort_flow`, `block_story` y `discard_story` tienen `reason` como campo
  // `z.string().min(1)` requerido en su schema, y sus handlers lo leen (`.trim()`)
  // antes de resolver el flow/story. Eso no reabre el canal que esta tabla existe
  // para cerrar: el invariante que Task 2-5 establecieron es "la guarda corre antes
  // de LEER EL RECURSO o de producir cualquier SIDE-EFFECT", no "antes de tocar
  // cualquier campo del input". Validar el propio input del caller no es ninguna de
  // las dos cosas — el error de "reason vacío" sale idéntico sin importar si el
  // flow/story existe o a qué workspace pertenece, así que no hay oráculo ahí. Y
  // como `reason` es requerido por el schema, el borde MCP (`inputSchema.parse` en
  // `mcp/server.ts` e `inputSchema.safeParse` en `index.ts`) ya lo exige antes de
  // que cualquier request real llegue al handler: un input sin `reason` no es un
  // caso que pueda ocurrir fuera de este test, que llama al handler directo. Por
  // eso estas tres pasan un `reason` no vacío además del id — no es un descuido,
  // es necesario para ejercitar la guarda de acceso en vez del chequeo de `reason`.
  const REASON_REQUERIDO = new Set(['abort_flow', 'block_story', 'discard_story']);

  for (const name of POR_FLOW_ID) {
    it(`${name}: rutea el flow_id por el helper (rechaza el ajeno, no filtra existencia)`, async () => {
      const catalog = await Catalog.load(CATALOG_ROOT);
      const registry = makeRegistry(catalog);
      const tool = registry.get(name)!;

      const input = REASON_REQUERIDO.has(name)
        ? { flow_id: 'default:ajeno:no-existe', reason: 'motivo de prueba' }
        : { flow_id: 'default:ajeno:no-existe' };
      const res = (await tool.handler(input as never, ctx)) as {
        ok: boolean;
        error?: string;
      };

      expect(res.ok).toBe(false);
      // No dice "Unknown": eso confirmaría que no existe, que es el bit que se cierra.
      expect(res.error).toContain('No tenés acceso al workspace "ajeno"');
    });
  }

  for (const name of POR_STORY_ID) {
    it(`${name}: rutea el story_id por el helper (rechaza la ajena, no filtra existencia)`, async () => {
      const catalog = await Catalog.load(CATALOG_ROOT);
      const registry = makeRegistry(catalog);
      const tool = registry.get(name)!;

      const input = REASON_REQUERIDO.has(name)
        ? { story_id: 'default:ajeno:flow::NO-EXISTE', reason: 'motivo de prueba' }
        : { story_id: 'default:ajeno:flow::NO-EXISTE' };
      const res = (await tool.handler(input as never, ctx)) as {
        ok: boolean;
        error?: string;
      };

      expect(res.ok).toBe(false);
      expect(res.error).toContain('No tenés acceso al workspace "ajeno"');
    });
  }
});
