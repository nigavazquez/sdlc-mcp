import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { Catalog } from '@sdlc/catalog';
import { InMemoryFlowStore } from '../src/state/in-memory.js';
import { InMemoryTaskSystemAdapter } from '../src/adapters/in-memory-task-system.js';
import { ConfigBackedTaskSystemProvider } from '../src/adapters/task-system-provider.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import { buildToolRegistry } from '../src/mcp/tools/index.js';

/**
 * Las descripciones de las tools las lee el cliente MCP para decidir cuándo
 * llamarlas: si hablan de "squad" mienten sobre el modelo (workspaces) y sobre el
 * nombre del claim del JWT. Mismo espíritu que el guard de catalog.smoke.test.ts.
 *
 * El vocabulario visible es configurable vía `labels`, así que la descripción usa
 * el término del dominio (workspace), no el label de ninguna organización.
 */
async function makeRegistry() {
  const catalog = await Catalog.load(resolve(__dirname, '../../../packages/catalog'));
  const taskSystemProvider = new ConfigBackedTaskSystemProvider({
    configStore: new InMemoryIntegrationConfigStore(),
    inMemory: new InMemoryTaskSystemAdapter(),
  });
  return buildToolRegistry({ catalog, store: new InMemoryFlowStore(), taskSystemProvider });
}

describe('vocabulario de las descripciones de tools', () => {
  it('ninguna descripción habla de squads (el eje del modelo es workspace)', async () => {
    const registry = await makeRegistry();

    const offenders = registry
      .list()
      .filter((t) => /squad|tribu/i.test(t.description))
      .map((t) => t.name);

    expect(offenders).toEqual([]);
  });

  it('start_flow explica que project es el workspace_id', async () => {
    const registry = await makeRegistry();

    const startFlow = registry.get('start_flow');

    expect(startFlow?.description).toContain('workspace_id');
  });
});
