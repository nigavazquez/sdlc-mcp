import { InMemoryGateStore } from './in-memory.js';
import { PostgresGateStore } from './postgres.js';
import type { GateStore } from './types.js';

export interface CreateGateStoreOptions {
  databaseUrl?: string | undefined;
}

export interface GateStoreHandle {
  store: GateStore;
  kind: 'in-memory' | 'postgres';
  close: () => Promise<void>;
}

/** Selects the gate store impl based on DATABASE_URL (mirrors createFlowStore). */
export function createGateStore(opts: CreateGateStoreOptions): GateStoreHandle {
  if (opts.databaseUrl) {
    const pg = new PostgresGateStore({ databaseUrl: opts.databaseUrl });
    return { store: pg, kind: 'postgres', close: () => pg.close() };
  }
  return { store: new InMemoryGateStore(), kind: 'in-memory', close: async () => {} };
}
