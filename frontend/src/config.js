export const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:3001";

export function withApiHeaders(headers = {}) {
  const merged = { ...headers };
  if (API_BASE.includes("ngrok")) {
    merged["ngrok-skip-browser-warning"] = "true";
  }
  return merged;
}

