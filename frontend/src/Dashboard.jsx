import { useState, useEffect } from "react";
import { API_BASE, withApiHeaders } from "./config";

const FALLBACK_TEMPLATES = [
  { id: "blank", name: "Blank", description: "Start with an empty canvas.", fileCount: 1 },
  { id: "poster-starter", name: "Poster Starter", description: "Title/subtitle poster layout.", fileCount: 1 },
  { id: "social-pack", name: "Social Media Pack", description: "Post + story pages.", fileCount: 2 },
];

export default function Dashboard({ user, onOpen }) {
  const [projects, setProjects] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [selectedTemplate, setSelectedTemplate] = useState("blank");
  const [templatesFromFallback, setTemplatesFromFallback] = useState(false);
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function loadDashboard() {
      const token = localStorage.getItem("authToken");
      try {
        const projectsRes = await fetch(`${API_BASE}/projects`, {
          headers: withApiHeaders({ "Authorization": `Bearer ${token}` }),
        });
        if (projectsRes.status === 401) {
          localStorage.removeItem("authToken");
          window.location.reload();
          return;
        }
        const projectsData = await projectsRes.json();
        if (!cancelled) setProjects(Array.isArray(projectsData) ? projectsData : []);
      } catch {
        if (!cancelled) setProjects([]);
      }

      try {
        const templatesRes = await fetch(`${API_BASE}/templates`, {
          headers: withApiHeaders({ "Authorization": `Bearer ${token}` }),
        });
        if (templatesRes.status === 401) {
          localStorage.removeItem("authToken");
          window.location.reload();
          return;
        }
        if (!templatesRes.ok) throw new Error("Templates unavailable");
        const templatesData = await templatesRes.json();
        if (!cancelled) {
          const templateList = Array.isArray(templatesData) ? templatesData : [];
          if (templateList.length > 0) {
            setTemplates(templateList);
            setSelectedTemplate(templateList[0].id);
            setTemplatesFromFallback(false);
          } else {
            setTemplates(FALLBACK_TEMPLATES);
            setSelectedTemplate(FALLBACK_TEMPLATES[0].id);
            setTemplatesFromFallback(true);
          }
        }
      } catch {
        if (!cancelled) {
          setTemplates(FALLBACK_TEMPLATES);
          setSelectedTemplate(FALLBACK_TEMPLATES[0].id);
          setTemplatesFromFallback(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadDashboard();
    return () => {
      cancelled = true;
    };
  }, []);

  async function createProject() {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const token = localStorage.getItem("authToken");
    const res = await fetch(`${API_BASE}/projects`, {
      method: "POST",
      headers: withApiHeaders({
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      }),
      body: JSON.stringify({ name: trimmed, templateId: selectedTemplate }),
    });
    if (res.status === 401) {
      localStorage.removeItem("authToken");
      window.location.reload();
      return;
    }
    const project = await res.json();
    setProjects(p => [...p, {
      id: project.id,
      name: project.name,
      ownerId: project.ownerId,
      isOwner: true,
      ownerName: project.ownerName,
      fileCount: Object.keys(project.files || {}).length || 1,
      myRole: "editor",
    }]);
    setNewName("");
  }

  async function deleteProject(projectId) {
    const ok = window.confirm("Delete this project permanently?");
    if (!ok) return;
    const token = localStorage.getItem("authToken");
    const res = await fetch(`${API_BASE}/projects/${projectId}`, {
      method: "DELETE",
      headers: withApiHeaders({ "Authorization": `Bearer ${token}` }),
    });
    if (res.status === 401) {
      localStorage.removeItem("authToken");
      window.location.reload();
      return;
    }
    if (!res.ok) return;
    setProjects(p => p.filter(x => String(x.id) !== String(projectId)));
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
            <select
              className="select"
              value={selectedTemplate}
              onChange={e => setSelectedTemplate(e.target.value)}
              title="Choose template"
            >
              {templates.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.fileCount})
                </option>
              ))}
            </select>
            <button className="btn-primary" onClick={createProject}>+ Create</button>
          </div>
        </div>
        {templatesFromFallback && (
          <p className="muted" style={{ padding: "0 0 14px 0" }}>
            Template list is in fallback mode. Restart backend to load server templates.
          </p>
        )}

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
                  <div className="project-name-row">
                    <div className="project-name">{p.name}</div>
                    {p.isOwner && (
                      <button
                        className="btn-danger btn-danger-sm"
                        onClick={(e) => { e.stopPropagation(); deleteProject(p.id); }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
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
