import { useState } from "react";
import { connectSocketWithToken } from "./socket";

export default function AuthScreen({ onLogin }) {
  const [mode, setMode] = useState("login"); // "login" or "signup"
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    setErr("");
    
    if (mode === "login") {
      if (!email || !password) {
        setErr("Please enter email and password");
        return;
      }
    } else {
      if (!email || !displayName || !password) {
        setErr("Please fill in all fields");
        return;
      }
    }

    setLoading(true);
    try {
      const url = mode === "login" ? "/auth/login" : "/auth/signup";
      const body = mode === "login" 
        ? { email, password }
        : { email, displayName, password };

      const res = await fetch(`http://localhost:3001${url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        setErr(data.error || "Authentication failed");
        setLoading(false);
        return;
      }

      // Store token and call onLogin
      localStorage.setItem("authToken", data.token);
      connectSocketWithToken(data.token);
      onLogin(data.user);
    } catch (e) {
      setErr("Network error: " + e.message);
      setLoading(false);
    }
  }

  return (
    <div className="auth-bg">
      <div className="auth-card">
        <div className="logo">
          <span className="logo-icon">✦</span>
          <span className="logo-text">Collabra</span>
        </div>
        <p className="tagline">Real-time collaborative graphics editor</p>

        {/* Mode tabs */}
        <div className="auth-tabs">
          <button 
            className={`auth-tab ${mode === "login" ? "active" : ""}`}
            onClick={() => { setMode("login"); setErr(""); }}
          >
            Login
          </button>
          <button 
            className={`auth-tab ${mode === "signup" ? "active" : ""}`}
            onClick={() => { setMode("signup"); setErr(""); }}
          >
            Sign Up
          </button>
        </div>

        {/* Inputs */}
        <input
          className="input"
          placeholder="Email"
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleSubmit()}
          autoFocus
        />
        
        {mode === "signup" && (
          <input
            className="input"
            placeholder="Display Name"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSubmit()}
          />
        )}

        <input
          className="input"
          placeholder="Password"
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleSubmit()}
        />

        {err && <p className="err">{err}</p>}
        
        <button className="btn-primary" onClick={handleSubmit} disabled={loading}>
          {loading ? "Loading..." : (mode === "login" ? "Login" : "Sign Up")}
        </button>
      </div>
    </div>
  );
}
