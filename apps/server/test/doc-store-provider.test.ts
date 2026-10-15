import { describe, expect, it, vi } from 'vitest';
import type { Flow } from '@sdlc/core';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';
import {
  ConfigBackedDocStoreProvider,
  NoOpDocStoreAdapter,
  isNoOpDocStoreAdapter,
} from '../src/adapters/doc-store-provider.js';

const FLOW = {
  flow_id: 't1:p1:slug',
  tenant_id: 't1',
  project: 'p1',
  slug: 'slug',
} as Flow;

const ctx: TenantCtx = {
  tenantId: 't1', userId: 'u', roles: [],
  resolveSecret: async () => SA_JSON,
};

const SA_JSON = JSON.stringify({ type: 'service_account', client_email: 'x@y.iam', private_key: 'FAKE' });

// Prevent googleapis from making real network calls in provider test
vi.mock('../src/adapters/google-drive-docstore.js', () => ({
  GoogleDriveDocStoreAdapter: vi.fn().mockImplementation(() => ({
    kind: 'google-drive',
    publish: vi.fn(),
    fetch: vi.fn(),
  })),
}));
import { GoogleDriveDocStoreAdapter } from '../src/adapters/google-drive-docstore.js';

describe('ConfigBackedDocStoreProvider', () => {
  it('returns NoOpDocStoreAdapter when no doc_store config', async () => {
    const store = new InMemoryIntegrationConfigStore();
    const provider = new ConfigBackedDocStoreProvider({ configStore: store });
    const adapter = await provider.resolve(ctx, FLOW);
    expect(adapter).toBeInstanceOf(NoOpDocStoreAdapter);
  });

  it('returns NoOpDocStoreAdapter for kind="repo"', async () => {
    const store = new InMemoryIntegrationConfigStore();
    store.seed('t1', 'p1', { doc_store: { kind: 'repo', settings: {} } });
    const provider = new ConfigBackedDocStoreProvider({ configStore: store });
    const adapter = await provider.resolve(ctx, FLOW);
    expect(adapter).toBeInstanceOf(NoOpDocStoreAdapter);
  });

  it('builds GoogleDriveDocStoreAdapter for kind="google-drive"', async () => {
    const store = new InMemoryIntegrationConfigStore();
    store.seed('t1', 'p1', {
      doc_store: {
        kind: 'google-drive',
        secret_ref: 'aws-sm://gdrive-sa',
        settings: { sharedDriveId: '0APm8ey814gtwUk9PVA' },
      },
    });
    const provider = new ConfigBackedDocStoreProvider({ configStore: store });
    const adapter = await provider.resolve(ctx, FLOW);
    expect(GoogleDriveDocStoreAdapter).toHaveBeenCalledWith({
      serviceAccountJson: SA_JSON,
      sharedDriveId: '0APm8ey814gtwUk9PVA',
    });
    expect(adapter.kind).toBe('google-drive');
  });

  it('throws when google-drive has no secret_ref', async () => {
    const store = new InMemoryIntegrationConfigStore();
    store.seed('t1', 'p1', {
      doc_store: { kind: 'google-drive', settings: {} },
    });
    const provider = new ConfigBackedDocStoreProvider({ configStore: store });
    await expect(provider.resolve(ctx, FLOW)).rejects.toThrow('secret_ref');
  });

  it('throws for unknown kind', async () => {
    const store = new InMemoryIntegrationConfigStore();
    store.seed('t1', 'p1', { doc_store: { kind: 'notion', settings: {} } });
    const provider = new ConfigBackedDocStoreProvider({ configStore: store });
    await expect(provider.resolve(ctx, FLOW)).rejects.toThrow(/unknown doc_store kind: notion/);
  });
});

describe('NoOpDocStoreAdapter', () => {
  it('publish returns a stub DocRef without throwing', async () => {
    const noop = new NoOpDocStoreAdapter();
    const ref = await noop.publish(
      { title: 'T', markdown: '# T', doc_kind: 'prd', flow_folder: 'f' },
      ctx,
    );
    expect(ref.id).toBe('noop');
  });
});

// Mismo contrato (y mismo motivo) que `isNoOpPullRequestAdapter`: submit_adr
// tiene que poder distinguir el no-op del adapter real para no publicar un ADR
// fantasma, y no puede hacerlo con `instanceof` porque una doble carga del
// módulo lo rompe en silencio y la dirección del fallo es fail-open.
describe('isNoOpDocStoreAdapter', () => {
  it('reconoce el no-op', () => {
    expect(isNoOpDocStoreAdapter(new NoOpDocStoreAdapter())).toBe(true);
  });

  // El caso que `instanceof` no cubre: una segunda carga del módulo produce una
  // clase distinta, así que el no-op de esa copia no es `instanceof` el nuestro.
  // El discriminante lo reconoce igual — que es el punto de tenerlo.
  it('reconoce un no-op de otra carga del módulo (el caso que instanceof pierde)', () => {
    const gemelo = {
      kind: 'repo' as const,
      is_noop: true,
      publish: async () => ({ id: 'noop', url: '' }),
      fetch: async () => ({ markdown: '', version: 'noop' }),
    };

    expect(gemelo instanceof NoOpDocStoreAdapter).toBe(false);
    expect(isNoOpDocStoreAdapter(gemelo)).toBe(true);
  });

  // La otra dirección: un adapter real no lleva la marca y no debe confundirse.
  it('un adapter real no pasa por no-op', () => {
    const real = {
      kind: 'google-drive' as const,
      publish: async () => ({ id: 'abc123', url: 'https://docs.google.com/d/abc123' }),
      fetch: async () => ({ markdown: '# doc', version: '1' }),
    };
    expect(isNoOpDocStoreAdapter(real)).toBe(false);
  });
});
