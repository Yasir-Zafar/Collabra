import { useState, useEffect, useCallback, useRef } from "react";
import socket from "./socket";
import Canvas from "./Canvas";

const PRESET_COLORS = ["#6366f1","#ef4444","#f59e0b","#10b981","#3b82f6","#ec4899","#1e293b","#ffffff"];

export default function Editor({ user, project: initialProject, onBack }) {
  const [project, setProject]           = useState(null);
  const [activeFileId, setActiveFileId] = useState(null);
  const [locks, setLocks]               = useState({});
  const [activeUsers, setActiveUsers]   = useState([]);
  const [tool, setTool]                 = useState("select");
  const [fillColor, setFillColor]       = useState("#6366f1");
  const [toasts, setToasts]             = useState([]);
  const toastId    = useRef(0);
  const historyRef = useRef({}); // { [fileId]: { past[], future[] } }

  function getHistory(fileId) {
    if (!historyRef.current[fileId]) historyRef.current[fileId] = { past: [], future: [] };
    return historyRef.current[fileId];
  }

  const toast = useCallback((msg) => {
    const id = ++toastId.current;
    setToasts(t => [...t, { id, msg }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3500);
  }, []);

  // ── Socket ────────────────────────────────────────────────────────────────
  useEffect(() => {
    socket.emit("join_project", {
      userId: user.userId,
      userName: user.userName,
      projectId: initialProject.id,
    });

    socket.on("init_state", ({ project: p, locks: l }) => {
      setProject(p);
      setLocks(l);
      setActiveFileId(Object.keys(p.files)[0]);
    });

    socket.on("users_update", (users) => setActiveUsers(users));
    socket.on("user_joined",  ({ userName }) => toast(`${userName} joined`));
    socket.on("user_left",    ({ userId })   => setActiveUsers(u => u.filter(x => x.userId !== userId)));

    socket.on("lock_acquired", ({ fileId, userId, userName, color }) => {
      setLocks(l => ({ ...l, [fileId]: { userId, userName, color } }));
      if (userId !== user.userId) toast(`${userName} started editing`);
    });

    socket.on("lock_released", ({ fileId }) => {
      setLocks(l => {
        const prev = l[fileId];
        if (prev && prev.userId !== user.userId) toast(`${prev.userName} finished editing`);
        const next = { ...l }; delete next[fileId]; return next;
      });
    });

    socket.on("lock_denied",   ({ lockedBy }) => toast(`${lockedBy} is editing — please wait`));
    socket.on("shape_added",   ({ fileId, shape })             => setProject(p => addShape(p, fileId, shape)));
    socket.on("shape_updated", ({ fileId, shapeId, changes })  => setProject(p => updateShape(p, fileId, shapeId, changes)));
    socket.on("shape_deleted", ({ fileId, shapeId })           => setProject(p => deleteShape(p, fileId, shapeId)));
    socket.on("snapshot",      ({ fileId, shapes })            => setProject(p => setShapes(p, fileId, shapes)));
    socket.on("file_added",    ({ file })                      => setProject(p => ({ ...p, files: { ...p.files, [file.id]: file } })));

    return () => {
      ["init_state","users_update","user_joined","user_left","lock_acquired","lock_released",
        "lock_denied","shape_added","shape_updated","shape_deleted","snapshot","file_added"]
          .forEach(ev => socket.off(ev));
    };
  }, [initialProject.id, user.userId, user.userName, toast]);

  // ── Undo/redo keybinds ────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e) {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key === "z" && !e.shiftKey) { e.preventDefault(); doUndo(); }
      if ((e.key === "z" && e.shiftKey) || e.key === "y") { e.preventDefault(); doRedo(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ── Lock ──────────────────────────────────────────────────────────────────
  const activeLock    = locks[activeFileId];
  const iHaveLock     = activeLock?.userId === user.userId;
  const lockedByOther = !!(activeLock && activeLock.userId !== user.userId);

  function tryAcquireLock() {
    if (iHaveLock) return true;
    if (lockedByOther) { toast(`${activeLock.userName} is editing — please wait`); return false; }
    socket.emit("acquire_lock", { fileId: activeFileId });
    return true;
  }

  function releaseLock() { socket.emit("release_lock", { fileId: activeFileId }); }

  // ── History ───────────────────────────────────────────────────────────────
  function snapshotBefore() {
    if (!project || !activeFileId) return;
    const shapes = project.files[activeFileId]?.shapes ?? [];
    const h = getHistory(activeFileId);
    h.past.push(JSON.parse(JSON.stringify(shapes)));
    if (h.past.length > 50) h.past.shift();
    h.future = [];
  }

  function doUndo() {
    if (!iHaveLock || !project || !activeFileId) return;
    const h = getHistory(activeFileId);
    if (!h.past.length) return;
    const current = project.files[activeFileId]?.shapes ?? [];
    h.future.push(JSON.parse(JSON.stringify(current)));
    const prev = h.past.pop();
    setProject(p => setShapes(p, activeFileId, prev));
    socket.emit("snapshot", { fileId: activeFileId, shapes: prev });
  }

  function doRedo() {
    if (!iHaveLock || !project || !activeFileId) return;
    const h = getHistory(activeFileId);
    if (!h.future.length) return;
    const current = project.files[activeFileId]?.shapes ?? [];
    h.past.push(JSON.parse(JSON.stringify(current)));
    const next = h.future.pop();
    setProject(p => setShapes(p, activeFileId, next));
    socket.emit("snapshot", { fileId: activeFileId, shapes: next });
  }

  // ── Shapes ────────────────────────────────────────────────────────────────
  function handleShapeAdd(shape) {
    if (!tryAcquireLock()) return;
    snapshotBefore();
    setProject(p => addShape(p, activeFileId, shape));
    socket.emit("shape_add", { fileId: activeFileId, shape });
  }

  function handleShapeUpdate(shapeId, changes) {
    if (!iHaveLock) return;
    setProject(p => updateShape(p, activeFileId, shapeId, changes));
    socket.emit("shape_update", { fileId: activeFileId, shapeId, changes });
  }

  function handleShapeMoveStart() { snapshotBefore(); }

  function handleShapeDelete(shapeId) {
    if (!iHaveLock) { toast("Acquire the lock first to delete"); return; }
    snapshotBefore();
    setProject(p => deleteShape(p, activeFileId, shapeId));
    socket.emit("shape_delete", { fileId: activeFileId, shapeId });
  }

  function addPage() {
    socket.emit("add_file", { projectId: initialProject.id, fileName: `Page ${Object.keys(project.files).length + 1}` });
  }

  // Export: serialize the SVG with its actual viewBox so nothing is cut off
  function exportCanvas() {
    const svg = document.querySelector(".canvas-svg");
    if (!svg) return;
    // Clone so we can embed fonts/styles without modifying the live DOM
    const clone = svg.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const w = svg.getAttribute("width");
    const h = svg.getAttribute("height");
    clone.setAttribute("width", w);
    clone.setAttribute("height", h);
    clone.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `${project.name}.svg`; a.click();
    URL.revokeObjectURL(url);
  }

  function handleImageUpload(e) {
    const file = e.target.files[0];
    if (!file || !tryAcquireLock()) return;
    const reader = new FileReader();
    reader.onload = ev => handleShapeAdd({
      id: crypto.randomUUID(), type: "image",
      x: 80, y: 80, w: 200, h: 150, href: ev.target.result,
    });
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (!project || !activeFileId) {
    return (
        <div style={{ height:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:"#0f172a", color:"#64748b", fontSize:14 }}>
          Connecting…
        </div>
    );
  }

  const files        = Object.values(project.files);
  const activeShapes = project.files[activeFileId]?.shapes ?? [];
  const h            = getHistory(activeFileId);
  const canUndo      = iHaveLock && h.past.length > 0;
  const canRedo      = iHaveLock && h.future.length > 0;

  return (
      <div className="editor-bg">

        {/* Topbar */}
        <div className="topbar">
          <div className="top-left">
            <button className="btn-ghost" onClick={onBack}>← Back</button>
            <span className="project-title">{project.name}</span>
          </div>

          <div className="file-tabs">
            {files.map(f => (
                <div key={f.id}
                     className={`file-tab ${f.id === activeFileId ? "active" : ""}`}
                     onClick={() => { releaseLock(); setActiveFileId(f.id); }}>
                  {f.name}
                  {locks[f.id] && (
                      <span className="tab-lock" style={{ color: locks[f.id].color }}
                            title={`${locks[f.id].userName} editing`}>&#11044;</span>
                  )}
                </div>
            ))}
            <div className="file-tab add-tab" onClick={addPage}>+</div>
          </div>

          <div className="top-right">
            <button className="topbar-btn" onClick={exportCanvas}>Export SVG</button>
            <label className="topbar-btn" style={{ cursor:"pointer" }}>
              Add Image
              <input type="file" accept="image/*" style={{ display:"none" }} onChange={handleImageUpload} />
            </label>
            <div className="top-divider" />
            <div className="active-users">
              {activeUsers.map(u => (
                  <div key={u.userId} className="user-badge" style={{ background: u.color }} title={u.userName}>
                    {u.userName[0].toUpperCase()}
                  </div>
              ))}
            </div>
          </div>
        </div>

        {/* Lock banners */}
        {lockedByOther && (
            <div className="lock-banner" style={{ borderColor: activeLock.color, background: activeLock.color + "18" }}>
              <strong>{activeLock.userName}</strong>&nbsp;is editing — view only
            </div>
        )}
        {iHaveLock && (
            <div className="my-lock-banner">
              <span>You are editing</span>
              <button className="btn-release" onClick={releaseLock}>Release lock</button>
            </div>
        )}

        {/* Editor body */}
        <div className="editor-body">

          {/* Toolbar */}
          <div className="toolbar">
            {[
              { id:"select",  icon:"↖", label:"Select / Move" },
              { id:"rect",    icon:"▭", label:"Rectangle" },
              { id:"ellipse", icon:"○", label:"Ellipse" },
              { id:"diamond", icon:"◇", label:"Diamond" },
              { id:"line",    icon:"╱", label:"Line" },
              { id:"text",    icon:"T", label:"Text" },
              { id:"delete",  icon:"✕", label:"Delete shape" },
            ].map(t => (
                <button key={t.id} title={t.label}
                        className={`tool-btn ${tool === t.id ? "active" : ""}`}
                        onClick={() => setTool(t.id)}>
                  {t.icon}
                </button>
            ))}

            <div className="tool-sep" />

            <button className="tool-btn" title="Undo (Ctrl+Z)"
                    onClick={doUndo} style={{ opacity: canUndo ? 1 : 0.3, fontSize:15 }}>↩</button>
            <button className="tool-btn" title="Redo (Ctrl+Shift+Z)"
                    onClick={doRedo} style={{ opacity: canRedo ? 1 : 0.3, fontSize:15 }}>↪</button>

            <div className="tool-sep" />

            {/* Colour picker */}
            <div className="color-section">
              <div className="color-grid">
                {PRESET_COLORS.map(c => (
                    <button key={c} title={c}
                            className={`color-swatch ${fillColor === c ? "active" : ""}`}
                            style={{ background: c, outline: c === "#ffffff" ? "1px solid #475569" : "none" }}
                            onClick={() => setFillColor(c)}
                    />
                ))}
              </div>
              {/* Custom colour: preview swatch doubles as the color input trigger */}
              <label className="color-custom-row" title="Custom colour">
                <div className="color-preview" style={{ background: fillColor }} />
                <input type="color" className="color-custom-input"
                       value={fillColor} onChange={e => setFillColor(e.target.value)} />
              </label>
            </div>
          </div>

          {/* Canvas — now owns its wrapper div internally */}
          <Canvas
              shapes={activeShapes}
              tool={tool}
              myColor={fillColor}
              locked={lockedByOther}
              onAcquireLock={tryAcquireLock}
              onShapeAdd={handleShapeAdd}
              onShapeUpdate={handleShapeUpdate}
              onShapeMoveStart={handleShapeMoveStart}
              onShapeDelete={handleShapeDelete}
          />
        </div>

        {/* Status bar */}
        <div className="status-bar">
        <span>
          {lockedByOther
              ? `${activeLock.userName} is editing`
              : iHaveLock ? "You are editing" : "Select a tool and draw — lock acquired automatically"}
        </span>
          <span className="status-right">
          Ctrl+Z · Ctrl+Shift+Z &nbsp;|&nbsp;
            {activeUsers.length} user{activeUsers.length !== 1 ? "s" : ""} online
        </span>
        </div>

        {/* Toasts */}
        <div className="toast-stack">
          {toasts.map(t => <div key={t.id} className="toast">{t.msg}</div>)}
        </div>
      </div>
  );
}

// ── Pure helpers ──────────────────────────────────────────────────────────
function addShape(p, fileId, shape) {
  if (!p.files[fileId]) return p;
  return { ...p, files: { ...p.files, [fileId]: { ...p.files[fileId], shapes: [...p.files[fileId].shapes, shape] } } };
}
function updateShape(p, fileId, shapeId, changes) {
  if (!p.files[fileId]) return p;
  const shapes = p.files[fileId].shapes.map(s => s.id === shapeId ? { ...s, ...changes } : s);
  return { ...p, files: { ...p.files, [fileId]: { ...p.files[fileId], shapes } } };
}
function deleteShape(p, fileId, shapeId) {
  if (!p.files[fileId]) return p;
  const shapes = p.files[fileId].shapes.filter(s => s.id !== shapeId);
  return { ...p, files: { ...p.files, [fileId]: { ...p.files[fileId], shapes } } };
}
function setShapes(p, fileId, shapes) {
  if (!p.files[fileId]) return p;
  return { ...p, files: { ...p.files, [fileId]: { ...p.files[fileId], shapes } } };
}