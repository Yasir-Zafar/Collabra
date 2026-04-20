import { useEffect, useMemo, useState } from "react";
import { API_BASE } from "./config";
import { socket } from "./socket";

export default function MembersModal({ open, onClose, projectId, isOwner }) {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("editor");
  const [inviteLoading, setInviteLoading] = useState(false);

  const token = useMemo(() => localStorage.getItem("authToken"), []);

  async function loadMembers() {
    setErr("");
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/projects/${projectId}/members`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to load members");
      setMembers(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e?.message || "Failed to load members");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    loadMembers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  useEffect(() => {
    if (!open) return;
    function onMembersUpdated(payload) {
      if (!payload?.projectId) return;
      if (String(payload.projectId) !== String(projectId)) return;
      loadMembers();
    }
    socket.on("members_updated", onMembersUpdated);
    return () => socket.off("members_updated", onMembersUpdated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === "Escape") onClose?.();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function invite() {
    const email = inviteEmail.trim();
    if (!email) return;
    setInviteLoading(true);
    setErr("");
    try {
      const res = await fetch(`${API_BASE}/projects/${projectId}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ email, role: inviteRole }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Invite failed");
      setInviteEmail("");
      await loadMembers();
    } catch (e) {
      setErr(e?.message || "Invite failed");
    } finally {
      setInviteLoading(false);
    }
  }

  async function updateRole(userId, role) {
    setErr("");
    try {
      const res = await fetch(`${API_BASE}/projects/${projectId}/members/${userId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ role }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to update role");
      setMembers(ms => ms.map(m => (String(m.userId) === String(userId) ? { ...m, role } : m)));
    } catch (e) {
      setErr(e?.message || "Failed to update role");
    }
  }

  async function removeMember(userId) {
    setErr("");
    try {
      const res = await fetch(`${API_BASE}/projects/${projectId}/members/${userId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to remove member");
      setMembers(ms => ms.filter(m => String(m.userId) !== String(userId)));
    } catch (e) {
      setErr(e?.message || "Failed to remove member");
    }
  }

  if (!open) return null;

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-label="Project members">
        <div className="modal-head">
          <div className="modal-title">Members</div>
          <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {isOwner && (
          <div className="invite-row">
            <input
              className="input"
              placeholder="Invite by email…"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && invite()}
            />
            <select className="select" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
            <button className="btn-primary" onClick={invite} disabled={inviteLoading || !inviteEmail.trim()}>
              {inviteLoading ? "Inviting…" : "Invite"}
            </button>
          </div>
        )}

        {err && <div className="modal-err">{err}</div>}

        <div className="members-list">
          {loading ? (
            <div className="muted" style={{ padding: 0 }}>Loading…</div>
          ) : members.length === 0 ? (
            <div className="muted" style={{ padding: 0 }}>No members found.</div>
          ) : (
            members.map((m) => (
              <div key={m.userId} className="member-row">
                <div className="member-main">
                  <div className="member-name">
                    {m.userName} {m.isOwner ? <span className="pill">Owner</span> : null}
                  </div>
                  <div className="member-email">{m.email}</div>
                </div>

                <div className="member-actions">
                  {m.isOwner ? (
                    <span className="role-readonly">owner</span>
                  ) : isOwner ? (
                    <>
                      <select
                        className="select"
                        value={m.role}
                        onChange={(e) => updateRole(m.userId, e.target.value)}
                      >
                        <option value="editor">editor</option>
                        <option value="viewer">viewer</option>
                      </select>
                      <button className="btn-danger" onClick={() => removeMember(m.userId)}>Remove</button>
                    </>
                  ) : (
                    <span className="role-readonly">{m.role}</span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="modal-foot">
          <button className="btn-ghost" onClick={loadMembers}>Refresh</button>
          <button className="btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

