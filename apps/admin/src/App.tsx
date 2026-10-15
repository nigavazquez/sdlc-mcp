import { useEffect, useState } from 'react';
import { HashRouter, Link, Route, Routes, useNavigate } from 'react-router-dom';
import { api, DEFAULT_LABELS } from './api';
import type { Labels } from './api';
import { Login } from './pages/Login';
import { Workspaces } from './pages/Workspaces';
import { WorkspaceDetail } from './pages/WorkspaceDetail';
import { FlowDetail } from './pages/FlowDetail';

function TopBar() {
  const navigate = useNavigate();
  return (
    <header className="topbar">
      <Link to="/">SDLC Admin</Link>
      <button
        onClick={() => {
          void api.logout().finally(() => navigate('/login'));
        }}
      >
        Salir
      </button>
    </header>
  );
}

export function App() {
  const [labels, setLabels] = useState<Labels>(DEFAULT_LABELS);

  useEffect(() => {
    api
      .meta()
      .then((r) => setLabels(r.labels))
      .catch(() => {
        // Silently fall back to defaults if meta fails (e.g. not authenticated yet)
      });
  }, []);

  return (
    <HashRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="*"
          element={
            <>
              <TopBar />
              <div className="container">
                <Routes>
                  <Route path="/" element={<Workspaces labels={labels} />} />
                  <Route path="/workspaces/:id" element={<WorkspaceDetail labels={labels} />} />
                  <Route path="/flows/:flowId" element={<FlowDetail />} />
                </Routes>
              </div>
            </>
          }
        />
      </Routes>
    </HashRouter>
  );
}
