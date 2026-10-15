import type { AdminStore, GroupRecord, WorkspaceRecord } from './store.js';

/** In-memory AdminStore para dev/tests (mismo rol que InMemoryFlowStore). Arranca vacío. */
export class InMemoryAdminStore implements AdminStore {
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly groups = new Map<string, GroupRecord>();

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
      created_at: new Date().toISOString(),
    };
    this.workspaces.set(input.workspace_id, record);
    return record;
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
