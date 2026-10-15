import { describe, expect, it } from 'vitest';
import { createIntegrationConfigStore } from '../src/integrations/index.js';
import { InMemoryIntegrationConfigStore } from '../src/integrations/in-memory.js';

describe('createIntegrationConfigStore', () => {
  it('returns in-memory store when databaseUrl is undefined', () => {
    const handle = createIntegrationConfigStore({ databaseUrl: undefined });
    expect(handle.store).toBeInstanceOf(InMemoryIntegrationConfigStore);
    expect(handle.kind).toBe('in-memory');
  });
});
