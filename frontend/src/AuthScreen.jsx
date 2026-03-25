import { useState } from "react";

export default function AuthScreen({ onLogin }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState("");

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) { setErr("Please enter your name."); return; }
    // Simple: userId is just lowercased name, good enough for a prototype
    onLogin({ userId: trimmed.toLowerCase().replace(/\s+/g, "_"), userName: trimmed });
  }

  return (
    <div className="auth-bg">
      <div className="auth-card">
        <div className="logo">
          <span className="logo-icon">✦</span>
          <span className="logo-text">Collabra</span>
        </div>
        <p className="tagline">Real-time collaborative graphics editor</p>
        <input
          className="input"
          placeholder="Enter your display name"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === "Enter" && submit()}
          autoFocus
        />
        {err && <p className="err">{err}</p>}
        <button className="btn-primary" onClick={submit}>Enter</button>
      </div>
    </div>
  );
}
