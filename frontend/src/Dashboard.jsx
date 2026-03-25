import { useState, useEffect } from "react";

export default function Dashboard({ user, onOpen }) {
  const [projects, setProjects] = useState([]);
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("http://localhost:3001/projects")
      .then(r => r.json())
      .then(data => { setProjects(data); setLoading(false); });
  }, []);

  async function createProject() {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const res = await fetch("http://localhost:3001/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmed, userId: user.userId, userName: user.userName }),
    });
    const project = await res.json();
    setProjects(p => [...p, { id: project.id, name: project.name, ownerName: project.ownerName, fileCount: 1 }]);
    setNewName("");
  }

  const BG_COLORS = ["#6366f1","#f59e0b","#10b981","#ef4444","#3b82f6"];

  return (
    <div className="dash-bg">
      <header className="dash-header">
        <div className="logo">
          <span className="logo-icon">✦</span>
          <span className="logo-text">Collabra</span>
        </div>
        <div className="dash-user">
          <div className="avatar">{user.userName[0].toUpperCase()}</div>
          <span>{user.userName}</span>
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
