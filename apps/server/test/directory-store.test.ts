import { describe, expect, it } from 'vitest';
import { InMemoryDirectoryStore } from '../src/oauth/directory-in-memory.js';

describe('InMemoryDirectoryStore (membresías N:M)', () => {
  it('una persona en varios workspaces con roles distintos', async () => {
    const s = new InMemoryDirectoryStore();
    await s.upsertMember({ email: 'Alice@Example.com', workspace_id: 'platform', roles: ['developer'] });
    await s.upsertMember({ email: 'alice@example.com', workspace_id: 'planning', roles: ['qa', 'reviewer'] });

    const ms = await s.listMemberships('ALICE@EXAMPLE.COM');
    expect(ms.map((m) => m.workspace_id).sort()).toEqual(['planning', 'platform']);
    const platform = ms.find((m) => m.workspace_id === 'platform');
    const planning = ms.find((m) => m.workspace_id === 'planning');
    expect(platform?.roles).toEqual(['developer']);
    expect(planning?.roles).toEqual(['qa', 'reviewer']);
    // el email se normaliza a minúsculas
    expect(ms.every((m) => m.email === 'alice@example.com')).toBe(true);
  });

  it('upsert por (email, workspace): reescribe roles sin tocar otras membresías', async () => {
    const s = new InMemoryDirectoryStore();
    await s.upsertMember({ email: 'a@d.com', workspace_id: 'platform', roles: ['developer'] });
    await s.upsertMember({ email: 'a@d.com', workspace_id: 'planning', roles: ['qa'] });
    await s.upsertMember({ email: 'a@d.com', workspace_id: 'platform', roles: ['tech-lead'] });

    const platform = (await s.listMemberships('a@d.com')).find((m) => m.workspace_id === 'platform');
    expect(platform?.roles).toEqual(['tech-lead']);
    // la otra membresía queda intacta
    expect((await s.listMembers('planning')).map((m) => m.email)).toEqual(['a@d.com']);
  });

  it('listMembers filtra por workspace', async () => {
    const s = new InMemoryDirectoryStore();
    await s.upsertMember({ email: 'a@d.com', workspace_id: 'platform', roles: ['developer'] });
    await s.upsertMember({ email: 'b@d.com', workspace_id: 'platform', roles: ['qa'] });
    await s.upsertMember({ email: 'c@d.com', workspace_id: 'planning', roles: ['developer'] });

    expect((await s.listMembers('platform')).map((m) => m.email).sort()).toEqual(['a@d.com', 'b@d.com']);
    expect((await s.listMembers('planning')).map((m) => m.email)).toEqual(['c@d.com']);
  });

  it('removeMember borra sólo la membresía puntual (email, workspace)', async () => {
    const s = new InMemoryDirectoryStore();
    await s.upsertMember({ email: 'a@d.com', workspace_id: 'platform', roles: ['developer'] });
    await s.upsertMember({ email: 'a@d.com', workspace_id: 'planning', roles: ['qa'] });

    expect(await s.removeMember('A@D.com', 'platform')).toBe(true);
    expect(await s.removeMember('a@d.com', 'platform')).toBe(false);

    const ms = await s.listMemberships('a@d.com');
    expect(ms.map((m) => m.workspace_id)).toEqual(['planning']);
  });
});
