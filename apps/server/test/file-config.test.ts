import { describe, expect, it } from 'vitest';
import { parseFileConfig } from '../src/config/file-config.js';

describe('parseFileConfig', () => {
  it('parsea workspaces, groups y labels con defaults', () => {
    const cfg = parseFileConfig(`
tenantId: acme
labels: { workspace: { singular: squad, plural: squads } }
workspaces:
  - { id: revenue, name: Revenue, group: growth }
groups:
  - { id: growth, name: Growth }
`);
    expect(cfg.tenantId).toBe('acme');
    expect(cfg.labels.workspace.singular).toBe('squad');
    expect(cfg.labels.group.singular).toBe('group'); // default
    expect(cfg.workspaces[0]).toMatchObject({ id: 'revenue', group: 'growth' });
  });

  it('rechaza un workspace sin id', () => {
    expect(() => parseFileConfig('workspaces: [{ name: X }]')).toThrow();
  });
});
