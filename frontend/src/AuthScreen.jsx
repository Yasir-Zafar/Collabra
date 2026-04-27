import { useEffect, useRef, useState } from "react";
import { connectSocketWithToken } from "./socket";
import { API_BASE, withApiHeaders } from "./config";

export default function AuthScreen({ onLogin }) {
  const [mode, setMode] = useState("login"); // "login" or "signup"
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const googleButtonRef = useRef(null);
  const googleConfigured = Boolean(import.meta.env.VITE_GOOGLE_CLIENT_ID);

  async function finishAuth(data) {
    localStorage.setItem("authToken", data.token);
    connectSocketWithToken(data.token);
    onLogin(data.user);
  }

  async function authRequest(path, body) {
    const headers = withApiHeaders({ "Content-Type": "application/json" });
    try {
      return await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (error) {
      // Common local-dev case: stale ngrok URL in VITE_API_BASE while API runs on localhost.
      if (!API_BASE.includes("ngrok")) throw error;
      return fetch(`http://localhost:3001${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
  }

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

      const res = await authRequest(url, body);

      const data = await res.json();
      if (!res.ok) {
        setErr(data.error || "Authentication failed");
        setLoading(false);
        return;
      }

      // Store token and call onLogin
      await finishAuth(data);
    } catch (e) {
      setErr("Network error: " + e.message);
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!googleConfigured) return undefined;
    const scriptId = "google-identity-script";
    let mounted = true;

    async function handleGoogleCredential(credential) {
      setErr("");
      setLoading(true);
      try {
        const res = await authRequest("/auth/google", { credential });
        const data = await res.json();
        if (!res.ok) {
          setErr(data.error || "Google Sign-in failed");
          setLoading(false);
          return;
        }
        await finishAuth(data);
      } catch (e) {
        setErr("Google Sign-in failed: " + e.message);
        setLoading(false);
      }
    }

    function renderGoogleButton() {
      if (!mounted || !googleButtonRef.current || !window.google?.accounts?.id) return;
      googleButtonRef.current.innerHTML = "";
      window.google.accounts.id.initialize({
        client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
        callback: (response) => handleGoogleCredential(response.credential),
      });
      window.google.accounts.id.renderButton(googleButtonRef.current, {
        type: "standard",
        shape: "pill",
        theme: "outline",
        text: mode === "login" ? "signin_with" : "signup_with",
        size: "large",
        width: 280,
      });
    }

    if (!document.getElementById(scriptId)) {
      const script = document.createElement("script");
      script.id = scriptId;
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      script.onload = renderGoogleButton;
      script.onerror = () => setErr("Failed to load Google Sign-in");
      document.head.appendChild(script);
    } else {
      renderGoogleButton();
    }

    return () => {
      mounted = false;
    };
  }, [googleConfigured, mode]);

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

        <div className="auth-divider">or</div>
        {!googleConfigured ? (
          <p className="muted">Google Sign-in is not configured.</p>
        ) : (
          <div className={`google-wrap ${loading ? "disabled" : ""}`}>
            <div ref={googleButtonRef} />
          </div>
        )}
      </div>
    </div>
  );
}
