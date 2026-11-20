import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { GoogleDriveDocStoreAdapter } from '../src/adapters/google-drive-docstore.js';

// Mock googleapis entirely so no real HTTP is made.
vi.mock('googleapis', () => {
  const makeFilesClient = () => ({
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    get: vi.fn(),
  });
  return {
    google: {
      auth: {
        GoogleAuth: vi.fn().mockImplementation(() => ({})),
      },
      drive: vi.fn().mockImplementation(() => ({ files: makeFilesClient() })),
    },
  };
});

import { google } from 'googleapis';

const SA_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'test@example.iam.gserviceaccount.com',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----\n',
});

function makeAdapter() {
  return new GoogleDriveDocStoreAdapter({
    credentialsJson: SA_JSON,
    location: { sharedDriveId: 'DRIVE_ID' },
  });
}

const ctx: TenantCtx = {
  tenantId: 't1', userId: 'u', roles: [],
  resolveSecret: async () => { throw new Error('not used'); },
};

describe('GoogleDriveDocStoreAdapter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('publish prd: creates folder chain then upserts BOTH .md file and native Doc', async () => {
    // All list calls return empty (folders + both objects do not exist yet)
    const driveApi = google.drive({ version: 'v3', auth: {} as any });
    (driveApi.files.list as any).mockResolvedValue({ data: { files: [] } });
    // Return a distinct id/link per create call so .md and Doc are distinguishable
    let createSeq = 0;
    (driveApi.files.create as any).mockImplementation(async (params: any) => {
      createSeq++;
      const id = `created-${createSeq}`;
      return { data: { id, webViewLink: `https://drive.google.com/file/${id}` } };
    });

    const adapter = makeAdapter();
    // Inject mocked drive directly (reflection trick)
    (adapter as any).drive = driveApi;

    const ref = await adapter.publish({
      title: 'My PRD',
      markdown: '# PRD',
      doc_kind: 'prd',
      flow_folder: 'checkout-cuotas',
      folder_path: ['Product', 'Platform'],
    }, ctx);

    // DocRef carries both representations
    expect(ref.id).toBeDefined();        // .md file id
    expect(ref.url).toBeDefined();       // Google Doc url
    expect(ref.gdoc_id).toBeDefined();   // Google Doc id
    expect(ref.gdoc_url).toBe(ref.url);
    expect(ref.md_url).toBeDefined();

    const createCalls = (driveApi.files.create as any).mock.calls as any[];
    // EXACTLY ONE .md file: named 'prd.md', media mimeType text/markdown, NOT a Doc conversion
    const mdCreate = createCalls.find(
      (c: any[]) => c[0]?.requestBody?.name === 'prd.md'
        && c[0]?.media?.mimeType === 'text/markdown'
        && c[0]?.requestBody?.mimeType !== 'application/vnd.google-apps.document',
    );
    expect(mdCreate).toBeDefined();
    // EXACTLY ONE native Doc: named 'prd' (no extension), requestBody.mimeType = Doc, media text/markdown
    const docCreate = createCalls.find(
      (c: any[]) => c[0]?.requestBody?.name === 'prd'
        && c[0]?.requestBody?.mimeType === 'application/vnd.google-apps.document'
        && c[0]?.media?.mimeType === 'text/markdown',
    );
    expect(docCreate).toBeDefined();
  });

  it('publish sin folder_path tira antes de tocar la API', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.publish({ title: 'T', markdown: '# T', doc_kind: 'prd', flow_folder: 'f' }, ctx),
    ).rejects.toThrow('folder_path is required');
  });

  it('publish con folder_path vacío tira antes de tocar la API', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.publish(
        { title: 'T', markdown: '# T', doc_kind: 'prd', flow_folder: 'f', folder_path: [] },
        ctx,
      ),
    ).rejects.toThrow('folder_path is required');
  });

  it('publish adr without adr_filename throws', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.publish({
        title: 'Use Redis',
        markdown: '# ADR',
        doc_kind: 'adr',
        flow_folder: 'checkout-cuotas',
        folder_path: ['Product', 'Platform'],
        // no adr_filename
      }, ctx),
    ).rejects.toThrow('adr_filename is required for ADR documents');
  });

  it('q escaping: single-quote in a folder name is escaped as \\\'', async () => {
    // Folder names with single quotes (from user-supplied input) must be escaped in Drive q strings.
    const driveApi = google.drive({ version: 'v3', auth: {} as any });
    (driveApi.files.list as any).mockResolvedValue({ data: { files: [] } });
    let createSeq = 0;
    (driveApi.files.create as any).mockImplementation(async () => {
      createSeq++;
      const id = `sq-${createSeq}`;
      return { data: { id, webViewLink: `https://drive.google.com/file/${id}` } };
    });
    const adapter = makeAdapter();
    (adapter as any).drive = driveApi;

    // un segmento de la ruta contiene una comilla simple — intento de inyección clásico
    await adapter.publish({
      title: 'My PRD',
      markdown: '# PRD',
      doc_kind: 'prd',
      flow_folder: 'checkout',
      folder_path: ["x' or name!='", 'Squad-B'],
    }, ctx);

    const listCalls = (driveApi.files.list as any).mock.calls as any[][];
    // At least one files.list q should contain the escaped form \' rather than a raw '
    const allQStrings = listCalls.map((c) => String(c[0]?.q ?? ''));
    const hasEscapedQuote = allQStrings.some((q) => q.includes("\\'"));
    expect(hasEscapedQuote).toBe(true);
    // The injected payload must NOT appear verbatim — the name value must be properly wrapped.
    // Without escaping the q would start: name='x' or name!='...  (breaks the literal boundary).
    // With escaping it starts:            name='x\' or name!=\'' and ...  (whole value is one literal).
    // Test: no q string should contain the unescaped fragment  name='x' or
    const hasVerbatimInjection = allQStrings.some((q) => q.includes("name='x' or"));
    expect(hasVerbatimInjection).toBe(false);
  });

  it('publish adr uses adr/ subfolder; .md is NNNN-slug.md and Doc is NNNN-slug', async () => {
    const driveApi = google.drive({ version: 'v3', auth: {} as any });
    (driveApi.files.list as any).mockResolvedValue({ data: { files: [] } });
    let createSeq = 0;
    (driveApi.files.create as any).mockImplementation(async () => {
      createSeq++;
      const id = `adr-${createSeq}`;
      return { data: { id, webViewLink: `https://drive.google.com/file/${id}` } };
    });
    const adapter = makeAdapter();
    (adapter as any).drive = driveApi;

    const ref = await adapter.publish({
      title: 'Use Postgres',
      markdown: '# ADR',
      doc_kind: 'adr',
      flow_folder: 'checkout-cuotas',
      folder_path: ['Product', 'Platform'],
      adr_filename: '0001-use-postgres.md',
    }, ctx);

    expect(ref.id).toBeDefined();
    expect(ref.gdoc_id).toBeDefined();

    const createCalls = (driveApi.files.create as any).mock.calls as any[];
    // adr/ subfolder created
    const adrFolderCreate = createCalls.find(
      (c: any[]) => c[0]?.requestBody?.name === 'adr'
        && c[0]?.requestBody?.mimeType === 'application/vnd.google-apps.folder',
    );
    expect(adrFolderCreate).toBeDefined();
    // .md named 0001-use-postgres.md
    const mdCreate = createCalls.find((c: any[]) => c[0]?.requestBody?.name === '0001-use-postgres.md');
    expect(mdCreate).toBeDefined();
    // Doc named 0001-use-postgres (no extension), converted
    const docCreate = createCalls.find(
      (c: any[]) => c[0]?.requestBody?.name === '0001-use-postgres'
        && c[0]?.requestBody?.mimeType === 'application/vnd.google-apps.document',
    );
    expect(docCreate).toBeDefined();
  });

  it('ensureFolderPath reuses existing folder (no extra folder create)', async () => {
    const driveApi = google.drive({ version: 'v3', auth: {} as any });
    // Folder lists return a hit; object lists (for the two upserts) return empty.
    (driveApi.files.list as any).mockImplementation(async (params: any) => {
      const q: string = params.q ?? '';
      if (q.includes("mimeType='application/vnd.google-apps.folder'")) {
        return { data: { files: [{ id: 'existing-folder' }] } };
      }
      return { data: { files: [] } }; // both .md and Doc absent
    });
    (driveApi.files.create as any).mockResolvedValue({
      data: { id: 'obj-id', webViewLink: 'https://drive.google.com/file/obj-id' },
    });
    const adapter = makeAdapter();
    (adapter as any).drive = driveApi;

    await adapter.publish({
      title: 'PRD', markdown: '# PRD',
      doc_kind: 'prd', flow_folder: 'my-flow',
      folder_path: ['T', 'S'],
    }, ctx);

    // create should only be called for the two objects, not for folders
    const createCalls = (driveApi.files.create as any).mock.calls as any[];
    const folderCreates = createCalls.filter(
      (c: any[]) => c[0]?.requestBody?.mimeType === 'application/vnd.google-apps.folder'
    );
    expect(folderCreates).toHaveLength(0);
  });

  it('idempotent re-publish: BOTH .md and Doc are UPDATED (no duplicate create)', async () => {
    const driveApi = google.drive({ version: 'v3', auth: {} as any });
    // Folders exist; the .md (text/markdown) and Doc (application/vnd.google-apps.document) already exist.
    (driveApi.files.list as any).mockImplementation(async (params: any) => {
      const q: string = params.q ?? '';
      if (q.includes("mimeType='application/vnd.google-apps.folder'")) {
        return { data: { files: [{ id: 'folder-x' }] } };
      }
      if (q.includes("mimeType='text/markdown'")) {
        return { data: { files: [{ id: 'existing-md-id' }] } };
      }
      if (q.includes("mimeType='application/vnd.google-apps.document'")) {
        return { data: { files: [{ id: 'existing-doc-id' }] } };
      }
      return { data: { files: [] } };
    });
    (driveApi.files.update as any).mockImplementation(async (params: any) => ({
      data: { id: params.fileId, webViewLink: `https://drive.google.com/file/${params.fileId}` },
    }));
    const adapter = makeAdapter();
    (adapter as any).drive = driveApi;

    const ref = await adapter.publish({
      title: 'PRD', markdown: '# PRD',
      doc_kind: 'prd', flow_folder: 'my-flow',
      folder_path: ['T', 'S'],
    }, ctx);

    // No object create at all — both updated in place.
    const objectCreates = ((driveApi.files.create as any).mock.calls as any[]).filter(
      (c: any[]) => c[0]?.requestBody?.mimeType !== 'application/vnd.google-apps.folder',
    );
    expect(objectCreates).toHaveLength(0);
    expect(driveApi.files.update).toHaveBeenCalledTimes(2); // .md + Doc
    expect(ref.id).toBe('existing-md-id');
    expect(ref.gdoc_id).toBe('existing-doc-id');
  });

  it('mixed state: .md exists (update) but Doc absent (create)', async () => {
    const driveApi = google.drive({ version: 'v3', auth: {} as any });
    (driveApi.files.list as any).mockImplementation(async (params: any) => {
      const q: string = params.q ?? '';
      if (q.includes("mimeType='application/vnd.google-apps.folder'")) {
        return { data: { files: [{ id: 'folder-x' }] } };
      }
      if (q.includes("mimeType='text/markdown'")) {
        return { data: { files: [{ id: 'existing-md-id' }] } };
      }
      return { data: { files: [] } }; // Doc absent
    });
    (driveApi.files.update as any).mockResolvedValue({
      data: { id: 'existing-md-id', webViewLink: 'https://drive.google.com/file/existing-md-id' },
    });
    (driveApi.files.create as any).mockResolvedValue({
      data: { id: 'new-doc-id', webViewLink: 'https://drive.google.com/file/new-doc-id' },
    });
    const adapter = makeAdapter();
    (adapter as any).drive = driveApi;

    const ref = await adapter.publish({
      title: 'PRD', markdown: '# PRD',
      doc_kind: 'prd', flow_folder: 'my-flow',
      folder_path: ['T', 'S'],
    }, ctx);

    expect(driveApi.files.update).toHaveBeenCalledOnce(); // the .md
    const docCreate = ((driveApi.files.create as any).mock.calls as any[]).find(
      (c: any[]) => c[0]?.requestBody?.mimeType === 'application/vnd.google-apps.document',
    );
    expect(docCreate).toBeDefined();
    expect(ref.id).toBe('existing-md-id');
    expect(ref.gdoc_id).toBe('new-doc-id');
  });
  it('une los segmentos que recibe, sean uno o tres', async () => {
    const driveApi = google.drive({ version: 'v3', auth: {} as any });
    (driveApi.files.list as any).mockResolvedValue({ data: { files: [] } });
    let seq = 0;
    (driveApi.files.create as any).mockImplementation(async () => {
      seq++;
      return { data: { id: `created-${seq}`, webViewLink: `https://drive.google.com/file/${seq}` } };
    });
    const adapter = makeAdapter();
    (adapter as any).drive = driveApi;

    await adapter.publish({
      title: 'My PRD',
      markdown: '# PRD',
      doc_kind: 'prd',
      flow_folder: 'checkout',
      folder_path: ['Corp', 'Product', 'Platform'],
    }, ctx);

    // 3 segmentos + la carpeta del flow = 4 carpetas creadas, en ese orden.
    const folderNames = ((driveApi.files.create as any).mock.calls as any[])
      .filter((c) => c[0]?.requestBody?.mimeType === 'application/vnd.google-apps.folder')
      .map((c) => c[0].requestBody.name);
    expect(folderNames).toEqual(['Corp', 'Product', 'Platform', 'checkout']);
  });

  it('un solo segmento alcanza: no se asumen dos niveles', async () => {
    const driveApi = google.drive({ version: 'v3', auth: {} as any });
    (driveApi.files.list as any).mockResolvedValue({ data: { files: [] } });
    let seq = 0;
    (driveApi.files.create as any).mockImplementation(async () => {
      seq++;
      return { data: { id: `one-${seq}`, webViewLink: `https://drive.google.com/file/${seq}` } };
    });
    const adapter = makeAdapter();
    (adapter as any).drive = driveApi;

    await adapter.publish({
      title: 'My PRD',
      markdown: '# PRD',
      doc_kind: 'prd',
      flow_folder: 'checkout',
      folder_path: ['Platform'],
    }, ctx);

    const folderNames = ((driveApi.files.create as any).mock.calls as any[])
      .filter((c) => c[0]?.requestBody?.mimeType === 'application/vnd.google-apps.folder')
      .map((c) => c[0].requestBody.name);
    expect(folderNames).toEqual(['Platform', 'checkout']);
  });

  it('Mi unidad: arranca en rootFolderId y busca en los archivos del usuario, no en una unidad compartida', async () => {
    const driveApi = google.drive({ version: 'v3', auth: {} as any });
    (driveApi.files.list as any).mockResolvedValue({ data: { files: [] } });
    let seq = 0;
    (driveApi.files.create as any).mockImplementation(async () => {
      seq++;
      return { data: { id: `my-${seq}`, webViewLink: `https://drive.google.com/file/${seq}` } };
    });
    const adapter = new GoogleDriveDocStoreAdapter({
      credentialsJson: JSON.stringify({
        type: 'authorized_user', client_id: 'cid', client_secret: 'cs', refresh_token: 'rt',
      }),
      location: { rootFolderId: 'root' },
    });
    (adapter as any).drive = driveApi;

    await adapter.publish({
      title: 'My PRD',
      markdown: '# PRD',
      doc_kind: 'prd',
      flow_folder: 'checkout',
      folder_path: ['Acme', 'Platform'],
    }, ctx);

    const createCalls = (driveApi.files.create as any).mock.calls as any[];
    expect(createCalls[0][0].requestBody).toMatchObject({ name: 'Acme', parents: ['root'] });
    for (const [params] of (driveApi.files.list as any).mock.calls as any[]) {
      expect(params.corpora).toBe('user');
      expect(params.driveId).toBeUndefined();
    }
  });
});
