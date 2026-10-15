import { describe, expect, it } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { assertNotSelfSignoff, assertRole, effectiveRoles } from '../src/mcp/tools/role-guard.js';

const base: Omit<TenantCtx, 'workspaces' | 'roles'> = {
  tenantId: 'default',
  userId: 'alice',
  async resolveSecret() {
    throw new Error('not used');
  },
};

const ctxWith = (roles: TenantCtx['roles'], workspaces?: TenantCtx['workspaces']): TenantCtx => ({
  ...base,
  roles,
  ...(workspaces ? { workspaces } : {}),
});

describe('effectiveRoles', () => {
  it('sin claim workspaces → usa los roles de tenant', () => {
    expect(effectiveRoles(ctxWith(['qa']), 'platform')).toEqual(['qa']);
  });

  it('con claim workspaces → mandan los roles de ese workspace', () => {
    const ctx = ctxWith(['qa', 'reviewer'], { platform: ['developer'] });
    expect(effectiveRoles(ctx, 'platform')).toEqual(['developer']);
  });

  it('con claim pero workspace ajeno → sin roles', () => {
    const ctx = ctxWith(['qa'], { platform: ['qa'] });
    expect(effectiveRoles(ctx, 'planning')).toEqual([]);
  });

  it('sin workspaceId → roles de tenant aunque haya claim', () => {
    const ctx = ctxWith(['qa'], { platform: ['developer'] });
    expect(effectiveRoles(ctx)).toEqual(['qa']);
  });
});

describe('assertRole', () => {
  it('rol habilitado → no bloquea', () => {
    expect(assertRole(ctxWith(['qa']), ['qa'], 'submit_qa_results')).toBeNull();
  });

  it('alguno de varios roles habilitados alcanza', () => {
    expect(assertRole(ctxWith(['tech-lead']), ['reviewer', 'tech-lead'], 'submit_review_outcome')).toBeNull();
  });

  it('rol ajeno → bloquea y nombra los roles que sí sirven', () => {
    const err = assertRole(ctxWith(['developer']), ['qa'], 'submit_qa_results');
    expect(err).toBeTypeOf('string');
    expect(err).toContain('qa');
    expect(err).toContain('developer');
  });

  it('fail-closed: ctx sin roles → bloquea', () => {
    expect(assertRole(ctxWith([]), ['qa'], 'submit_qa_results')).toBeTypeOf('string');
  });

  it('el rol se evalúa contra el workspace cuando hay claim', () => {
    const ctx = ctxWith(['qa'], { platform: ['developer'] });
    // roles de tenant dicen qa, pero en "platform" es developer
    expect(assertRole(ctx, ['qa'], 'submit_qa_results', 'platform')).toBeTypeOf('string');
    expect(assertRole(ctx, ['developer'], 'claim_story', 'platform')).toBeNull();
  });

  it('el mensaje nombra el workspace cuando se evalúa con scope', () => {
    const ctx = ctxWith(['qa'], { platform: ['developer'] });
    expect(assertRole(ctx, ['qa'], 'submit_qa_results', 'platform')).toContain('platform');
  });
});

describe('assertNotSelfSignoff', () => {
  it('el assignee no puede firmar su propia verificación', () => {
    const err = assertNotSelfSignoff(
      ctxWith(['qa']),
      { story_id: 'S-1', assignee: 'alice' },
      'submit_qa_results',
    );
    expect(err).toBeTypeOf('string');
    expect(err).toContain('S-1');
    expect(err).toContain('alice');
  });

  it('otra persona sí puede firmar', () => {
    expect(
      assertNotSelfSignoff(ctxWith(['qa']), { story_id: 'S-1', assignee: 'bob' }, 'submit_qa_results'),
    ).toBeNull();
  });

  it('story sin assignee → no hay contra qué comparar, no bloquea', () => {
    expect(assertNotSelfSignoff(ctxWith(['qa']), { story_id: 'S-1' }, 'submit_qa_results')).toBeNull();
  });
});
