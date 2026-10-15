export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export interface WorkspaceSummary {
  workspace_id: string;
  name: string;
  created_at: string;
  members: number;
  integrations: number;
}

export interface MemberRecord {
  email: string;
  workspace_id: string;
  roles: string[];
  created_at: string;
}

export const ROLE_IDS = ['product-manager', 'tech-lead', 'pmo', 'developer', 'qa', 'reviewer'] as const;

export interface IntegrationRef {
  kind: string;
  secret_ref?: string;
  settings: Record<string, unknown>;
}

export interface IntegrationRow {
  tenant_id: string;
  project: string;
  config: { task_system?: IntegrationRef; doc_store?: IntegrationRef; pr_provider?: IntegrationRef };
}

export interface FlowSummary {
  flow_id: string;
  project: string;
  title: string;
  initiative_type: string | null;
  status: string;
  current_phase: string;
  updated_at: string;
}

export interface FlowDetail {
  flow: Record<string, unknown> & { flow_id: string; title: string; status: string; current_phase: string };
  stories: Array<
    Record<string, unknown> & {
      story_id: string;
      title: string;
      status: string;
      component: string | null;
      pr_url: string | null;
    }
  >;
  events: Array<{ type: string; actor: string; ts: string; payload: Record<string, unknown> }>;
}

export interface LabelPair {
  singular: string;
  plural: string;
}

export interface Labels {
  workspace: LabelPair;
  group: LabelPair;
}

export const DEFAULT_LABELS: Labels = {
  workspace: { singular: 'workspace', plural: 'workspaces' },
  group: { singular: 'group', plural: 'groups' },
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...(init?.body ? { headers: { 'content-type': 'application/json' } } : {}),
    ...init,
  });
  if (res.status === 401 && !path.endsWith('/login')) {
    window.location.hash = '#/login';
    throw new ApiError('not authenticated', 401);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(body.error ?? res.statusText, res.status);
  return body as T;
}

export const api = {
  meta: () => request<{ labels: Labels }>('/admin/api/meta'),
  me: () => request<{ email: string | null }>('/admin/api/me'),
  logout: () => request<{ ok: true }>('/admin/api/logout', { method: 'POST' }),
  workspaces: () => request<{ workspaces: WorkspaceSummary[] }>('/admin/api/workspaces'),
  createWorkspace: (workspace_id: string, name: string) =>
    request('/admin/api/workspaces', { method: 'POST', body: JSON.stringify({ workspace_id, name }) }),
  members: (s: string) => request<{ members: MemberRecord[] }>(`/admin/api/workspaces/${s}/members`),
  putMember: (s: string, email: string, roles: string[]) =>
    request<{ member: MemberRecord }>(`/admin/api/workspaces/${s}/members/${encodeURIComponent(email)}`, {
      method: 'PUT',
      body: JSON.stringify({ roles }),
    }),
  removeMember: (s: string, email: string) =>
    request(`/admin/api/workspaces/${s}/members/${encodeURIComponent(email)}`, { method: 'DELETE' }),
  integration: (s: string) => request<{ integration: IntegrationRow | null }>(`/admin/api/workspaces/${s}/integration`),
  putIntegration: (s: string, config: unknown) =>
    request(`/admin/api/workspaces/${s}/integration`, { method: 'PUT', body: JSON.stringify(config) }),
  deleteIntegration: (s: string) => request(`/admin/api/workspaces/${s}/integration`, { method: 'DELETE' }),
  flows: (s: string) => request<{ flows: FlowSummary[] }>(`/admin/api/workspaces/${s}/flows`),
  flow: (id: string) => request<FlowDetail>(`/admin/api/flows/${encodeURIComponent(id)}`),
};
