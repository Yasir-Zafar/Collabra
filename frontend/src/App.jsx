import { useState, useEffect } from "react";
import AuthScreen from "./AuthScreen";
import Dashboard from "./Dashboard";
import Editor from "./Editor";
import "./index.css";

export default function App() {
  const [user, setUser] = useState(null);
  const [openProject, setOpenProject] = useState(null);
  const [loading, setLoading] = useState(true);

  // Check for stored token on mount
  useEffect(() => {
    async function checkAuth() {
      const token = localStorage.getItem("authToken");
      if (!token) {
        setLoading(false);
        return;
      }

      try {
        const res = await fetch("http://localhost:3001/auth/verify", {
          method: "POST",
          headers: { "Authorization": `Bearer ${token}` },
        });

        if (res.ok) {
          const data = await res.json();
          setUser(data.user);
        } else {
          localStorage.removeItem("authToken");
        }
      } catch (err) {
        console.error("Auth check error:", err);
        localStorage.removeItem("authToken");
      } finally {
        setLoading(false);
      }
    }

    checkAuth();
  }, []);

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "#0f172a" }}>
        <p style={{ color: "#94a3b8" }}>Loading…</p>
      </div>
    );
  }

  if (!user) return <AuthScreen onLogin={setUser} />;
  if (openProject) return <Editor user={user} project={openProject} onBack={() => setOpenProject(null)} />;
  return <Dashboard user={user} onOpen={setOpenProject} />;
}
