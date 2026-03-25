import { useState } from "react";
import AuthScreen from "./AuthScreen";
import Dashboard from "./Dashboard";
import Editor from "./Editor";
import "./index.css";

export default function App() {
  const [user, setUser] = useState(null);
  const [openProject, setOpenProject] = useState(null);

  if (!user) return <AuthScreen onLogin={setUser} />;
  if (openProject) return <Editor user={user} project={openProject} onBack={() => setOpenProject(null)} />;
  return <Dashboard user={user} onOpen={setOpenProject} />;
}
