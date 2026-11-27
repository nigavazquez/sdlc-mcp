import { describe, expect, it } from 'vitest';
import { buildHealth } from '../src/http/health.js';

/** Historia C1 (#76): `GET /health` suma `version` y `setup`, y `setup` es sólo booleanos. */
describe('buildHealth', () => {
  const base = { catalogVersion: '0.12.3', storeKind: 'postgres', integrations: [] };

  it('devuelve version y setup además de lo de siempre', () => {
    const h = buildHealth({ ...base, version: '0.5.0', publicUrl: 'https://sdlc.example.com' });
    expect(h).toMatchObject({ ok: true, catalog_version: '0.12.3', store: 'postgres', version: '0.5.0' });
    expect(Object.keys(h.setup).sort()).toEqual(['docstore', 'https', 'oidc', 'pr_provider']);
  });

  it('setup sólo contiene booleanos y ningún valor de la configuración', () => {
    const secret = 'GOCSPX-super-secreto';
    const h = buildHealth({
      ...base,
      version: '0.5.0',
      publicUrl: 'https://sdlc.example.com',
      oidc: { clientId: 'client-123.apps.googleusercontent.com', clientSecret: secret },
      integrations: [
        { doc_store: { kind: 'google-drive', secret_ref: 'aws-sm://gdrive', settings: { rootFolderId: 'root' } } },
        { pr_provider: { kind: 'github', secret_ref: 'aws-sm://github', settings: {} } },
      ],
    });
    for (const v of Object.values(h.setup)) expect(typeof v).toBe('boolean');
    expect(h.setup).toEqual({ oidc: true, docstore: true, pr_provider: true, https: true });
    const json = JSON.stringify(h);
    for (const leak of [secret, 'client-123', 'aws-sm://', 'rootFolderId', 'sdlc.example.com']) {
      expect(json).not.toContain(leak);
    }
  });

  it('sin configuración todo en false y la versión es dev', () => {
    const h = buildHealth({ ...base, publicUrl: 'http://localhost:3300' });
    expect(h.version).toBe('dev');
    expect(h.setup).toEqual({ oidc: false, docstore: false, pr_provider: false, https: false });
  });

  it('OIDC a medias (sin secret) no cuenta como configurado', () => {
    expect(buildHealth({ ...base, oidc: { clientId: 'x' } }).setup.oidc).toBe(false);
  });

  it('una integración sólo con task_system no prende docstore ni pr_provider', () => {
    const h = buildHealth({ ...base, integrations: [{} as { doc_store?: unknown }] });
    expect(h.setup.docstore).toBe(false);
    expect(h.setup.pr_provider).toBe(false);
  });
});
