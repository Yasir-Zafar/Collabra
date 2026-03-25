import { useState, useEffect, useCallback, useRef } from "react";
import socket from "./socket";
import Canvas from "./Canvas";

export default function Editor({ user, project: initialProject, onBack }) {
  const [project, setProject] = useState(initialProject);
  const [activeFileId, setActiveFileId] = useState(() => Object.keys(initialProject.files)[0]);
  const [locks, setLocks] = useState({});    // fileId -> { userId, userName, color }
  const [activeUsers, setActiveUsers] = useState([]);
  const [myColor, setMyColor] = useState("#6366f1");
  const [tool, setTool] = useState("select");
  const [toasts, setToasts] = useState([]);
  const toastId = useRef(0);

  const toast = useCallback((msg) => {
    const id = ++toastId.current;
    setToasts(t => [...t, { id, msg }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3500);
  }, []);

  // ── Socket setup ────────────────────────────────────────────────────────
  useEffect(() => {
    socket.emit("join_project", {
      userId: user.userId,
      userName: user.userName,
      projectId: project.id,
    });

    socket.on("init_state", ({ project: p, locks: l, color }) => {
      setProject(p);
      setLocks(l);
      setMyColor(color);
    });

    socket.on("users_update", (users) => setActiveUsers(users));

    socket.on("user_joined", ({ userName }) => toast(`${userName} joined`));
    socket.on("user_left",   ({ userId }) => {
      setActiveUsers(u => u.filter(x => x.userId !== userId));
    });

    socket.on("lock_acquired", ({ fileId, userId, userName, color }) => {
      setLocks(l => ({ ...l, [fileId]: { userId, userName, color } }));
      if (userId !== user.userId) toast(`${userName} started editing`);
    });

    socket.on("lock_released", ({ fileId }) => {
      setLocks(l => {
        const prev = l[fileId];
        if (prev && prev.userId !== user.userId) toast(`${prev.userName} finished editing`);
        const next = { ...l };
        delete next[fileId];
        return next;
      });
    });

    socket.on("lock_denied", ({ lockedBy }) => {
      toast(`${lockedBy} is currently editing — please wait`);
    });

    socket.on("shape_added", ({ fileId, shape }) => {
      setProject(p => addShapeToProject(p, fileId, shape));
    });

    socket.on("shape_updated", ({ fileId, shapeId, changes }) => {
      setProject(p => updateShapeInProject(p, fileId, shapeId, changes));
    });

    socket.on("shape_deleted", ({ fileId, shapeId }) => {
      setProject(p => deleteShapeInProject(p, fileId, shapeId));
    });

    socket.on("file_added", ({ file }) => {
      setProject(p => ({ ...p, files: { ...p.files, [file.id]: file } }));
    });

    return () => {
      socket.off("init_state");
      socket.off("users_update");
      socket.off("user_joined");
      socket.off("user_left");
      socket.off("lock_acquired");
      socket.off("lock_released");
      socket.off("lock_denied");
      socket.off("shape_added");
      socket.off("shape_updated");
      socket.off("shape_deleted");
      socket.off("file_added");
    };
  }, [project.id, user.userId, user.userName, toast]);

  // ── Lock helpers ─────────────────────────────────────────────────────────
  const activeLock = locks[activeFileId];
  const iHaveLock = activeLock?.userId === user.userId;
  const lockedByOther = activeLock && activeLock.userId !== user.userId;

  function tryAcquireLock() {
    if (iHaveLock) return true;
    if (lockedByOther) {
      toast(`${activeLock.userName} is editing — please wait`);
      return false;
    }
    socket.emit("acquire_lock", { fileId: activeFileId });
    return true; // optimistic; server may deny
  }

  function releaseLock() {
    socket.emit("release_lock", { fileId: activeFileId });
  }

  // ── Shape event handlers (go to server, server broadcasts back) ──────────
  function handleShapeAdd(shape) {
    if (!tryAcquireLock()) return;
    setProject(p => addShapeToProject(p, activeFileId, shape));
    socket.emit("shape_add", { fileId: activeFileId, shape });
  }

  function handleShapeUpdate(shapeId, changes) {
    if (!iHaveLock) return;
    setProject(p => updateShapeInProject(p, activeFileId, shapeId, changes));
    socket.emit("shape_update", { fileId: activeFileId, shapeId, changes });
  }

  function handleShapeDelete(shapeId) {
    if (!iHaveLock) { toast("Acquire the lock first to delete shapes"); return; }
    setProject(p => deleteShapeInProject(p, activeFileId, shapeId));
    socket.emit("shape_delete", { fileId: activeFileId, shapeId });
  }

  function addPage() {
    const name = `Page ${Object.keys(project.files).length + 1}`;
    socket.emit("add_file", { projectId: project.id, fileName: name });
  }

  const files = Object.values(project.files);
  const activeShapes = project.files[activeFileId]?.shapes ?? [];

  return (
    <div className="editor-bg">
      {/* ── Topbar ── */}
      <div className="topbar">
        <div className="top-left">
          <button className="btn-ghost" onClick={onBack}>← Back</button>
          <span className="project-title">✦ {project.name}</span>
        </div>

        <div className="file-tabs">
          {files.map(f => (
            <div
              key={f.id}
              className={`file-tab ${f.id === activeFileId ? "active" : ""}`}
              onClick={() => { releaseLock(); setActiveFileId(f.id); }}
            >
              {f.name}
              {locks[f.id] && (
                <span className="tab-lock" style={{ color: locks[f.id].color }} title={`${locks[f.id].userName} editing`}>
                  🔒
                </span>
              )}
            </div>
          ))}
          <div className="file-tab add-tab" onClick={addPage}>+</div>
        </div>

        <div className="top-right">
          <div className="active-users">
            {activeUsers.map(u => (
              <div key={u.userId} className="user-badge" style={{ background: u.color }} title={u.userName}>
                {u.userName[0].toUpperCase()}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Lock banner ── */}
      {lockedByOther && (
        <div className="lock-banner" style={{ borderColor: activeLock.color, background: activeLock.color + "18" }}>
          <span>🔒</span>
          <span><strong>{activeLock.userName}</strong> is editing — you are in view-only mode</span>
        </div>
      )}
      {iHaveLock && (
        <div className="my-lock-banner">
          <span>🔏 You have the edit lock</span>
          <button className="btn-release" onClick={releaseLock}>Release</button>
        </div>
      )}

      {/* ── Editor body ── */}
      <div className="editor-body">
        {/* Toolbar */}
        <div className="toolbar">
          {[
            { id: "select",  icon: "↖", label: "Select / Move" },
            { id: "rect",    icon: "▭", label: "Rectangle" },
            { id: "ellipse", icon: "○", label: "Ellipse" },
            { id: "diamond", icon: "◇", label: "Diamond" },
            { id: "line",    icon: "╱", label: "Line" },
            { id: "text",    icon: "T", label: "Text" },
            { id: "delete",  icon: "🗑", label: "Delete shape" },
          ].map(t => (
            <button
              key={t.id}
              title={t.label}
              className={`tool-btn ${tool === t.id ? "active" : ""}`}
              onClick={() => setTool(t.id)}
            >
              {t.icon}
            </button>
          ))}
        </div>

        {/* Canvas */}
        <div className="canvas-wrap">
          <Canvas
            shapes={activeShapes}
            tool={tool}
            myColor={myColor}
            locked={lockedByOther}
            onShapeAdd={handleShapeAdd}
            onShapeUpdate={handleShapeUpdate}
            onShapeDelete={handleShapeDelete}
          />
        </div>
      </div>

      {/* ── Status bar ── */}
      <div className="status-bar">
        <span>
          {lockedByOther
            ? `🔒 ${activeLock.userName} is editing`
            : iHaveLock
            ? "🔏 You are editing"
            : "Click a tool and draw to start — lock auto-acquired"}
        </span>
        <span className="status-right">
          {activeUsers.length} user{activeUsers.length !== 1 ? "s" : ""} online
        </span>
      </div>

      {/* ── Toasts ── */}
      <div className="toast-stack">
        {toasts.map(t => <div key={t.id} className="toast">{t.msg}</div>)}
      </div>
    </div>
  );
}

// ── Pure helpers ──────────────────────────────────────────────────────────
function addShapeToProject(p, fileId, shape) {
  if (!p.files[fileId]) return p;
  return { ...p, files: { ...p.files, [fileId]: { ...p.files[fileId], shapes: [...p.files[fileId].shapes, shape] } } };
}

function updateShapeInProject(p, fileId, shapeId, changes) {
  if (!p.files[fileId]) return p;
  const shapes = p.files[fileId].shapes.map(s => s.id === shapeId ? { ...s, ...changes } : s);
  return { ...p, files: { ...p.files, [fileId]: { ...p.files[fileId], shapes } } };
}

function deleteShapeInProject(p, fileId, shapeId) {
  if (!p.files[fileId]) return p;
  const shapes = p.files[fileId].shapes.filter(s => s.id !== shapeId);
  return { ...p, files: { ...p.files, [fileId]: { ...p.files[fileId], shapes } } };
}
