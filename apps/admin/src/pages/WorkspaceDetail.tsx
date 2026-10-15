import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, ROLE_IDS, type FlowSummary, type IntegrationRow, type MemberRecord, type Labels } from '../api';

type Tab = 'integration' | 'members' | 'flows';

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function WorkspaceDetail({ labels }: { labels: Labels }) {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('integration');
  if (!id) return null;
  return (
    <>
      <h1>
        {cap(labels.workspace.singular)} <code>{id}</code>
      </h1>
      <div className="tabs">
        <button className={tab === 'integration' ? 'active' : ''} onClick={() => setTab('integration')}>
          Integración
        </button>
        <button className={tab === 'members' ? 'active' : ''} onClick={() => setTab('members')}>
          Miembros
        </button>
        <button className={tab === 'flows' ? 'active' : ''} onClick={() => setTab('flows')}>
          Flows
        </button>
      </div>
      {tab === 'integration' && <IntegrationTab workspaceId={id} wsLabel={labels.workspace.singular} />}
      {tab === 'members' && <MembersTab workspaceId={id} wsLabel={labels.workspace.singular} />}
      {tab === 'flows' && <FlowsTab workspaceId={id} wsLabel={labels.workspace.singular} />}
    </>
  );
}

const INTEGRATION_PLACEHOLDER = JSON.stringify(
  {
    task_system: { kind: 'azure-devops', secret_ref: 'aws-sm://ado-pat#pat', settings: { org: 'acme', project: 'Demo' } },
    pr_provider: { kind: 'github', secret_ref: 'aws-sm://gh-token', settings: {} },
  },
  null,
  2,
);

function IntegrationTab({ workspaceId, wsLabel }: { workspaceId: string; wsLabel: string }) {
  const [row, setRow] = useState<IntegrationRow | null>(null);
  const [json, setJson] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api
      .integration(workspaceId)
      .then((r) => setRow(r.integration))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'error'));
  }, [workspaceId]);

  useEffect(reload, [reload]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    let config: unknown;
    try {
      config = JSON.parse(json);
    } catch {
      setError('JSON inválido');
      return;
    }
    try {
      await api.putIntegration(workspaceId, config);
      setJson('');
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'error');
    }
  };

  const remove = async () => {
    if (!window.confirm(`¿Borrar la integración del workspace "${workspaceId}"?`)) return;
    await api.deleteIntegration(workspaceId);
    reload();
  };

  const describe = (r: IntegrationRow) =>
    (['task_system', 'doc_store', 'pr_provider'] as const)
      .filter((k) => r.config[k])
      .map((k) => (
        <div key={k}>
          <span className="badge">{k}</span> {r.config[k]!.kind}
          {r.config[k]!.secret_ref && <span className="muted"> · {r.config[k]!.secret_ref}</span>}
        </div>
      ));

  return (
    <>
      <div className="card">
        {row ? (
          <>
            {describe(row)}
            <p>
              <button className="btn danger" onClick={() => void remove()}>
                Borrar
              </button>
            </p>
          </>
        ) : (
          <p className="muted">
            Sin integración. El {wsLabel} resuelve providers in-memory/no-op hasta que cargues una config.
          </p>
        )}
      </div>
      <div className="card">
        <h2>Upsert integración</h2>
        <p className="muted">
          Una config por {wsLabel}. Solo referencias de secretos (<code>aws-sm://...</code>) — el valor se crea en AWS
          Secrets Manager por consola/CLI. La fila reemplaza por completo la configuración del {wsLabel}.
        </p>
        <form onSubmit={save}>
          <textarea
            className="json"
            rows={10}
            placeholder={INTEGRATION_PLACEHOLDER}
            value={json}
            onChange={(e) => setJson(e.target.value)}
            required
          />
          <p>
            <button className="btn">Guardar</button>
          </p>
        </form>
        {error && <p className="error">{error}</p>}
      </div>
    </>
  );
}

function MembersTab({ workspaceId, wsLabel }: { workspaceId: string; wsLabel: string }) {
  const [members, setMembers] = useState<MemberRecord[]>([]);
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<string[]>(['developer']);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api
      .members(workspaceId)
      .then((r) => setMembers(r.members))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'error'));
  }, [workspaceId]);

  useEffect(reload, [reload]);

  const toggleRole = (role: string) => {
    setRoles((rs) => (rs.includes(role) ? rs.filter((r) => r !== role) : [...rs, role]));
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (roles.length === 0) {
      setError('Elegí al menos un rol');
      return;
    }
    try {
      await api.putMember(workspaceId, email.trim(), roles);
      setEmail('');
      setRoles(['developer']);
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'error');
    }
  };

  const remove = async (memberEmail: string) => {
    if (!window.confirm(`¿Dar de baja a ${memberEmail} de este workspace?`)) return;
    await api.removeMember(workspaceId, memberEmail);
    reload();
  };

  return (
    <>
      <div className="card">
        <p className="muted">
          El alta acá autoriza el login con Google en el MCP: el token del dev incluye este workspace y estos roles. Una
          persona puede pertenecer a varios workspaces con roles distintos.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Roles</th>
              <th>Alta</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.email}>
                <td>{m.email}</td>
                <td>
                  {m.roles.map((r) => (
                    <span key={r} className="badge" style={{ marginRight: 4 }}>
                      {r}
                    </span>
                  ))}
                </td>
                <td>{new Date(m.created_at).toLocaleDateString()}</td>
                <td>
                  <button className="btn danger" onClick={() => void remove(m.email)}>
                    Baja
                  </button>
                </td>
              </tr>
            ))}
            {members.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  Sin miembros. Nadie puede loguearse al MCP por este {wsLabel} todavía.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h2>Alta / actualización de miembro</h2>
        <form onSubmit={save}>
          <p>
            <input
              type="email"
              placeholder="persona@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={{ minWidth: 260 }}
            />
          </p>
          <p>
            {ROLE_IDS.map((r) => (
              <label key={r} style={{ marginRight: 12, fontSize: 14 }}>
                <input type="checkbox" checked={roles.includes(r)} onChange={() => toggleRole(r)} /> {r}
              </label>
            ))}
          </p>
          <button className="btn">Guardar</button>
        </form>
        {error && <p className="error">{error}</p>}
      </div>
    </>
  );
}

function FlowsTab({ workspaceId, wsLabel }: { workspaceId: string; wsLabel: string }) {
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .flows(workspaceId)
      .then((r) => setFlows(r.flows))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'error'));
  }, [workspaceId]);

  return (
    <div className="card">
      {error && <p className="error">{error}</p>}
      <table className="table">
        <thead>
          <tr>
            <th>Título</th>
            <th>Iniciativa</th>
            <th>Status</th>
            <th>Fase</th>
            <th>Actualizado</th>
          </tr>
        </thead>
        <tbody>
          {flows.map((f) => (
            <tr key={f.flow_id}>
              <td>
                <Link to={`/flows/${f.flow_id}`}>{f.title}</Link>
              </td>
              <td>{f.initiative_type ? <span className="badge">{f.initiative_type}</span> : <span className="muted">—</span>}</td>
              <td>
                <span className="badge">{f.status}</span>
              </td>
              <td>{f.current_phase}</td>
              <td>{new Date(f.updated_at).toLocaleString()}</td>
            </tr>
          ))}
          {flows.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                Sin flows para este {wsLabel}.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
