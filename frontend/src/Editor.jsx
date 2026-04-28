import { useState, useEffect, useCallback, useRef } from "react";
import { socket } from "./socket";
import Canvas from "./Canvas";
import MembersModal from "./MembersModal";
import { API_BASE, withApiHeaders } from "./config";

const PRESET_COLORS = ["#6366f1","#ef4444","#f59e0b","#10b981","#3b82f6","#ec4899","#1e293b","#ffffff"];

export default function Editor({ user, project: initialProject, onBack }) {
  const [project, setProject]           = useState(null);
  const [activeFileId, setActiveFileId] = useState(null);
  const [locks, setLocks]               = useState({});
  const [activeUsers, setActiveUsers]   = useState([]);
  const [fileWatchers, setFileWatchers] = useState([]);
  const [editingUserId, setEditingUserId] = useState(null);
  const [myRole, setMyRole]             = useState("viewer");
  const [loadErr, setLoadErr]           = useState("");
  const [tool, setTool]                 = useState("select");
  const [fillColor, setFillColor]       = useState("#6366f1");
  const [toasts, setToasts]             = useState([]);
  const [membersOpen, setMembersOpen]   = useState(false);
  const [acquiring, setAcquiring]       = useState(false);
  const [rtStatus, setRtStatus]         = useState({ connected: socket.connected, err: "" });
  const [driveStatus, setDriveStatus]   = useState({ configured: false, linked: false, loading: false, syncing: false, googleEmail: "", lastError: "" });
  const toastId    = useRef(0);
  const historyRef = useRef({}); // { [fileId]: { past[], future[] } }
  const joinedRef  = useRef(false);
  const activeFileIdRef = useRef(null);
  const joinedFileRef = useRef(null);

  function getHistory(fileId) {
    if (!historyRef.current[fileId]) historyRef.current[fileId] = { past: [], future: [] };
    return historyRef.current[fileId];
  }

  const toast = useCallback((msg) => {
    const id = ++toastId.current;
    setToasts(t => [...t, { id, msg }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3500);
  }, []);

  const forceRelogin = useCallback(() => {
    localStorage.removeItem("authToken");
    // Hard reload to re-enter App's auth gate.
    window.location.reload();
  }, []);

  const loadDriveStatus = useCallback(async (projectId) => {
    if (!projectId) return;
    const token = localStorage.getItem("authToken");
    setDriveStatus((s) => ({ ...s, loading: true }));
    try {
      const res = await fetch(`${API_BASE}/integrations/google-drive/status/${projectId}`, {
        headers: withApiHeaders({ "Authorization": `Bearer ${token}` }),
      });
      if (res.status === 401) { forceRelogin(); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to load Drive status");
      setDriveStatus((s) => ({
        ...s,
        loading: false,
        configured: Boolean(data.configured),
        linked: Boolean(data.linked),
        googleEmail: data.googleEmail || "",
        lastError: data.lastError || "",
      }));
    } catch (err) {
      setDriveStatus((s) => ({ ...s, loading: false, lastError: err.message || "Drive status unavailable" }));
    }
  }, [forceRelogin]);

  // ── Socket ────────────────────────────────────────────────────────────────
  useEffect(() => {
    joinedRef.current = false;
    setProject(null);
    setActiveFileId(null);
    setLoadErr("");
    setRtStatus({ connected: socket.connected, err: "" });

    let cancelled = false;
    async function loadViaRest() {
      try {
        const token = localStorage.getItem("authToken");
        const res = await fetch(`${API_BASE}/projects/${initialProject.id}`, {
          headers: withApiHeaders({ "Authorization": `Bearer ${token}` }),
        });
        if (res.status === 401) { forceRelogin(); return; }
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Failed to load project");
        if (cancelled) return;
        setProject(data);
        const firstFileId = Object.keys(data.files || {})[0] || null;
        setActiveFileId(firstFileId);
        setMyRole(data.myRole || "viewer");
      } catch (e) {
        if (cancelled) return;
        setLoadErr(e?.message || "Failed to load project");
      }
    }

    // Load immediately via REST so we never depend on socket timing.
    loadViaRest();

    socket.on("init_state", ({ project: p, locks: l, myRole: role }) => {
      setProject(p);
      setLocks(l);
      setActiveFileId(Object.keys(p.files)[0] || null);
      setMyRole(role || "viewer");
    });

    socket.on("users_update", (users) => setActiveUsers(users));
    socket.on("active-users", (users) => setFileWatchers(Array.isArray(users) ? users : []));
    socket.on("editing-user", (uid) => setEditingUserId(uid || null));
    socket.on("user_joined",  ({ userName }) => toast(`${userName} joined`));
    socket.on("user_left",    ({ userId })   => setActiveUsers(u => u.filter(x => x.userId !== userId)));
    socket.on("error_msg",    (msg) => toast(String(msg || "Error")));
    socket.on("connect", () => setRtStatus(s => ({ ...s, connected: true, err: "" })));
    socket.on("disconnect", () => setRtStatus(s => ({ ...s, connected: false })));
    socket.on("connect_error", (err) => {
      const msg = err?.message ? String(err.message) : "Socket error";
      setRtStatus({ connected: false, err: msg });
      toast(`Socket: ${msg}`);
      if (msg.toLowerCase().includes("unauthorized")) {
        forceRelogin();
      }
    });

    function joinOnce() {
      if (joinedRef.current) return;
      joinedRef.current = true;
      socket.emit("join_project", { projectId: initialProject.id });
    }

    if (socket.connected) {
      joinOnce();
    } else {
      // Ensure auth token is present even on hard refresh/navigation.
      const token = localStorage.getItem("authToken");
      if (token) socket.auth = { token };
      socket.once("connect", joinOnce);
      socket.connect();
    }

    socket.on("lock_acquired", ({ fileId, userId, userName, color }) => {
      setLocks(l => ({ ...l, [fileId]: { userId, userName, color } }));
      setAcquiring(false);
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
      cancelled = true;
      // Flush/cleanup: release any lock we might hold so server persists snapshot.
      const fid = activeFileIdRef.current;
      if (fid) socket.emit("release_lock", { fileId: fid });
      ["init_state","users_update","active-users","editing-user","user_joined","user_left","lock_acquired","lock_released",
        "lock_denied","shape_added","shape_updated","shape_deleted","snapshot","file_added","error_msg","connect_error","connect","disconnect"]
          .forEach(ev => socket.off(ev));
      socket.off("connect", joinOnce);
      socket.off("connect_error");
    };
  }, [initialProject.id, user.userId, user.userName, toast, forceRelogin]);

  useEffect(() => {
    if (!project?.id) return;
    loadDriveStatus(project.id);
  }, [project?.id, loadDriveStatus]);

  useEffect(() => {
    function onOAuthMessage(event) {
      const data = event?.data;
      if (!data || data.source !== "collabra-drive-oauth") return;
      if (data.success) toast("Google Drive connected");
      else toast(data.message || "Google Drive connection failed");
      if (project?.id) loadDriveStatus(project.id);
    }
    window.addEventListener("message", onOAuthMessage);
    return () => window.removeEventListener("message", onOAuthMessage);
  }, [project?.id, loadDriveStatus, toast]);

  // Join/leave per-file room for watchers + editing status.
  useEffect(() => {
    if (!rtStatus.connected) return;
    if (!activeFileId) return;
    if (!socket.connected) return;

    const prev = joinedFileRef.current;
    if (prev && prev !== activeFileId) {
      socket.emit("leave_file", { fileId: prev });
    }
    joinedFileRef.current = activeFileId;
    socket.emit("join_file", { fileId: activeFileId });
  }, [activeFileId, rtStatus.connected]);

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
  const viewOnly      = myRole !== "editor";
  const canRequestLock = !viewOnly && !iHaveLock && !lockedByOther;

  function tryAcquireLock() {
    if (viewOnly) { toast("View only"); return false; }
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
    if (!iHaveLock) { toast("Acquire the lock to edit"); return; }
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
    if (!iHaveLock) { toast("Acquire the lock to edit"); return; }
    snapshotBefore();
    setProject(p => deleteShape(p, activeFileId, shapeId));
    socket.emit("shape_delete", { fileId: activeFileId, shapeId });
  }

  function addPage() {
    if (viewOnly) return;
    socket.emit("add_file_v2", { fileName: `Page ${Object.keys(project.files).length + 1}` });
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

  function exportProjectPackage() {
    if (!project?.files) return;
    (async () => {
      try {
        const { default: JSZip } = await import("jszip");
        const zip = new JSZip();
        const files = Object.values(project.files);
        files.forEach((file, idx) => {
          const shapes = Array.isArray(file.shapes) ? file.shapes : [];
          const svg = buildSvgFromShapes(shapes);
          const safePageName = String(file.name || `Page ${idx + 1}`).replace(/[^\w.-]+/g, "_");
          zip.file(`${String(idx + 1).padStart(2, "0")}_${safePageName}.svg`, svg);
        });

        const zipBlob = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement("a");
        const safeProjectName = String(project.name || "project").replace(/[^\w.-]+/g, "_");
        a.href = url;
        a.download = `${safeProjectName}_images.zip`;
        a.click();
        URL.revokeObjectURL(url);
      } catch {
        toast("Install frontend dependency: npm i jszip");
      }
    })();
  }

  async function renameProject() {
    if (!isOwner) return;
    const nextName = window.prompt("Rename project", project.name)?.trim();
    if (!nextName || nextName === project.name) return;
    try {
      const token = localStorage.getItem("authToken");
      const res = await fetch(`${API_BASE}/projects/${project.id}`, {
        method: "PATCH",
        headers: withApiHeaders({
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        }),
        body: JSON.stringify({ name: nextName }),
      });
      if (res.status === 401) { forceRelogin(); return; }
      const data = await res.json();
      if (!res.ok) {
        toast(data?.error || "Rename failed");
        return;
      }
      setProject(p => ({ ...p, name: data.name }));
      toast("Project renamed");
    } catch (err) {
      toast(`Rename failed: ${err.message}`);
    }
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

  async function connectGoogleDrive() {
    if (!project?.id) return;
    const token = localStorage.getItem("authToken");
    try {
      const res = await fetch(`${API_BASE}/integrations/google-drive/auth-url`, {
        method: "POST",
        headers: withApiHeaders({
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        }),
        body: JSON.stringify({ projectId: project.id }),
      });
      if (res.status === 401) { forceRelogin(); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to start Google Drive auth");
      const popup = window.open(data.authUrl, "collabra-drive-auth", "width=560,height=720");
      if (!popup) toast("Popup blocked. Allow popups and try again.");
    } catch (err) {
      toast(err.message || "Failed to connect Google Drive");
    }
  }

  async function syncGoogleDriveNow() {
    if (!project?.id || !driveStatus.linked) return;
    const token = localStorage.getItem("authToken");
    setDriveStatus((s) => ({ ...s, syncing: true }));
    try {
      const res = await fetch(`${API_BASE}/integrations/google-drive/sync/${project.id}`, {
        method: "POST",
        headers: withApiHeaders({ "Authorization": `Bearer ${token}` }),
      });
      if (res.status === 401) { forceRelogin(); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Drive sync failed");
      toast("Synced to Google Drive");
      await loadDriveStatus(project.id);
    } catch (err) {
      toast(err.message || "Drive sync failed");
    } finally {
      setDriveStatus((s) => ({ ...s, syncing: false }));
    }
  }

  async function disconnectGoogleDrive() {
    if (!project?.id || !driveStatus.linked) return;
    const confirm = window.confirm("Disconnect Google Drive for this project?");
    if (!confirm) return;
    const token = localStorage.getItem("authToken");
    try {
      const res = await fetch(`${API_BASE}/integrations/google-drive/${project.id}`, {
        method: "DELETE",
        headers: withApiHeaders({ "Authorization": `Bearer ${token}` }),
      });
      if (res.status === 401) { forceRelogin(); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to disconnect Google Drive");
      toast("Google Drive disconnected");
      await loadDriveStatus(project.id);
    } catch (err) {
      toast(err.message || "Failed to disconnect Google Drive");
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (loadErr) {
    return (
      <div style={{ height:"100vh", display:"flex", flexDirection:"column", gap:10, alignItems:"center", justifyContent:"center", background:"#0f172a", color:"#94a3b8", fontSize:14, padding:24, textAlign:"center" }}>
        <div style={{ color:"#e2e8f0", fontSize:16, fontWeight:600 }}>Couldn’t open project</div>
        <div style={{ maxWidth: 560 }}>{loadErr}</div>
        <button className="btn-primary" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }

  if (!project || !activeFileId) {
    return (
        <div style={{ height:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:"#0f172a", color:"#64748b", fontSize:14 }}>
          Connecting…
        </div>
    );
  }

  const files        = Object.values(project.files);
  const activeShapes = project.files[activeFileId]?.shapes ?? [];
  activeFileIdRef.current = activeFileId;
  const h            = getHistory(activeFileId);
  const canUndo      = iHaveLock && h.past.length > 0;
  const canRedo      = iHaveLock && h.future.length > 0;
  const isOwner      = String(project.ownerId) === String(user.userId);
  const editingLabel =
    lockedByOther ? `${activeLock.userName}`
      : iHaveLock ? "You"
        : editingUserId ? (fileWatchers.find(u => String(u.userId) === String(editingUserId))?.userName || "Someone")
          : "No one";

  return (
      <div className="editor-bg">

        {/* Topbar */}
        <div className="topbar">
          <div className="top-left">
            <button className="btn-ghost" onClick={onBack}>← Back</button>
            <span className="project-title">{project.name}</span>
            {isOwner && <button className="topbar-btn" onClick={renameProject}>Rename</button>}
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
            {!viewOnly && <div className="file-tab add-tab" onClick={addPage}>+</div>}
          </div>

          <div className="top-right">
            <button className="topbar-btn" onClick={() => setMembersOpen(true)}>
              Members
            </button>
            {driveStatus.configured ? (
              <>
                <button className="topbar-btn" onClick={connectGoogleDrive} disabled={driveStatus.loading}>
                  {driveStatus.linked ? "Reconnect Drive" : "Connect Drive"}
                </button>
                <button className="topbar-btn" onClick={syncGoogleDriveNow} disabled={!driveStatus.linked || driveStatus.syncing}>
                  {driveStatus.syncing ? "Syncing..." : "Sync Drive"}
                </button>
                <button className="topbar-btn" onClick={disconnectGoogleDrive} disabled={!driveStatus.linked}>
                  Disconnect Drive
                </button>
              </>
            ) : null}
            <button className="topbar-btn" onClick={exportCanvas}>Export SVG</button>
            <button className="topbar-btn" onClick={exportProjectPackage}>Export Project</button>
            {!viewOnly && (
              <label className="topbar-btn" style={{ cursor:"pointer" }}>
                Add Image
                <input type="file" accept="image/*" style={{ display:"none" }} onChange={handleImageUpload} />
              </label>
            )}
            <div className="top-divider" />
            <div className="active-users">
              {fileWatchers.map(u => (
                  <div key={u.userId} className="user-badge" style={{ background: u.color }} title={u.userName}>
                    {u.userName[0].toUpperCase()}
                  </div>
              ))}
            </div>
          </div>
        </div>

        {/* Collab bar (explicit lock control) */}
        <div className="collab-bar">
          <div className="collab-left">
            <span className="collab-pill">Watching: {fileWatchers.length}</span>
            <span className="collab-pill">Editing: {editingLabel}</span>
            <span className="collab-pill">
              Realtime: {rtStatus.connected ? "connected" : "offline"}
            </span>
            {driveStatus.configured && (
              <span className="collab-pill">
                Drive: {driveStatus.linked ? `linked (${driveStatus.googleEmail || "account"})` : "not linked"}
              </span>
            )}
          </div>
          <div className="collab-right">
            {viewOnly ? (
              <span className="collab-muted">View only</span>
            ) : iHaveLock ? (
              <button className="btn-release" onClick={releaseLock}>Release lock</button>
            ) : (
              <button
                className="btn-primary"
                onClick={() => { setAcquiring(true); tryAcquireLock(); }}
                disabled={!canRequestLock || acquiring}
              >
                {acquiring ? "Acquiring…" : lockedByOther ? "Locked" : "Acquire lock"}
              </button>
            )}
          </div>
        </div>

        <MembersModal
          open={membersOpen}
          onClose={() => setMembersOpen(false)}
          projectId={project.id}
          isOwner={isOwner}
        />

        {/* Lock banners */}
        {lockedByOther && (
            <div className="lock-banner" style={{ borderColor: activeLock.color, background: activeLock.color + "18" }}>
              <strong>{activeLock.userName}</strong>&nbsp;is editing — view only
            </div>
        )}
        {viewOnly && !lockedByOther && (
          <div className="lock-banner" style={{ borderColor: "#475569", background: "#47556918" }}>
            View only
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
              { id:"brush",   icon:"✎", label:"Brush" },
              { id:"text",    icon:"T", label:"Text" },
              { id:"delete",  icon:"✕", label:"Delete shape" },
            ].map(t => (
                <button key={t.id} title={t.label}
                        className={`tool-btn ${tool === t.id ? "active" : ""}`}
                        onClick={() => !viewOnly && setTool(t.id)}
                        style={viewOnly ? { opacity: 0.4, cursor: "not-allowed" } : undefined}>
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
              locked={lockedByOther || viewOnly || !iHaveLock}
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

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildSvgFromShapes(shapes, width = 900, height = 600) {
  const body = (Array.isArray(shapes) ? shapes : [])
    .map(shapeToSvg)
    .filter(Boolean)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white" />${body}</svg>`;
}

function shapeToSvg(s) {
  if (!s || !s.type) return "";
  if (s.type === "rect") {
    return `<rect x="${Number(s.x) || 0}" y="${Number(s.y) || 0}" width="${Math.max(0, Number(s.w) || 0)}" height="${Math.max(0, Number(s.h) || 0)}" rx="4" fill="${esc(s.fill || "#ffffff")}" stroke="${esc(s.stroke || "#000000")}" stroke-width="${Number(s.sw) || 1}" />`;
  }
  if (s.type === "diamond") {
    const x = Number(s.x) || 0;
    const y = Number(s.y) || 0;
    const w = Math.max(0, Number(s.w) || 0);
    const h = Math.max(0, Number(s.h) || 0);
    const cx = x + w / 2;
    const cy = y + h / 2;
    return `<polygon points="${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}" fill="${esc(s.fill || "#ffffff")}" stroke="${esc(s.stroke || "#000000")}" stroke-width="${Number(s.sw) || 1}" />`;
  }
  if (s.type === "ellipse") {
    return `<ellipse cx="${Number(s.cx) || 0}" cy="${Number(s.cy) || 0}" rx="${Math.max(0, Number(s.rx) || 0)}" ry="${Math.max(0, Number(s.ry) || 0)}" fill="${esc(s.fill || "#ffffff")}" stroke="${esc(s.stroke || "#000000")}" stroke-width="${Number(s.sw) || 1}" />`;
  }
  if (s.type === "line") {
    return `<line x1="${Number(s.x1) || 0}" y1="${Number(s.y1) || 0}" x2="${Number(s.x2) || 0}" y2="${Number(s.y2) || 0}" stroke="${esc(s.stroke || "#000000")}" stroke-width="${Number(s.sw) || 1}" stroke-linecap="round" />`;
  }
  if (s.type === "brush") {
    const points = Array.isArray(s.points)
      ? s.points.map(p => `${Number(p?.x) || 0},${Number(p?.y) || 0}`).join(" ")
      : "";
    if (!points) return "";
    return `<polyline points="${points}" fill="none" stroke="${esc(s.stroke || "#000000")}" stroke-width="${Number(s.sw) || 3}" stroke-linecap="round" stroke-linejoin="round" />`;
  }
  if (s.type === "text") {
    return `<text x="${Number(s.x) || 0}" y="${Number(s.y) || 0}" font-size="${Number(s.fontSize) || 20}" fill="${esc(s.fill || "#000000")}" font-family="system-ui,sans-serif">${esc(s.text || "")}</text>`;
  }
  if (s.type === "image") {
    return `<image href="${esc(s.href || "")}" x="${Number(s.x) || 0}" y="${Number(s.y) || 0}" width="${Math.max(0, Number(s.w) || 0)}" height="${Math.max(0, Number(s.h) || 0)}" />`;
  }
  return "";
}