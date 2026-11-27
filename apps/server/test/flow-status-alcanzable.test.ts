import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Catalog } from '@sdlc/catalog';
import { FlowStatus } from '@sdlc/core';
import { InMemoryFlowStore } from '../src/state/index.js';
import { InMemoryTaskSystemAdapter, ConfigBackedTaskSystemProvider } from '../src/adapters/index.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import { buildToolRegistry } from '../src/mcp/tools/index.js';

const CATALOG_ROOT = resolve(__dirname, '../../../packages/catalog');

/**
 * Todo valor de `FlowStatus` tiene que tener quién lo escriba.
 *
 * Dos veces ya tuvimos un estado en el enum que ninguna tool producía: `aborted`
 * hasta que se escribió `abort_flow` —un flow abandonado se quedaba para siempre en
 * la fase donde murió— y `qa_passed`, que salió al documentar el flujo y resultó ser
 * el status de la **story**, colado en el enum del flow. Un valor legal e inalcanzable
 * no rompe nada: miente. Aparece en la documentación, en los tipos y en el panel como
 * si fuera un estado por el que un flow pasa, y nadie se entera hasta que alguien
 * intenta esperarlo.
 *
 * La tabla no prueba comportamiento —de eso se ocupan las suites de cada tool— sino
 * completitud: agregar un estado sin decir quién lo escribe no compila, y borrar la
 * tool que lo escribía deja el caso en rojo.
 */
const ESCRITO_POR: Record<FlowStatus, string[]> = {
  draft: ['start_flow'],
  prd_in_review: [],
  prd_ready: ['submit_prd'],
  rfc_in_review: [],
  rfc_ready: ['submit_rfc'],
  // Dos caminos: el shaping del track completo y la nota de cambio del liviano.
  backlog_ready: ['sync_backlog', 'submit_change_note'],
  impl_in_review: ['request_code_review', 'submit_review_outcome'],
  // Lo escribe `closeFlowIfSettled`, al que llegan estas dos: aprobar la última
  // story y descartar la última pendiente.
  merged: ['submit_review_outcome', 'discard_story'],
  aborted: ['abort_flow'],
};

/**
 * Estados que ya están en el enum y todavía no escribe nadie, con la historia que
 * los va a escribir. Es una excepción con dueño, no un hueco: la lista tiene que
 * estar vacía para cerrar la épica, y un estado no puede estar acá y tener tools
 * a la vez (el que agregue el escritor tiene que sacarlo de esta lista).
 */
const PENDIENTE: Partial<Record<FlowStatus, string>> = {
  prd_in_review: 'A2 (#67): submit_prd deja el PRD en revisión',
  rfc_in_review: 'A2 (#67): submit_rfc deja el RFC en revisión',
};

describe('todo FlowStatus es alcanzable', () => {
  it('un estado pendiente no declara tools, y uno con tools no queda pendiente', () => {
    for (const status of Object.keys(PENDIENTE) as FlowStatus[]) {
      expect(ESCRITO_POR[status], `${status} ya tiene escritor: sacalo de PENDIENTE`).toEqual([]);
    }
  });

  it('la tabla cubre exactamente el enum', () => {
    expect(Object.keys(ESCRITO_POR).sort()).toEqual([...FlowStatus.options].sort());
  });

  it('cada tool nombrada existe en el registry', async () => {
    const catalog = await Catalog.load(CATALOG_ROOT);
    const registry = buildToolRegistry({
      catalog,
      store: new InMemoryFlowStore(),
      taskSystemProvider: new ConfigBackedTaskSystemProvider({
        configStore: new InMemoryIntegrationConfigStore(),
        inMemory: new InMemoryTaskSystemAdapter(),
      }),
    });
    const registradas = new Set(registry.list().map((t) => t.name));

    for (const [status, tools] of Object.entries(ESCRITO_POR)) {
      if (PENDIENTE[status as FlowStatus]) continue;
      expect(tools.length, `${status} no declara quién lo escribe`).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(registradas.has(tool), `${status} dice escribirse desde ${tool}, que no está registrada`).toBe(true);
      }
    }
  });
});
