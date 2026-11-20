import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { DocPublishInput, DocRef, DocStoreAdapter, DocStoreKind } from '@sdlc/adapters-contracts';
import type { TenantCtx } from '@sdlc/adapters-contracts';

/**
 * Escape a value for use inside a Drive v3 `q` string literal.
 * Drive q literals MUST be single-quoted; backslash and single-quote must be escaped.
 */
function driveQ(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Dónde viven los documentos. Las dos formas son excluyentes:
 *  - `sharedDriveId`: unidad compartida de Google Workspace (credencial típica: service account).
 *  - `rootFolderId`: carpeta de "Mi unidad" de una cuenta personal (`'root'` = la raíz de Mi
 *    unidad). La credencial es la de esa cuenta (`authorized_user`): una service account no
 *    tiene cuota en Mi unidad y una cuenta @gmail no puede crear unidades compartidas.
 */
export type GoogleDriveLocation = { sharedDriveId: string } | { rootFolderId: string };

export interface GoogleDriveDocStoreAdapterOptions {
  /** JSON de credenciales: `service_account` o `authorized_user` (refresh token). */
  credentialsJson: string;
  location: GoogleDriveLocation;
}

export class GoogleDriveDocStoreAdapter implements DocStoreAdapter {
  readonly kind: DocStoreKind = 'google-drive';

  private readonly drive: drive_v3.Drive;
  private readonly rootId: string;
  /** Alcance de las búsquedas: la unidad compartida, o los archivos del usuario. */
  private readonly listScope: Pick<drive_v3.Params$Resource$Files$List, 'corpora' | 'driveId'>;

  constructor(opts: GoogleDriveDocStoreAdapterOptions) {
    if ('sharedDriveId' in opts.location) {
      this.rootId = opts.location.sharedDriveId;
      this.listScope = { corpora: 'drive', driveId: opts.location.sharedDriveId };
    } else {
      this.rootId = opts.location.rootFolderId;
      this.listScope = { corpora: 'user' };
    }
    // GoogleAuth arma el cliente según `type`: JWT para service_account,
    // UserRefreshClient para authorized_user (ahí los scopes ya vienen en el refresh token).
    const credentials = JSON.parse(opts.credentialsJson) as object;
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    this.drive = google.drive({ version: 'v3', auth });
  }

  // Per OD-1 ("both"): each artifact is stored TWICE — a faithful .md file AND a native Google Doc.
  private static readonly DOC_MIME = 'application/vnd.google-apps.document';
  private static readonly MD_MIME = 'text/markdown';

  async publish(input: DocPublishInput, _ctx: TenantCtx): Promise<DocRef> {
    if (!input.folder_path || input.folder_path.length === 0) {
      throw new Error(
        'folder_path is required (non-empty) when doc_store kind is google-drive',
      );
    }

    // Validate ADR-specific requirements before any I/O.
    if (input.doc_kind === 'adr' && !input.adr_filename) {
      throw new Error('adr_filename is required for ADR documents');
    }

    const folderSegments =
      input.doc_kind === 'adr'
        ? [...input.folder_path, input.flow_folder, 'adr']
        : [...input.folder_path, input.flow_folder];

    const leafFolderId = await this.ensureFolderPath(this.rootId, folderSegments);

    // baseName has NO extension; the .md file appends ".md", the Doc uses it as-is.
    const baseName =
      input.doc_kind === 'adr'
        ? input.adr_filename!.replace(/\.md$/, '')
        : input.doc_kind; // 'prd' | 'rfc' | 'change-note'

    // 1) faithful markdown file (matched by name + parent + text/markdown)
    const md = await this.upsertObject(
      leafFolderId,
      `${baseName}.md`,
      input.markdown,
      GoogleDriveDocStoreAdapter.MD_MIME,
    );

    // 2) native Google Doc (matched by name + parent + Doc mime; Drive converts md → Doc on import)
    const doc = await this.upsertObject(
      leafFolderId,
      baseName,
      input.markdown,
      GoogleDriveDocStoreAdapter.DOC_MIME,
      GoogleDriveDocStoreAdapter.DOC_MIME,
    );

    // Google Doc is the primary human-facing url; keep the .md id as the source-of-truth anchor.
    return {
      id: md.id,
      url: doc.webViewLink,
      gdoc_id: doc.id,
      gdoc_url: doc.webViewLink,
      md_url: md.webViewLink,
    };
  }

  async fetch(id: string, _ctx: TenantCtx): Promise<{ markdown: string; version: string }> {
    const res = await this.drive.files.get({
      fileId: id,
      alt: 'media',
      supportsAllDrives: true,
    });
    return { markdown: res.data as unknown as string, version: id };
  }

  /** Walk folder segments from the root (shared drive or My Drive folder), creating missing folders. */
  private async ensureFolderPath(
    rootId: string,
    segments: string[],
  ): Promise<string> {
    let parentId = rootId;
    for (const segment of segments) {
      parentId = await this.ensureFolder(parentId, segment);
    }
    return parentId;
  }

  private async ensureFolder(parentId: string, name: string): Promise<string> {
    const q = `name=${driveQ(name)} and ${driveQ(parentId)} in parents and mimeType=${driveQ('application/vnd.google-apps.folder')} and trashed=false`;
    const list = await this.drive.files.list({
      q,
      ...this.listScope,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields: 'files(id)',
      pageSize: 1,
    });
    const existing = list.data.files?.[0];
    if (existing?.id) return existing.id;

    const created = await this.drive.files.create({
      supportsAllDrives: true,
      fields: 'id',
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      },
    });
    if (!created.data.id) {
      throw new Error(`Failed to create folder "${name}" under parent "${parentId}"`);
    }
    return created.data.id;
  }

  /**
   * Upsert ONE Drive object, matched by name + parent + mimeType so the .md file and
   * the Google Doc never collide. The media body is always uploaded as text/markdown;
   * pass `targetMimeType='application/vnd.google-apps.document'` to have Drive convert
   * the markdown into a native Doc on import.
   */
  private async upsertObject(
    parentFolderId: string,
    name: string,
    body: string,
    matchMimeType: string,
    targetMimeType?: string,
  ): Promise<{ id: string; webViewLink: string }> {
    const q = `name=${driveQ(name)} and ${driveQ(parentFolderId)} in parents and mimeType=${driveQ(matchMimeType)} and trashed=false`;
    const list = await this.drive.files.list({
      q,
      ...this.listScope,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields: 'files(id)',
      pageSize: 1,
    });
    const existing = list.data.files?.[0];

    // Always feed Drive the markdown bytes; conversion (if any) is driven by requestBody.mimeType.
    const media = { mimeType: GoogleDriveDocStoreAdapter.MD_MIME, body };

    if (existing?.id) {
      const updated = await this.drive.files.update({
        fileId: existing.id,
        supportsAllDrives: true,
        fields: 'id,webViewLink',
        media,
      });
      const updatedId = updated.data.id ?? existing.id;
      const updatedLink = updated.data.webViewLink;
      if (!updatedLink) {
        throw new Error(`Drive API returned no webViewLink for "${name}"`);
      }
      return { id: updatedId, webViewLink: updatedLink };
    }

    const created = await this.drive.files.create({
      supportsAllDrives: true,
      fields: 'id,webViewLink',
      requestBody: {
        name,
        parents: [parentFolderId],
        // Setting the Doc mimeType here tells Drive to convert the imported markdown to a Doc.
        ...(targetMimeType !== undefined ? { mimeType: targetMimeType } : {}),
      },
      media,
    });
    if (!created.data.id) {
      throw new Error(`Drive API returned no id for "${name}"`);
    }
    if (!created.data.webViewLink) {
      throw new Error(`Drive API returned no webViewLink for "${name}"`);
    }
    return {
      id: created.data.id,
      webViewLink: created.data.webViewLink,
    };
  }
}
