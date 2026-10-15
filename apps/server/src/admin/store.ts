export interface WorkspaceRecord {
  workspace_id: string;
  name: string;
  group_id?: string;
  created_at: string;
}

export interface GroupRecord {
  group_id: string;
  name: string;
  created_at: string;
}

/**
 * Workspaces administrados desde el panel. Son el eje del modelo (ver 0009_workspaces):
 * un tenant fijo y los workspaces como concepto de primera clase. En Postgres vienen
 * sembrados por la migración; el store in-memory arranca vacío (dev/tests).
 */
export interface AdminStore {
  listWorkspaces(): Promise<WorkspaceRecord[]>;
  getWorkspace(workspaceId: string): Promise<WorkspaceRecord | undefined>;
  /** Throws si el workspace ya existe. */
  createWorkspace(input: { workspace_id: string; name: string; group_id?: string }): Promise<WorkspaceRecord>;
  listGroups(): Promise<GroupRecord[]>;
  /** Throws si el group ya existe. */
  createGroup(input: { group_id: string; name: string }): Promise<GroupRecord>;
}
