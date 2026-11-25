import type { DocPublishInput, DocRef, DocStoreAdapter, DocStoreKind } from '@sdlc/adapters-contracts';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import type { Flow } from '@sdlc/core';
import type { IntegrationConfigStore } from '../integrations/types.js';
import { GoogleDriveDocStoreAdapter } from './google-drive-docstore.js';
import { GitHubRepoDocStoreAdapter } from './github-repo-docstore.js';

export interface DocStoreProvider {
  resolve(ctx: TenantCtx, flow: Flow): Promise<DocStoreAdapter>;
}

export interface ConfigBackedDocStoreProviderDeps {
  configStore: IntegrationConfigStore;
}

export class ConfigBackedDocStoreProvider implements DocStoreProvider {
  constructor(private readonly deps: ConfigBackedDocStoreProviderDeps) {}

  async resolve(ctx: TenantCtx, flow: Flow): Promise<DocStoreAdapter> {
    const cfg = await this.deps.configStore.getDocStoreConfig(ctx.tenantId, flow.project);
    if (!cfg || cfg.kind === 'repo') {
      return new NoOpDocStoreAdapter();
    }
    switch (cfg.kind) {
      case 'google-drive': {
        if (!cfg.secret_ref) {
          throw new Error(
            'google-drive doc_store requires a secret_ref for the credentials JSON ' +
              '(service_account or authorized_user)',
          );
        }
        // Sin default: un workspace sin destino explícito publicaría en la unidad de otro
        // workspace (o de otro cliente). Mejor fallar al resolver que filtrar documentos.
        const s = cfg.settings ?? {};
        const hasShared = typeof s.sharedDriveId === 'string' && s.sharedDriveId !== '';
        const hasFolder = typeof s.rootFolderId === 'string' && s.rootFolderId !== '';
        if (hasShared === hasFolder) {
          throw new Error(
            'google-drive doc_store requires exactly one of settings.sharedDriveId ' +
              '(shared drive) or settings.rootFolderId (My Drive folder, "root" for its top)',
          );
        }
        const credentialsJson = await ctx.resolveSecret(cfg.secret_ref);
        return new GoogleDriveDocStoreAdapter({
          credentialsJson,
          location: hasShared
            ? { sharedDriveId: s.sharedDriveId as string }
            : { rootFolderId: s.rootFolderId as string },
        });
      }
      case 'github-repo': {
        if (!cfg.secret_ref) {
          throw new Error('github-repo doc_store requires a secret_ref for the GitHub token');
        }
        const s = cfg.settings ?? {};
        if (typeof s.owner !== 'string' || typeof s.repo !== 'string') {
          throw new Error('github-repo doc_store requires settings.owner and settings.repo');
        }
        const token = await ctx.resolveSecret(cfg.secret_ref);
        return new GitHubRepoDocStoreAdapter({
          token,
          owner: s.owner,
          repo: s.repo,
          ...(typeof s.branch === 'string' ? { branch: s.branch } : {}),
          ...(typeof s.basePath === 'string' ? { basePath: s.basePath } : {}),
          ...(typeof s.apiBaseUrl === 'string' ? { apiBaseUrl: s.apiBaseUrl } : {}),
        });
      }
      default:
        throw new Error(`unknown doc_store kind: ${cfg.kind}`);
    }
  }
}

/**
 * Discriminante explícito del doc store no-op.
 *
 * Mismo criterio (y mismo motivo) que `isNoOpPullRequestAdapter`: las tools que
 * cierran un gate necesitan poder distinguirlo del adapter real —el no-op no
 * publica nada y devuelve un DocRef stub, así que dejarlo pasar en submit_adr
 * fabrica un registro fantasma—. Se expone como propiedad en vez de resolverlo
 * con `instanceof` porque `instanceof` se rompe silenciosamente cuando el módulo
 * se carga dos veces (ESM + CJS, o dobles de test) y la dirección del fallo es
 * fail-open: el no-op pasaría por adapter real.
 */
export function isNoOpDocStoreAdapter(adapter: DocStoreAdapter): boolean {
  return (adapter as Partial<NoOpDocStoreAdapter>).is_noop === true;
}

/**
 * No-op fallback used when no doc_store is configured for the tenant/project.
 * Returns a stub DocRef so the tool flow continues without Drive publication.
 */
export class NoOpDocStoreAdapter implements DocStoreAdapter {
  readonly kind: DocStoreKind = 'repo';

  /** Marca leída por `isNoOpDocStoreAdapter`; ver el comentario de esa función. */
  readonly is_noop = true as const;

  async publish(_input: DocPublishInput, _ctx: TenantCtx): Promise<DocRef> {
    return { id: 'noop', url: '' };
  }

  async fetch(_id: string, _ctx: TenantCtx): Promise<{ markdown: string; version: string }> {
    return { markdown: '', version: 'noop' };
  }
}
