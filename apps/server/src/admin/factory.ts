import { InMemoryAdminStore } from './in-memory.js';
import { PostgresAdminStore } from './postgres.js';
import type { AdminStore } from './store.js';

export interface AdminStoreHandle {
  store: AdminStore;
  kind: 'in-memory' | 'postgres';
  close: () => Promise<void>;
}

/** Selecciona la impl según DATABASE_URL (mismo patrón que createFlowStore). */
export function createAdminStore(opts: { databaseUrl?: string | undefined }): AdminStoreHandle {
  if (opts.databaseUrl) {
    const pg = new PostgresAdminStore({ databaseUrl: opts.databaseUrl });
    return { store: pg, kind: 'postgres', close: () => pg.close() };
  }
  return { store: new InMemoryAdminStore(), kind: 'in-memory', close: async () => {} };
}
