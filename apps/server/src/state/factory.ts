import type { FastifyBaseLogger } from 'fastify';
import { InMemoryFlowStore } from './in-memory.js';
import { PostgresFlowStore } from './postgres.js';
import type { FlowStore } from './store.js';

export interface CreateFlowStoreOptions {
  databaseUrl?: string | undefined;
  logger?: Pick<FastifyBaseLogger, 'info' | 'warn'>;
}

export interface FlowStoreHandle {
  store: FlowStore;
  kind: 'in-memory' | 'postgres';
  close: () => Promise<void>;
}

/**
 * Selects the FlowStore impl based on DATABASE_URL:
 *   - set    → PostgresFlowStore (requires migrations applied beforehand)
 *   - unset  → InMemoryFlowStore (dev/tests/demos; loses state on restart)
 *
 * Returning a handle (instead of the bare store) keeps Postgres lifecycle
 * explicit so the server can drain the connection pool on shutdown.
 */
export function createFlowStore(opts: CreateFlowStoreOptions): FlowStoreHandle {
  if (opts.databaseUrl) {
    const pg = new PostgresFlowStore({ databaseUrl: opts.databaseUrl });
    opts.logger?.info({ kind: 'postgres' }, 'flow-store initialised');
    return { store: pg, kind: 'postgres', close: () => pg.close() };
  }
  opts.logger?.warn(
    'DATABASE_URL not set — using InMemoryFlowStore. State will be lost on restart.',
  );
  return { store: new InMemoryFlowStore(), kind: 'in-memory', close: async () => {} };
}
