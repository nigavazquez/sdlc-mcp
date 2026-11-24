export interface WorkspaceRecord {
  workspace_id: string;
  name: string;
  group_id?: string;
  /** Si quien implementa una historia puede firmar su propio QA y review (default true). */
  self_signoff: boolean;
  created_at: string;
}

/** Un cambio de configuración de un workspace, como queda en la auditoría. */
export interface WorkspaceSettingAudit {
  workspace_id: string;
  setting: 'self_signoff';
  old_value: unknown;
  new_value: unknown;
  actor: string;
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
  /**
   * Cambia `self_signoff` y lo audita en la misma operación. Si el valor no cambia no
   * escribe auditoría. Devuelve el workspace actualizado, o undefined si no existe.
   */
  setSelfSignoff(workspaceId: string, enabled: boolean, actor: string): Promise<WorkspaceRecord | undefined>;
  listSettingsAudit(workspaceId: string): Promise<WorkspaceSettingAudit[]>;
  listGroups(): Promise<GroupRecord[]>;
  /** Throws si el group ya existe. */
  createGroup(input: { group_id: string; name: string }): Promise<GroupRecord>;
}
