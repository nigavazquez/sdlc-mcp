import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { GoogleDriveDocStoreAdapter } from '../src/adapters/google-drive-docstore.js';
import { google } from 'googleapis';

const saJson  = process.env.GDRIVE_TEST_SA_JSON;
const driveId = process.env.GDRIVE_TEST_DRIVE_ID;
// CSV: cada segmento es una carpeta, de la raíz hacia abajo.
const testFolderPath = (process.env.GDRIVE_TEST_FOLDER_PATH ?? '_ci-group,_ci-workspace')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const testFlow  = `_ci-flow-${Date.now()}`;

const maybe = (saJson && driveId) ? describe : describe.skip;

maybe('GoogleDriveDocStoreAdapter (live Drive)', () => {
  let adapter: GoogleDriveDocStoreAdapter;
  let createdFileId: string | undefined;
  let createdFlowFolderId: string | undefined;

  const ctx: TenantCtx = {
    tenantId: 't1', userId: 'test', roles: [],
    resolveSecret: async () => { throw new Error('not used'); },
  };

  beforeAll(() => {
    adapter = new GoogleDriveDocStoreAdapter({
      serviceAccountJson: saJson!,
      sharedDriveId: driveId!,
    });
  });

  afterAll(async () => {
    // Clean up: delete the test flow folder (which contains all uploaded files)
    if (!createdFlowFolderId) return;
    const credentials = JSON.parse(saJson!);
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive'] });
    const drive = google.drive({ version: 'v3', auth });
    await drive.files.delete({ fileId: createdFlowFolderId, supportsAllDrives: true }).catch(() => {});
  });

  let createdGdocId: string | undefined;

  it('publishes PRD as BOTH a .md file and a native Google Doc', async () => {
    const ref = await adapter.publish({
      title: 'CI PRD',
      markdown: '# CI PRD\n\nThis is a live integration test.',
      doc_kind: 'prd',
      flow_folder: testFlow,
      folder_path: testFolderPath,
    }, ctx);

    expect(ref.id).toBeTruthy();          // .md file id
    expect(ref.gdoc_id).toBeTruthy();     // native Google Doc id
    expect(ref.url).toMatch(/docs\.google\.com\/document|drive\.google\.com/);
    createdFileId = ref.id;
    createdGdocId = ref.gdoc_id;
  });

  it('re-publishing PRD is idempotent for BOTH objects (no duplicates)', async () => {
    const ref2 = await adapter.publish({
      title: 'CI PRD',
      markdown: '# CI PRD\n\nUpdated content.',
      doc_kind: 'prd',
      flow_folder: testFlow,
      folder_path: testFolderPath,
    }, ctx);
    // Same ids → update both, not create new
    expect(ref2.id).toBe(createdFileId);
    expect(ref2.gdoc_id).toBe(createdGdocId);
  });

  it('uploads an ADR into the adr/ subfolder as both .md and Doc', async () => {
    const ref = await adapter.publish({
      title: 'Use Postgres',
      markdown: '# ADR 0001\n\nWe use Postgres.',
      doc_kind: 'adr',
      flow_folder: testFlow,
      folder_path: testFolderPath,
      adr_filename: '0001-use-postgres.md',
    }, ctx);
    expect(ref.id).toBeTruthy();        // 0001-use-postgres.md
    expect(ref.gdoc_id).toBeTruthy();   // Doc 0001-use-postgres
  });

  it('fetch returns the uploaded markdown', async () => {
    if (!createdFileId) return;
    const { markdown } = await adapter.fetch(createdFileId, ctx);
    expect(markdown).toContain('Updated content');
  });
});
