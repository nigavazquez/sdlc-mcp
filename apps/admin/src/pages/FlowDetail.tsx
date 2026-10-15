import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError, type FlowDetail as FlowDetailData } from '../api';

/** pr_url es input de tenants (report_progress); solo se linkea si es http(s). */
function safeHttpUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export function FlowDetail() {
  const { flowId } = useParams<{ flowId: string }>();
  const [data, setData] = useState<FlowDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!flowId) return;
    api
      .flow(flowId)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'error'));
  }, [flowId]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Cargando…</p>;

  const { flow, stories, events } = data;

  return (
    <>
      <h1>{String(flow.title)}</h1>
      <div className="card">
        <span className="badge">{String(flow.status)}</span>{' '}
        <span className="badge">fase: {String(flow.current_phase)}</span>{' '}
        {flow.architecture_mode != null && <span className="badge">arch: {String(flow.architecture_mode)}</span>}{' '}
        {flow.epic_external_id != null && <span className="badge">epic: {String(flow.epic_external_id)}</span>}
      </div>

      <div className="card">
        <h2>Stories</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Título</th>
              <th>Status</th>
              <th>Componente</th>
              <th>PR</th>
            </tr>
          </thead>
          <tbody>
            {stories.map((s) => (
              <tr key={s.story_id}>
                <td>{s.title}</td>
                <td>
                  <span className="badge">{s.status}</span>
                </td>
                <td>{s.component ?? <span className="muted">—</span>}</td>
                <td>
                  {safeHttpUrl(s.pr_url) ? (
                    <a href={safeHttpUrl(s.pr_url)!} target="_blank" rel="noreferrer">
                      PR
                    </a>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
            {stories.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  Sin stories.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Eventos</h2>
        <ul className="timeline">
          {events.map((e, i) => (
            <li key={i}>
              <span className="ts">{new Date(e.ts).toLocaleString()}</span>
              <strong>{e.type}</strong> <span className="muted">por {e.actor}</span>
              <details>
                <summary className="muted">payload</summary>
                <pre>{JSON.stringify(e.payload, null, 2)}</pre>
              </details>
            </li>
          ))}
          {events.length === 0 && <li className="muted">Sin eventos.</li>}
        </ul>
      </div>
    </>
  );
}
