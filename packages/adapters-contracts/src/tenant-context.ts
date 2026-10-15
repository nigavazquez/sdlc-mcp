import type { RoleId } from '@sdlc/core';

export interface TenantCtx {
  tenantId: string;
  userId: string;
  roles: RoleId[];
  /**
   * Roles por workspace (claim del JWT). Sin este claim las guardas de workspace
   * bloquean (ver `assertWorkspaceAccess`): un token viejo sin el claim no pasa.
   * El bypass para tests/dev local es SDLC_ALLOW_UNSCOPED_CTX.
   */
  workspaces?: Record<string, RoleId[]>;
  /**
   * Resolves a credential reference (e.g. `vault://jira/cred-123`) to a concrete secret.
   * Implementations may hit Vault, AWS Secrets Manager, or an encrypted Postgres column.
   */
  resolveSecret(ref: string): Promise<string>;
}
