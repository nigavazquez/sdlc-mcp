import { InMemoryIntegrationConfigStore } from './in-memory.js';
import { PostgresIntegrationConfigStore } from './postgres.js';
import type { IntegrationConfigStore } from './types.js';

export interface CreateIntegrationConfigStoreOptions {
  databaseUrl?: string | undefined;
}

export interface IntegrationConfigStoreHandle {
  store: IntegrationConfigStore;
  kind: 'in-memory' | 'postgres';
  close: () => Promise<void>;
}

/** Selects the config store impl based on DATABASE_URL (mirrors createFlowStore). */
export function createIntegrationConfigStore(
  opts: CreateIntegrationConfigStoreOptions,
): IntegrationConfigStoreHandle {
  if (opts.databaseUrl) {
    const pg = new PostgresIntegrationConfigStore({ databaseUrl: opts.databaseUrl });
    return { store: pg, kind: 'postgres', close: () => pg.close() };
  }
  return { store: new InMemoryIntegrationConfigStore(), kind: 'in-memory', close: async () => {} };
}
