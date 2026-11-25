import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type WorkspaceSummary, type Labels } from '../api';
import { selfSignoffOf } from '../self-signoff';

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function Workspaces({ labels }: { labels: Labels }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const wsPlural = cap(labels.workspace.plural);
  const wsSingular = cap(labels.workspace.singular);

  const reload = () => {
    api
      .workspaces()
      .then((r) => setWorkspaces(r.workspaces))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'error'));
  };

  useEffect(reload, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.createWorkspace(workspaceId.trim(), name.trim());
      setWorkspaceId('');
      setName('');
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'error');
    }
  };

  return (
    <>
      <h1>{wsPlural}</h1>
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>{wsSingular}</th>
              <th>Nombre</th>
              <th>Miembros</th>
              <th>Integración</th>
              <th>QA y review propios</th>
            </tr>
          </thead>
          <tbody>
            {workspaces.map((ws) => (
              <tr key={ws.workspace_id}>
                <td>
                  <Link to={`/workspaces/${ws.workspace_id}`}>{ws.workspace_id}</Link>
                </td>
                <td>{ws.name}</td>
                <td>{ws.members}</td>
                <td>{ws.integrations ? 'sí' : <span className="muted">no</span>}</td>
                <td>{selfSignoffOf(ws) ? 'permitidos' : <span className="muted">no</span>}</td>
              </tr>
            ))}
            {workspaces.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  Sin {labels.workspace.plural} todavía.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h2>Nuevo {labels.workspace.singular}</h2>
        <form className="inline" onSubmit={create}>
          <input
            placeholder="workspace_id (kebab-case)"
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            pattern="[a-z0-9_-]+"
            required
          />
          <input placeholder="Nombre" value={name} onChange={(e) => setName(e.target.value)} required />
          <button className="btn">Crear</button>
        </form>
        {error && <p className="error">{error}</p>}
      </div>
    </>
  );
}
