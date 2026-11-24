import type { AdminStore, GroupRecord, WorkspaceRecord, WorkspaceSettingAudit } from './store.js';

/** In-memory AdminStore para dev/tests (mismo rol que InMemoryFlowStore). Arranca vacío. */
export class InMemoryAdminStore implements AdminStore {
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly groups = new Map<string, GroupRecord>();
  private readonly audit: WorkspaceSettingAudit[] = [];

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    return [...this.workspaces.values()];
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceRecord | undefined> {
    return this.workspaces.get(workspaceId);
  }

  async createWorkspace(input: { workspace_id: string; name: string; group_id?: string }): Promise<WorkspaceRecord> {
    if (this.workspaces.has(input.workspace_id)) {
      throw new Error(`Workspace "${input.workspace_id}" already exists`);
    }
    const record: WorkspaceRecord = {
      workspace_id: input.workspace_id,
      name: input.name,
      ...(input.group_id ? { group_id: input.group_id } : {}),
      self_signoff: true,
      created_at: new Date().toISOString(),
    };
    this.workspaces.set(input.workspace_id, record);
    return record;
  }

  async setSelfSignoff(workspaceId: string, enabled: boolean, actor: string): Promise<WorkspaceRecord | undefined> {
    const current = this.workspaces.get(workspaceId);
    if (!current) return undefined;
    if (current.self_signoff === enabled) return current;
    const updated = { ...current, self_signoff: enabled };
    this.workspaces.set(workspaceId, updated);
    this.audit.push({
      workspace_id: workspaceId,
      setting: 'self_signoff',
      old_value: current.self_signoff,
      new_value: enabled,
      actor,
      created_at: new Date().toISOString(),
    });
    return updated;
  }

  async listSettingsAudit(workspaceId: string): Promise<WorkspaceSettingAudit[]> {
    return this.audit.filter((a) => a.workspace_id === workspaceId);
  }

  async listGroups(): Promise<GroupRecord[]> {
    return [...this.groups.values()];
  }

  async createGroup(input: { group_id: string; name: string }): Promise<GroupRecord> {
    if (this.groups.has(input.group_id)) {
      throw new Error(`Group "${input.group_id}" already exists`);
    }
    const record: GroupRecord = {
      group_id: input.group_id,
      name: input.name,
      created_at: new Date().toISOString(),
    };
    this.groups.set(input.group_id, record);
    return record;
  }
}
