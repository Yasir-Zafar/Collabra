import { useState, useEffect } from "react";
import { API_BASE } from "./config";

export default function Dashboard({ user, onOpen }) {
  const [projects, setProjects] = useState([]);
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("authToken");
    fetch(`${API_BASE}/projects`, {
      headers: { "Authorization": `Bearer ${token}` },
    })
      .then(async (r) => {
        if (r.status === 401) {
          localStorage.removeItem("authToken");
          window.location.reload();
          return null;
        }
        return await r.json();
      })
      .then(data => {
        if (!data) return;
        setProjects(data);
        setLoading(false);
      });
  }, []);

  async function createProject() {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const token = localStorage.getItem("authToken");
    const res = await fetch(`${API_BASE}/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ name: trimmed }),
    });
    if (res.status === 401) {
      localStorage.removeItem("authToken");
      window.location.reload();
      return;
    }
    const project = await res.json();
    setProjects(p => [...p, { id: project.id, name: project.name, ownerName: project.ownerName, fileCount: 1 }]);
    setNewName("");
  }

  function handleLogout() {
    localStorage.removeItem("authToken");
    window.location.reload();
  }

  const BG_COLORS = ["#6366f1","#f59e0b","#10b981","#ef4444","#3b82f6"];

  return (
    <div className="dash-bg">
      <header className="dash-header">
        <div className="logo">
          <span className="logo-icon">✦</span>
          <span className="logo-text">Collabra</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div className="dash-user">
            <div className="avatar">{user.userName[0].toUpperCase()}</div>
            <span>{user.userName}</span>
          </div>
          <button className="btn-ghost" onClick={handleLogout}>Logout</button>
        </div>
      </header>

      <main className="dash-main">
        <div className="dash-top">
          <h1 className="dash-title">Projects</h1>
          <div className="new-project-row">
            <input
              className="input"
              placeholder="New project name…"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && createProject()}
            />
            <button className="btn-primary" onClick={createProject}>+ Create</button>
          </div>
        </div>

        {loading ? (
          <p className="muted">Loading…</p>
        ) : (
          <div className="project-grid">
            {projects.map((p, i) => (
              <div key={p.id} className="project-card" onClick={() => onOpen(p)}>
                <div className="project-thumb" style={{ background: BG_COLORS[i % BG_COLORS.length] }}>
                  <span className="project-thumb-letter">{p.name[0]}</span>
                </div>
                <div className="project-info">
                  <div className="project-name">{p.name}</div>
                  <div className="project-meta">{p.fileCount} page{p.fileCount !== 1 ? "s" : ""} · by {p.ownerName}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
