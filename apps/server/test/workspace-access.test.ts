import { afterEach, describe, expect, it } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { assertWorkspaceAccess } from '../src/mcp/tools/workspace-access.js';

const base: Omit<TenantCtx, 'workspaces'> = {
  tenantId: 'default',
  userId: 'alice',
  roles: ['developer'],
  async resolveSecret() {
    throw new Error('not used');
  },
};

afterEach(() => {
  delete process.env.SDLC_ALLOW_UNSCOPED_CTX;
});

describe('assertWorkspaceAccess', () => {
  // Este test dice lo contrario de lo que decía antes. La versión anterior
  // ("sin claim workspaces en el ctx → no bloquea (tests/fakes)") fijaba un fail-open
  // deliberado: la guarda dejaba pasar cualquier ctx sin el claim para no romper los
  // flujos in-memory de tests y fakes. El costo real en producción era que un access
  // token válidamente firmado pero sin el claim —uno emitido antes de que el claim
  // existiera, o un refresh token de 30 días de esa época— pasaba TODAS las guardas de
  // workspace. Se invirtió el default: sin claim no se pasa, y el bypass quedó detrás
  // de SDLC_ALLOW_UNSCOPED_CTX (apagado por default, sólo tests/dev local).
  it('sin claim workspaces en el ctx → bloquea (antes era un fail-open deliberado)', () => {
    const err = assertWorkspaceAccess(base, 'platform');
    expect(err).toBeTypeOf('string');
    expect(err).toContain('platform');
    // El mensaje tiene que nombrar las dos salidas ejecutables.
    expect(err).toContain('login OAuth');
    expect(err).toContain('SDLC_ALLOW_UNSCOPED_CTX=true');
  });

  it('sin claim workspaces + SDLC_ALLOW_UNSCOPED_CTX=true → pasa (escape hatch de dev/tests)', () => {
    process.env.SDLC_ALLOW_UNSCOPED_CTX = 'true';
    expect(assertWorkspaceAccess(base, 'platform')).toBeNull();
  });

  it('sin claim workspaces + SDLC_ALLOW_UNSCOPED_CTX con un valor que no es true/1 → sigue bloqueando', () => {
    for (const raw of ['false', '0', 'yes', '']) {
      process.env.SDLC_ALLOW_UNSCOPED_CTX = raw;
      expect(assertWorkspaceAccess(base, 'platform'), `valor "${raw}"`).toBeTypeOf('string');
    }
  });

  it('el escape hatch NO afecta a un ctx con claim: workspace ajeno sigue bloqueado', () => {
    process.env.SDLC_ALLOW_UNSCOPED_CTX = 'true';
    const ctx: TenantCtx = { ...base, workspaces: { platform: ['developer'] } };
    expect(assertWorkspaceAccess(ctx, 'other-workspace')).toBeTypeOf('string');
  });

  it('con membresía en el squad → no bloquea', () => {
    const ctx: TenantCtx = { ...base, workspaces: { platform: ['developer'], planning: ['qa'] } };
    expect(assertWorkspaceAccess(ctx, 'platform')).toBeNull();
    expect(assertWorkspaceAccess(ctx, 'planning')).toBeNull();
  });

  it('workspace ajeno con claim presente → mensaje de error que nombra el squad', () => {
    const ctx: TenantCtx = { ...base, workspaces: { platform: ['developer'] } };
    const err = assertWorkspaceAccess(ctx, 'other-workspace');
    expect(err).toBeTypeOf('string');
    expect(err).toContain('other-workspace');
    // Lista los propios y nombra la salida (pedir la membresía).
    expect(err).toContain('platform');
    expect(err).toContain('panel admin');
  });

  it('claim workspaces vacío → bloquea cualquier squad y nombra la salida', () => {
    const ctx: TenantCtx = { ...base, workspaces: {} };
    const err = assertWorkspaceAccess(ctx, 'platform');
    expect(err).toBeTypeOf('string');
    expect(err).toContain('(ninguno)');
    expect(err).toContain('panel admin');
  });

  it('el label del workspace se refleja en el mensaje', () => {
    const err = assertWorkspaceAccess({ ...base, workspaces: {} }, 'platform', 'squad');
    expect(err).toContain('squad "platform"');
  });
});
