import { InMemoryDirectoryStore } from './directory-in-memory.js';
import { PostgresDirectoryStore } from './directory-postgres.js';
import type { DirectoryStore } from './directory-store.js';
import { InMemoryOAuthStore } from './oauth-in-memory.js';
import { PostgresOAuthStore } from './oauth-postgres.js';
import type { OAuthStore } from './oauth-store.js';

export interface DirectoryStoreHandle {
  store: DirectoryStore;
  kind: 'in-memory' | 'postgres';
  close: () => Promise<void>;
}

export interface OAuthStoreHandle {
  store: OAuthStore;
  kind: 'in-memory' | 'postgres';
  close: () => Promise<void>;
}

/** Misma selección por DATABASE_URL que el resto de los stores del server. */
export function createDirectoryStore(opts: { databaseUrl?: string | undefined }): DirectoryStoreHandle {
  if (opts.databaseUrl) {
    const pg = new PostgresDirectoryStore({ databaseUrl: opts.databaseUrl });
    return { store: pg, kind: 'postgres', close: () => pg.close() };
  }
  return { store: new InMemoryDirectoryStore(), kind: 'in-memory', close: async () => {} };
}

export function createOAuthStore(opts: { databaseUrl?: string | undefined }): OAuthStoreHandle {
  if (opts.databaseUrl) {
    const pg = new PostgresOAuthStore({ databaseUrl: opts.databaseUrl });
    return { store: pg, kind: 'postgres', close: () => pg.close() };
  }
  return { store: new InMemoryOAuthStore(), kind: 'in-memory', close: async () => {} };
}
