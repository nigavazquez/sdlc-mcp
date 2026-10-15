import { describe, expect, it } from 'vitest';
import { parseIntegrationsConfig } from '../src/integrations/seed.js';

const VALID = {
  tenants: [
    {
      tenant_id: 'default',
      projects: [
        {
          project: 'checkout',
          task_system: {
            kind: 'azure-devops',
            secret_ref: 'aws-sm://sdlc/ado-pat#token',
            settings: { org: 'your-org', project: 'Checkout' },
          },
        },
      ],
    },
  ],
};

describe('parseIntegrationsConfig', () => {
  it('accepts a valid config and defaults settings to {}', () => {
    const cfg = parseIntegrationsConfig(VALID);
    expect(cfg.tenants[0]!.projects[0]!.task_system!.settings).toEqual({
      org: 'your-org',
      project: 'Checkout',
    });
  });

  it('defaults missing settings to {}', () => {
    const cfg = parseIntegrationsConfig({
      tenants: [
        { tenant_id: 't', projects: [{ project: 'p', task_system: { kind: 'azure-devops' } }] },
      ],
    });
    expect(cfg.tenants[0]!.projects[0]!.task_system!.settings).toEqual({});
  });

  it('rejects a project with no integration refs', () => {
    expect(() =>
      parseIntegrationsConfig({ tenants: [{ tenant_id: 't', projects: [{ project: 'p' }] }] }),
    ).toThrow(/at least one/i);
  });

  it('rejects a ref with an empty kind', () => {
    expect(() =>
      parseIntegrationsConfig({
        tenants: [{ tenant_id: 't', projects: [{ project: 'p', task_system: { kind: '' } }] }],
      }),
    ).toThrow();
  });

  it('rejects a missing tenant_id', () => {
    expect(() =>
      parseIntegrationsConfig({ tenants: [{ projects: [{ project: 'p' }] }] }),
    ).toThrow();
  });

  it('rejects an empty tenants array', () => {
    expect(() => parseIntegrationsConfig({ tenants: [] })).toThrow();
  });
});
