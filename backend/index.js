require("dotenv").config();
const dns = require("dns");
// Avoid flaky IPv6-only DNS results on some networks/routers.
dns.setDefaultResultOrder("ipv4first");

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const { OAuth2Client } = require("google-auth-library");
const { google } = require("googleapis");
const sql = require("./db.js");

const app = express();
app.use(cors());
app.use(express.json());
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const server = http.createServer(app);
const io = new Server(server, {
  // In dev, Vite may run on different localhost ports; allow any origin.
  cors: { origin: true, methods: ["GET", "POST"] },
});

// ── Hash password utilities ────────────────────────────────────────────
function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function idToString(v) {
  return typeof v === "bigint" ? v.toString() : v;
}

// ── In-memory state ──────────────────────────────────────────────────────
const sessions = {};  // socketId -> { userId, userName, color, projectId }
const locks = {};     // fileId  -> { userId, userName, color, socketId }
const tokens = {};    // token -> { userId, email, displayName, createdAt }
const saveTimers = {}; // fileId -> Timeout (debounced DB snapshot writes)
const fileStates = {}; // fileId -> shapes[] (in-memory working set for debounce)
const fileProjectMap = {}; // fileId -> projectId
const driveOauthStates = {}; // oauth state -> { userId, projectId, expiresAt }
const driveSyncTimers = {}; // projectId -> timeout
const driveSyncRunning = {}; // projectId -> boolean

const DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];
const DRIVE_CLIENT_ID = process.env.GOOGLE_DRIVE_CLIENT_ID || "";
const DRIVE_CLIENT_SECRET = process.env.GOOGLE_DRIVE_CLIENT_SECRET || "";
const DRIVE_REDIRECT_URI = process.env.GOOGLE_DRIVE_REDIRECT_URI || "";

const COLORS = ["#6366f1","#f59e0b","#10b981","#ef4444","#3b82f6","#ec4899","#14b8a6","#f97316"];
const assignedColors = {};
let colorIdx = 0;
function colorFor(userId) {
  if (!assignedColors[userId]) assignedColors[userId] = COLORS[colorIdx++ % COLORS.length];
  return assignedColors[userId];
}

function sanitizeFileName(value, fallback = "untitled") {
  const base = String(value || "").trim().replace(/[\\/:*?"<>|]+/g, "_");
  return base || fallback;
}

function escSvg(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shapeToSvg(s) {
  if (!s || !s.type) return "";
  if (s.type === "rect") {
    return `<rect x="${Number(s.x) || 0}" y="${Number(s.y) || 0}" width="${Math.max(0, Number(s.w) || 0)}" height="${Math.max(0, Number(s.h) || 0)}" rx="4" fill="${escSvg(s.fill || "#ffffff")}" stroke="${escSvg(s.stroke || "#000000")}" stroke-width="${Number(s.sw) || 1}" />`;
  }
  if (s.type === "diamond") {
    const x = Number(s.x) || 0;
    const y = Number(s.y) || 0;
    const w = Math.max(0, Number(s.w) || 0);
    const h = Math.max(0, Number(s.h) || 0);
    const cx = x + w / 2;
    const cy = y + h / 2;
    return `<polygon points="${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}" fill="${escSvg(s.fill || "#ffffff")}" stroke="${escSvg(s.stroke || "#000000")}" stroke-width="${Number(s.sw) || 1}" />`;
  }
  if (s.type === "ellipse") {
    return `<ellipse cx="${Number(s.cx) || 0}" cy="${Number(s.cy) || 0}" rx="${Math.max(0, Number(s.rx) || 0)}" ry="${Math.max(0, Number(s.ry) || 0)}" fill="${escSvg(s.fill || "#ffffff")}" stroke="${escSvg(s.stroke || "#000000")}" stroke-width="${Number(s.sw) || 1}" />`;
  }
  if (s.type === "line") {
    return `<line x1="${Number(s.x1) || 0}" y1="${Number(s.y1) || 0}" x2="${Number(s.x2) || 0}" y2="${Number(s.y2) || 0}" stroke="${escSvg(s.stroke || "#000000")}" stroke-width="${Number(s.sw) || 1}" stroke-linecap="round" />`;
  }
  if (s.type === "brush") {
    const points = Array.isArray(s.points)
      ? s.points.map((p) => `${Number(p?.x) || 0},${Number(p?.y) || 0}`).join(" ")
      : "";
    if (!points) return "";
    return `<polyline points="${points}" fill="none" stroke="${escSvg(s.stroke || "#000000")}" stroke-width="${Number(s.sw) || 3}" stroke-linecap="round" stroke-linejoin="round" />`;
  }
  if (s.type === "text") {
    return `<text x="${Number(s.x) || 0}" y="${Number(s.y) || 0}" font-size="${Number(s.fontSize) || 20}" fill="${escSvg(s.fill || "#000000")}" font-family="system-ui,sans-serif">${escSvg(s.text || "")}</text>`;
  }
  if (s.type === "image") {
    return `<image href="${escSvg(s.href || "")}" x="${Number(s.x) || 0}" y="${Number(s.y) || 0}" width="${Math.max(0, Number(s.w) || 0)}" height="${Math.max(0, Number(s.h) || 0)}" />`;
  }
  return "";
}

function buildSvgFromShapes(shapes, width = 900, height = 600) {
  const body = (Array.isArray(shapes) ? shapes : [])
    .map(shapeToSvg)
    .filter(Boolean)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white" />${body}</svg>`;
}

function isDriveConfigured() {
  return Boolean(DRIVE_CLIENT_ID && DRIVE_CLIENT_SECRET && DRIVE_REDIRECT_URI);
}

function createDriveOAuthClient() {
  return new google.auth.OAuth2(DRIVE_CLIENT_ID, DRIVE_CLIENT_SECRET, DRIVE_REDIRECT_URI);
}

async function ensureDriveIntegrationSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS drive_project_links (
      id BIGSERIAL PRIMARY KEY,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      google_email TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      scope TEXT,
      expiry_date BIGINT,
      drive_folder_id TEXT,
      drive_file_id TEXT,
      last_synced_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(project_id, user_id)
    )
  `;

  const columnTypes = await sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'drive_project_links'
      AND column_name IN ('project_id', 'user_id')
  `;
  const typeByColumn = {};
  for (const row of columnTypes) typeByColumn[row.column_name] = row.data_type;

  if (typeByColumn.project_id && typeByColumn.project_id !== "text") {
    await sql`ALTER TABLE drive_project_links ALTER COLUMN project_id TYPE TEXT USING project_id::text`;
  }
  if (typeByColumn.user_id && typeByColumn.user_id !== "text") {
    await sql`ALTER TABLE drive_project_links ALTER COLUMN user_id TYPE TEXT USING user_id::text`;
  }
}

const TEMPLATE_CATALOG = [
  {
    id: "blank",
    name: "Blank",
    description: "Start with an empty canvas.",
    files: [
      { name: "Page 1", shapes: [] },
    ],
  },
  {
    id: "poster-starter",
    name: "Poster Starter",
    description: "Title, subtitle, and accent blocks for quick poster drafts.",
    files: [
      {
        name: "Poster",
        shapes: [
          { id: "tpl-bg-1", type: "rect", x: 0, y: 0, w: 900, h: 600, fill: "#f8fafc", stroke: "#e2e8f0", sw: 1 },
          { id: "tpl-title-1", type: "text", x: 80, y: 130, text: "Your Event Title", fontSize: 48, fill: "#0f172a" },
          { id: "tpl-sub-1", type: "text", x: 80, y: 180, text: "Subtitle or date goes here", fontSize: 24, fill: "#475569" },
          { id: "tpl-accent-1", type: "rect", x: 80, y: 230, w: 320, h: 10, fill: "#6366f1", stroke: "#6366f1", sw: 1 },
          { id: "tpl-note-1", type: "text", x: 80, y: 540, text: "Edit text and colors to customize", fontSize: 18, fill: "#64748b" },
        ],
      },
    ],
  },
  {
    id: "social-pack",
    name: "Social Media Pack",
    description: "Two pages: post and story layout.",
    files: [
      {
        name: "Post",
        shapes: [
          { id: "tpl-post-bg", type: "rect", x: 0, y: 0, w: 900, h: 600, fill: "#111827", stroke: "#111827", sw: 1 },
          { id: "tpl-post-title", type: "text", x: 70, y: 110, text: "Launch Update", fontSize: 54, fill: "#f8fafc" },
          { id: "tpl-post-sub", type: "text", x: 70, y: 160, text: "Share your product highlight", fontSize: 24, fill: "#cbd5e1" },
          { id: "tpl-post-chip", type: "rect", x: 70, y: 200, w: 180, h: 42, fill: "#6366f1", stroke: "#6366f1", sw: 1 },
          { id: "tpl-post-chip-text", type: "text", x: 88, y: 228, text: "Call to Action", fontSize: 19, fill: "#ffffff" },
        ],
      },
      {
        name: "Story",
        shapes: [
          { id: "tpl-story-bg", type: "rect", x: 0, y: 0, w: 900, h: 600, fill: "#1e1b4b", stroke: "#1e1b4b", sw: 1 },
          { id: "tpl-story-card", type: "rect", x: 170, y: 80, w: 560, h: 430, fill: "#ffffff", stroke: "#e2e8f0", sw: 2 },
          { id: "tpl-story-title", type: "text", x: 220, y: 170, text: "Story Headline", fontSize: 42, fill: "#0f172a" },
          { id: "tpl-story-sub", type: "text", x: 220, y: 220, text: "Quick summary text block", fontSize: 22, fill: "#475569" },
        ],
      },
    ],
  },
];

function getTemplateById(templateId) {
  return TEMPLATE_CATALOG.find(t => t.id === templateId) || TEMPLATE_CATALOG[0];
}

// ── Per-file presence (watchers) ────────────────────────────────────────────
// fileId -> [{ userId, userName, color }]
const activeUsersByFile = {};
// fileId -> { [userId]: Set(socketId) }
const userSocketsByFile = {};

function ensureFilePresence(fileId) {
  if (!activeUsersByFile[fileId]) activeUsersByFile[fileId] = [];
  if (!userSocketsByFile[fileId]) userSocketsByFile[fileId] = {};
}

function emitActiveUsersForFile(io, fileId) {
  io.to(fileId).emit("active-users", activeUsersByFile[fileId] || []);
}

function removeSocketFromAllFiles(io, socketId) {
  for (const fileId of Object.keys(userSocketsByFile)) {
    const usersForFile = userSocketsByFile[fileId] || {};
    let changed = false;

    for (const userId of Object.keys(usersForFile)) {
      const set = usersForFile[userId];
      if (!set?.has(socketId)) continue;
      set.delete(socketId);
      changed = true;

      if (set.size === 0) {
        delete usersForFile[userId];
        activeUsersByFile[fileId] = (activeUsersByFile[fileId] || []).filter(u => String(u.userId) !== String(userId));
      }
    }

    if (changed) emitActiveUsersForFile(io, fileId);

    if (Object.keys(usersForFile).length === 0) {
      delete userSocketsByFile[fileId];
      if ((activeUsersByFile[fileId] || []).length === 0) delete activeUsersByFile[fileId];
    }
  }
}

function usersInProject(projectId) {
  return Object.values(sessions)
      .filter(s => s.projectId === projectId)
      .map(s => ({ userId: s.userId, userName: s.userName, color: s.color }));
}

async function loadProjectForUser({ projectId, userId }) {
  const access = await sql`
    SELECT
      p.id,
      p.name,
      p.owner_id,
      u.display_name AS owner_name,
      COALESCE(pm.role, 'viewer'::project_role) AS my_role
    FROM projects p
    JOIN users u ON u.id = p.owner_id
    LEFT JOIN project_members pm
      ON pm.project_id = p.id AND pm.user_id = ${userId}
    WHERE p.id = ${projectId}
      AND (p.owner_id = ${userId} OR pm.user_id IS NOT NULL)
    LIMIT 1
  `;
  if (!access.length) return null;

  const files = await sql`
    SELECT id, name, shapes
    FROM project_files
    WHERE project_id = ${projectId}
    ORDER BY created_at ASC
  `;

  const filesMap = {};
  for (const f of files) {
    fileProjectMap[f.id] = projectId;
    let shapes = [];
    if (Array.isArray(f.shapes)) {
      shapes = f.shapes;
    } else if (typeof f.shapes === "string") {
      try {
        const parsed = JSON.parse(f.shapes);
        shapes = Array.isArray(parsed) ? parsed : [];
      } catch {
        shapes = [];
      }
    } else if (f.shapes && typeof f.shapes === "object") {
      // Some clients return jsonb as plain JS objects/arrays
      shapes = Array.isArray(f.shapes) ? f.shapes : [];
    }

    console.log(`[db] load file ${f.id} "${f.name}": shapesType=${typeof f.shapes} shapesIsArray=${Array.isArray(f.shapes)} shapesLen=${Array.isArray(shapes) ? shapes.length : "n/a"}`);
    filesMap[f.id] = { id: f.id, name: f.name, shapes };
  }

  return {
    project: {
      id: access[0].id,
      name: access[0].name,
      ownerId: idToString(access[0].owner_id),
      ownerName: access[0].owner_name,
      files: filesMap,
    },
    role: access[0].my_role,
  };
}

async function getProjectIdForFile(fileId) {
  if (fileProjectMap[fileId]) return fileProjectMap[fileId];
  const rows = await sql`
    SELECT project_id
    FROM project_files
    WHERE id = ${fileId}
    LIMIT 1
  `;
  if (!rows.length) return null;
  fileProjectMap[fileId] = rows[0].project_id;
  return rows[0].project_id;
}

async function loadProjectSnapshot(projectId) {
  const rows = await sql`
    SELECT p.id, p.name, p.owner_id, u.display_name AS owner_name
    FROM projects p
    JOIN users u ON u.id = p.owner_id
    WHERE p.id = ${projectId}
    LIMIT 1
  `;
  if (!rows.length) return null;

  const files = await sql`
    SELECT id, name, shapes
    FROM project_files
    WHERE project_id = ${projectId}
    ORDER BY created_at ASC
  `;

  function normalizeShapes(rawShapes) {
    if (Array.isArray(rawShapes)) return rawShapes;
    if (typeof rawShapes === "string") {
      try {
        const parsed = JSON.parse(rawShapes);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    if (rawShapes && typeof rawShapes === "object") {
      return Array.isArray(rawShapes) ? rawShapes : [];
    }
    return [];
  }

  return {
    id: rows[0].id,
    name: rows[0].name,
    ownerId: idToString(rows[0].owner_id),
    ownerName: rows[0].owner_name,
    files: files.map((f) => ({
      id: idToString(f.id),
      name: f.name,
      shapes: normalizeShapes(f.shapes),
    })),
  };
}

async function getDriveLinksForProject(projectId) {
  return sql`
    SELECT *
    FROM drive_project_links
    WHERE project_id = ${projectId}
  `;
}

async function persistDriveLinkStatus(linkId, { error = null, synced = false }) {
  await sql`
    UPDATE drive_project_links
    SET
      updated_at = NOW(),
      last_error = ${error},
      last_synced_at = CASE WHEN ${synced} THEN NOW() ELSE last_synced_at END
    WHERE id = ${linkId}
  `;
}

async function persistDriveCredentials(linkId, credentials) {
  if (!credentials) return;
  await sql`
    UPDATE drive_project_links
    SET
      access_token = COALESCE(${credentials.access_token || null}, access_token),
      refresh_token = COALESCE(${credentials.refresh_token || null}, refresh_token),
      scope = COALESCE(${credentials.scope || null}, scope),
      expiry_date = COALESCE(${credentials.expiry_date || null}, expiry_date),
      updated_at = NOW()
    WHERE id = ${linkId}
  `;
}

async function ensureDriveMirrorForLink(link, snapshot) {
  const oauth = createDriveOAuthClient();
  oauth.setCredentials({
    access_token: link.access_token,
    refresh_token: link.refresh_token,
    expiry_date: link.expiry_date ? Number(link.expiry_date) : undefined,
    scope: link.scope || undefined,
  });
  const drive = google.drive({ version: "v3", auth: oauth });
  const folderName = String(snapshot.name || "Collabra Project");
  let folderId = link.drive_folder_id || null;

  if (!folderId) {
    const createdFolder = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
      },
      fields: "id",
    });
    folderId = createdFolder.data.id;
  } else {
    await drive.files.update({
      fileId: folderId,
      requestBody: { name: folderName },
    });
  }

  // Keep Drive mirror one-way and exact: clear old page exports, then re-upload current pages.
  const existing = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: "files(id,mimeType)",
    pageSize: 1000,
  });
  for (const file of existing.data.files || []) {
    if (file.mimeType === "application/vnd.google-apps.folder") continue;
    await drive.files.delete({ fileId: file.id });
  }

  const safeProjectName = sanitizeFileName(snapshot.name, "Project");
  const files = Array.isArray(snapshot.files) ? snapshot.files : [];
  for (let i = 0; i < files.length; i += 1) {
    const page = files[i];
    const safePageName = sanitizeFileName(page?.name, `Page_${i + 1}`);
    const svg = buildSvgFromShapes(Array.isArray(page?.shapes) ? page.shapes : []);
    const exportName = `${safeProjectName} - ${String(i + 1).padStart(2, "0")}_${safePageName}.svg`;

    await drive.files.create({
      requestBody: {
        name: exportName,
        parents: [folderId],
        mimeType: "image/svg+xml",
      },
      media: {
        mimeType: "image/svg+xml",
        body: svg,
      },
      fields: "id",
    });
  }

  await sql`
    UPDATE drive_project_links
    SET
      drive_folder_id = ${folderId},
      drive_file_id = NULL,
      access_token = COALESCE(${oauth.credentials.access_token || null}, access_token),
      refresh_token = COALESCE(${oauth.credentials.refresh_token || null}, refresh_token),
      expiry_date = COALESCE(${oauth.credentials.expiry_date || null}, expiry_date),
      scope = COALESCE(${oauth.credentials.scope || null}, scope),
      updated_at = NOW()
    WHERE id = ${link.id}
  `;
}

async function deleteDriveMirrorForLink(link) {
  if (!link.drive_folder_id && !link.drive_file_id) return;
  const oauth = createDriveOAuthClient();
  oauth.setCredentials({
    access_token: link.access_token,
    refresh_token: link.refresh_token,
    expiry_date: link.expiry_date ? Number(link.expiry_date) : undefined,
    scope: link.scope || undefined,
  });
  const drive = google.drive({ version: "v3", auth: oauth });
  if (link.drive_folder_id) {
    await drive.files.delete({ fileId: link.drive_folder_id });
    return;
  }
  await drive.files.delete({ fileId: link.drive_file_id });
}

function scheduleProjectDriveSync(projectId) {
  if (!isDriveConfigured()) return;
  const key = String(projectId);
  clearTimeout(driveSyncTimers[key]);
  driveSyncTimers[key] = setTimeout(async () => {
    if (driveSyncRunning[key]) return;
    driveSyncRunning[key] = true;
    try {
      const snapshot = await loadProjectSnapshot(projectId);
      if (!snapshot) return;
      const links = await getDriveLinksForProject(projectId);
      for (const link of links) {
        try {
          await ensureDriveMirrorForLink(link, snapshot);
          await persistDriveLinkStatus(link.id, { synced: true, error: null });
        } catch (err) {
          await persistDriveLinkStatus(link.id, { synced: false, error: err.message || "Drive sync failed" });
          console.error("Drive sync error:", err);
        }
      }
    } finally {
      driveSyncRunning[key] = false;
    }
  }, 1200);
}

async function flushFileSnapshot(fileId) {
  const shapes = Array.isArray(fileStates[fileId]) ? fileStates[fileId] : null;
  if (!shapes) return;
  clearTimeout(saveTimers[fileId]);
  delete saveTimers[fileId];
  try {
    console.log(`[db] flush file ${fileId}: shapesLen=${shapes.length}`);
    await sql`
      UPDATE project_files
      SET shapes = ${JSON.stringify(shapes)}::jsonb
      WHERE id = ${fileId}
    `;
    const projectId = await getProjectIdForFile(fileId);
    if (projectId) scheduleProjectDriveSync(projectId);
  } catch (err) {
    console.error("Snapshot flush error:", err);
  }
}

function scheduleSaveFileSnapshot({ fileId, shapes }) {
  fileStates[fileId] = shapes;
  clearTimeout(saveTimers[fileId]);
  saveTimers[fileId] = setTimeout(async () => {
    try {
      console.log(`[db] save file ${fileId}: shapesLen=${Array.isArray(shapes) ? shapes.length : "n/a"}`);
      await sql`
        UPDATE project_files
        SET shapes = ${JSON.stringify(shapes)}::jsonb
        WHERE id = ${fileId}
      `;
      const projectId = await getProjectIdForFile(fileId);
      if (projectId) scheduleProjectDriveSync(projectId);
    } catch (err) {
      console.error("Snapshot save error:", err);
    }
  }, 400);
}

// ── Auth middleware ──────────────────────────────────────────────────
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token || !tokens[token]) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  req.user = tokens[token];
  next();
}

// ── REST ─────────────────────────────────────────────────────────────────
// Auth routes
app.post("/auth/signup", async (req, res) => {
  const { email, displayName, password } = req.body;
  
  if (!email || !displayName || !password) {
    return res.status(400).json({ error: "Missing email, displayName, or password" });
  }

  try {
    const existing = await sql`SELECT id FROM users WHERE email = ${email}`;
    if (existing.length > 0) {
      return res.status(400).json({ error: "Email already registered" });
    }

    const passwordHash = hashPassword(password);
    const user = await sql`
      INSERT INTO users (email, display_name, password)
      VALUES (${email}, ${displayName}, ${passwordHash})
      RETURNING id, email, display_name
    `;

    const token = uuidv4();
    tokens[token] = { userId: idToString(user[0].id), email: user[0].email, displayName: user[0].display_name };

    res.json({ token, user: { userId: idToString(user[0].id), userName: user[0].display_name, email: user[0].email } });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Signup failed" });
  }
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Missing email or password" });
  }

  try {
    const users = await sql`SELECT id, email, display_name, password FROM users WHERE email = ${email}`;
    if (users.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const user = users[0];
    const passwordHash = hashPassword(password);
    if (user.password !== passwordHash) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = uuidv4();
    tokens[token] = { userId: idToString(user.id), email: user.email, displayName: user.display_name };

    res.json({ token, user: { userId: idToString(user.id), userName: user.display_name, email: user.email } });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

app.post("/auth/google", async (req, res) => {
  const { credential } = req.body || {};
  if (!credential) {
    return res.status(400).json({ error: "Missing Google credential" });
  }
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(500).json({ error: "Google Sign-in is not configured" });
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const email = payload?.email?.trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Google account email missing" });

    const fallbackName = (payload?.name || email.split("@")[0] || "Google User").trim();
    const displayName = fallbackName.slice(0, 80);

    let user = await sql`
      SELECT id, email, display_name
      FROM users
      WHERE email = ${email}
      LIMIT 1
    `;

    if (!user.length) {
      const generatedPasswordHash = hashPassword(uuidv4());
      user = await sql`
        INSERT INTO users (email, display_name, password)
        VALUES (${email}, ${displayName}, ${generatedPasswordHash})
        RETURNING id, email, display_name
      `;
    }

    const token = uuidv4();
    const authedUser = user[0];
    tokens[token] = {
      userId: idToString(authedUser.id),
      email: authedUser.email,
      displayName: authedUser.display_name,
      createdAt: Date.now(),
    };

    res.json({
      token,
      user: {
        userId: idToString(authedUser.id),
        userName: authedUser.display_name,
        email: authedUser.email,
      },
    });
  } catch (err) {
    console.error("Google auth error:", err);
    res.status(401).json({ error: "Google authentication failed" });
  }
});

// Verify token route
app.post("/auth/verify", verifyToken, (req, res) => {
  res.json({ user: { userId: idToString(req.user.userId), userName: req.user.displayName, email: req.user.email } });
});

app.get("/templates", verifyToken, async (_req, res) => {
  res.json(
    TEMPLATE_CATALOG.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      fileCount: t.files.length,
    }))
  );
});

app.get("/integrations/google-drive/status/:projectId", verifyToken, async (req, res) => {
  if (!isDriveConfigured()) {
    return res.json({ configured: false, linked: false });
  }
  const projectId = req.params.projectId;
  const userId = req.user.userId;
  try {
    const loaded = await loadProjectForUser({ projectId, userId });
    if (!loaded) return res.status(404).json({ error: "Project not found" });
    const rows = await sql`
      SELECT google_email, drive_folder_id, last_synced_at, last_error
      FROM drive_project_links
      WHERE project_id = ${projectId} AND user_id = ${userId}
      LIMIT 1
    `;
    if (!rows.length) {
      return res.json({ configured: true, linked: false });
    }
    return res.json({
      configured: true,
      linked: true,
      googleEmail: rows[0].google_email,
      hasDriveFolder: Boolean(rows[0].drive_folder_id),
      lastSyncedAt: rows[0].last_synced_at,
      lastError: rows[0].last_error,
    });
  } catch (err) {
    console.error("Drive status error:", err);
    res.status(500).json({ error: "Failed to load Drive status" });
  }
});

app.post("/integrations/google-drive/auth-url", verifyToken, async (req, res) => {
  if (!isDriveConfigured()) {
    return res.status(500).json({ error: "Google Drive integration is not configured" });
  }
  const projectId = String(req.body?.projectId || "").trim();
  const userId = req.user.userId;
  if (!projectId) return res.status(400).json({ error: "Missing projectId" });
  try {
    const loaded = await loadProjectForUser({ projectId, userId });
    if (!loaded) return res.status(404).json({ error: "Project not found" });
    const oauth = createDriveOAuthClient();
    const state = uuidv4();
    driveOauthStates[state] = {
      userId: String(userId),
      projectId: String(projectId),
      expiresAt: Date.now() + 10 * 60 * 1000,
    };
    const authUrl = oauth.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: DRIVE_SCOPES,
      state,
    });
    res.json({ authUrl });
  } catch (err) {
    console.error("Drive auth-url error:", err);
    res.status(500).json({ error: "Failed to start Google Drive auth" });
  }
});

app.get("/integrations/google-drive/callback", async (req, res) => {
  const state = String(req.query?.state || "");
  const code = String(req.query?.code || "");
  const error = String(req.query?.error || "");
  const stateEntry = driveOauthStates[state];

  function htmlResult(success, message) {
    const payload = JSON.stringify({ source: "collabra-drive-oauth", success, message });
    return `<!doctype html><html><body><script>
      (function() {
        const payload = ${payload};
        if (window.opener) window.opener.postMessage(payload, "*");
        window.close();
      })();
    </script><p>${message}</p></body></html>`;
  }

  if (!stateEntry || stateEntry.expiresAt < Date.now()) {
    delete driveOauthStates[state];
    return res.status(400).send(htmlResult(false, "Drive link request expired. Please try again."));
  }
  delete driveOauthStates[state];

  if (error) {
    return res.status(400).send(htmlResult(false, `Google denied access: ${error}`));
  }
  if (!code) {
    return res.status(400).send(htmlResult(false, "Missing authorization code from Google."));
  }

  try {
    const oauth = createDriveOAuthClient();
    const { tokens: driveTokens } = await oauth.getToken(code);
    oauth.setCredentials(driveTokens);
    const oauth2Api = google.oauth2({ version: "v2", auth: oauth });
    const profile = await oauth2Api.userinfo.get();
    const email = String(profile?.data?.email || "").toLowerCase();
    if (!email) throw new Error("Google account email unavailable");

    const existing = await sql`
      SELECT id
      FROM drive_project_links
      WHERE project_id = ${stateEntry.projectId} AND user_id = ${stateEntry.userId}
      LIMIT 1
    `;

    let linkId = null;
    if (existing.length) {
      linkId = existing[0].id;
      await sql`
        UPDATE drive_project_links
        SET
          google_email = ${email},
          access_token = ${driveTokens.access_token || null},
          refresh_token = COALESCE(${driveTokens.refresh_token || null}, refresh_token),
          scope = ${driveTokens.scope || null},
          expiry_date = ${driveTokens.expiry_date || null},
          updated_at = NOW(),
          last_error = NULL
        WHERE id = ${linkId}
      `;
    } else {
      const inserted = await sql`
        INSERT INTO drive_project_links (
          project_id, user_id, google_email, access_token, refresh_token, scope, expiry_date
        )
        VALUES (
          ${stateEntry.projectId},
          ${stateEntry.userId},
          ${email},
          ${driveTokens.access_token || null},
          ${driveTokens.refresh_token || null},
          ${driveTokens.scope || null},
          ${driveTokens.expiry_date || null}
        )
        RETURNING id
      `;
      linkId = inserted[0].id;
    }

    await persistDriveCredentials(linkId, oauth.credentials);
    scheduleProjectDriveSync(stateEntry.projectId);
    return res.send(htmlResult(true, "Google Drive connected. You can close this window."));
  } catch (err) {
    console.error("Drive callback error:", err);
    return res.status(500).send(htmlResult(false, "Failed to complete Google Drive connection."));
  }
});

app.post("/integrations/google-drive/sync/:projectId", verifyToken, async (req, res) => {
  if (!isDriveConfigured()) {
    return res.status(500).json({ error: "Google Drive integration is not configured" });
  }
  const projectId = req.params.projectId;
  const userId = req.user.userId;
  try {
    const loaded = await loadProjectForUser({ projectId, userId });
    if (!loaded) return res.status(404).json({ error: "Project not found" });
    const link = await sql`
      SELECT *
      FROM drive_project_links
      WHERE project_id = ${projectId} AND user_id = ${userId}
      LIMIT 1
    `;
    if (!link.length) return res.status(404).json({ error: "Google Drive is not connected for this project" });
    const snapshot = await loadProjectSnapshot(projectId);
    if (!snapshot) return res.status(404).json({ error: "Project not found" });
    await ensureDriveMirrorForLink(link[0], snapshot);
    await persistDriveLinkStatus(link[0].id, { synced: true, error: null });
    res.json({ ok: true });
  } catch (err) {
    console.error("Drive manual sync error:", err);
    res.status(500).json({ error: "Failed to sync to Google Drive" });
  }
});

app.delete("/integrations/google-drive/:projectId", verifyToken, async (req, res) => {
  const projectId = req.params.projectId;
  const userId = req.user.userId;
  try {
    const loaded = await loadProjectForUser({ projectId, userId });
    if (!loaded) return res.status(404).json({ error: "Project not found" });
    await sql`
      DELETE FROM drive_project_links
      WHERE project_id = ${projectId} AND user_id = ${userId}
    `;
    res.json({ ok: true });
  } catch (err) {
    console.error("Drive disconnect error:", err);
    res.status(500).json({ error: "Failed to disconnect Google Drive" });
  }
});

// Project endpoints
app.get("/projects", verifyToken, async (req, res) => {
  const userId = req.user.userId;
  try {
    const rows = await sql`
      SELECT
        p.id,
        p.name,
        p.owner_id,
        u.display_name AS owner_name,
        COALESCE(pm.role, 'viewer'::project_role) AS my_role,
        (SELECT COUNT(*)::int FROM project_files f WHERE f.project_id = p.id) AS file_count
      FROM projects p
      JOIN users u ON u.id = p.owner_id
      LEFT JOIN project_members pm
        ON pm.project_id = p.id AND pm.user_id = ${userId}
      WHERE p.owner_id = ${userId} OR pm.user_id IS NOT NULL
      ORDER BY p.created_at DESC
    `;
    res.json(rows.map(r => ({
      id: r.id,
      name: r.name,
      ownerId: idToString(r.owner_id),
      isOwner: String(r.owner_id) === String(userId),
      ownerName: r.owner_name,
      fileCount: r.file_count,
      myRole: r.my_role,
    })));
  } catch (err) {
    console.error("List projects error:", err);
    res.status(500).json({ error: "Failed to list projects" });
  }
});

app.post("/projects", verifyToken, async (req, res) => {
  const { name, templateId } = req.body;
  const ownerId = req.user.userId;
  if (!name || !String(name).trim()) return res.status(400).json({ error: "Missing name" });

  try {
    const project = await sql`
      INSERT INTO projects (name, owner_id)
      VALUES (${String(name).trim()}, ${ownerId})
      RETURNING id, name, owner_id
    `;
    await sql`
      INSERT INTO project_members (project_id, user_id, role)
      VALUES (${project[0].id}, ${ownerId}, 'editor')
      ON CONFLICT (project_id, user_id) DO NOTHING
    `;
    const template = getTemplateById(String(templateId || "blank"));
    const insertedFiles = [];
    for (const fileDef of template.files) {
      const file = await sql`
        INSERT INTO project_files (project_id, name, shapes)
        VALUES (
          ${project[0].id},
          ${String(fileDef.name || "Page").trim()},
          ${JSON.stringify(Array.isArray(fileDef.shapes) ? fileDef.shapes : [])}::jsonb
        )
        RETURNING id, name, shapes
      `;
      insertedFiles.push(file[0]);
    }
    const owner = await sql`SELECT display_name FROM users WHERE id = ${ownerId} LIMIT 1`;
    const files = {};
    for (const f of insertedFiles) {
      fileProjectMap[f.id] = project[0].id;
      files[f.id] = {
        id: f.id,
        name: f.name,
        shapes: Array.isArray(f.shapes) ? f.shapes : [],
      };
    }
    res.json({
      id: project[0].id,
      name: project[0].name,
      ownerId: idToString(project[0].owner_id),
      isOwner: true,
      ownerName: owner[0]?.display_name ?? req.user.displayName,
      files,
      myRole: "editor",
    });
  } catch (err) {
    console.error("Create project error:", err);
    res.status(500).json({ error: "Failed to create project" });
  }
});

app.get("/projects/:projectId", verifyToken, async (req, res) => {
  const projectId = req.params.projectId;
  const userId = req.user.userId;
  try {
    const loaded = await loadProjectForUser({ projectId, userId });
    if (!loaded) return res.status(404).json({ error: "Project not found" });
    res.json({ ...loaded.project, myRole: loaded.role });
  } catch (err) {
    console.error("Get project error:", err);
    res.status(500).json({ error: "Failed to load project" });
  }
});

app.patch("/projects/:projectId", verifyToken, async (req, res) => {
  const projectId = req.params.projectId;
  const userId = req.user.userId;
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Missing name" });

  try {
    const p = await sql`SELECT owner_id FROM projects WHERE id = ${projectId} LIMIT 1`;
    if (!p.length) return res.status(404).json({ error: "Project not found" });
    if (String(p[0].owner_id) !== String(userId)) return res.status(403).json({ error: "Owner only" });

    const updated = await sql`
      UPDATE projects
      SET name = ${name}
      WHERE id = ${projectId}
      RETURNING id, name
    `;
    scheduleProjectDriveSync(projectId);
    res.json({ id: updated[0].id, name: updated[0].name });
  } catch (err) {
    console.error("Rename project error:", err);
    res.status(500).json({ error: "Failed to rename project" });
  }
});

// Members: list members (owner + collaborators)
app.get("/projects/:projectId/members", verifyToken, async (req, res) => {
  const projectId = req.params.projectId;
  const userId = req.user.userId;
  try {
    // Ensure caller has access to the project.
    const loaded = await loadProjectForUser({ projectId, userId });
    if (!loaded) return res.status(404).json({ error: "Project not found" });

    const rows = await sql`
      SELECT
        u.id as user_id,
        u.display_name,
        u.email,
        COALESCE(pm.role, 'viewer'::project_role) as role,
        (p.owner_id = u.id) as is_owner
      FROM projects p
      JOIN users u
        ON (u.id = p.owner_id)
        OR EXISTS (
          SELECT 1 FROM project_members pm2
          WHERE pm2.project_id = p.id AND pm2.user_id = u.id
        )
      LEFT JOIN project_members pm
        ON pm.project_id = p.id AND pm.user_id = u.id
      WHERE p.id = ${projectId}
      ORDER BY (p.owner_id = u.id) DESC, u.display_name ASC
    `;

    res.json(rows.map(r => ({
      userId: idToString(r.user_id),
      userName: r.display_name,
      email: r.email,
      role: r.is_owner ? "owner" : r.role,
      isOwner: !!r.is_owner,
    })));
  } catch (err) {
    console.error("List members error:", err);
    res.status(500).json({ error: "Failed to list members" });
  }
});

// Owner: invite existing user by email (no invite links)
app.post("/projects/:projectId/members", verifyToken, async (req, res) => {
  const projectId = req.params.projectId;
  const ownerId = req.user.userId;
  const { email, role } = req.body;
  const safeRole = role === "viewer" ? "viewer" : "editor";
  if (!email) return res.status(400).json({ error: "Missing email" });

  try {
    const p = await sql`SELECT owner_id FROM projects WHERE id = ${projectId} LIMIT 1`;
    if (!p.length) return res.status(404).json({ error: "Project not found" });
    if (String(p[0].owner_id) !== String(ownerId)) return res.status(403).json({ error: "Owner only" });

    const u = await sql`SELECT id, display_name, email FROM users WHERE email = ${email} LIMIT 1`;
    if (!u.length) return res.status(404).json({ error: "User not found" });
    if (String(u[0].id) === String(ownerId)) return res.status(400).json({ error: "Owner is already a member" });

    await sql`
      INSERT INTO project_members (project_id, user_id, role)
      VALUES (${projectId}, ${u[0].id}, ${safeRole}::project_role)
      ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role
    `;
    io.to(String(projectId)).emit("members_updated", { projectId: String(projectId) });
    io.to(`user:${idToString(u[0].id)}`).emit("members_updated", { projectId: String(projectId) });
    res.json({ ok: true, userId: u[0].id, userName: u[0].display_name, email: u[0].email, role: safeRole });
  } catch (err) {
    console.error("Invite member error:", err);
    res.status(500).json({ error: "Failed to add member" });
  }
});

app.patch("/projects/:projectId/members/:userId", verifyToken, async (req, res) => {
  const projectId = req.params.projectId;
  const ownerId = req.user.userId;
  const targetUserId = req.params.userId;
  const { role } = req.body;
  const safeRole = role === "viewer" ? "viewer" : "editor";

  try {
    const p = await sql`SELECT owner_id FROM projects WHERE id = ${projectId} LIMIT 1`;
    if (!p.length) return res.status(404).json({ error: "Project not found" });
    if (String(p[0].owner_id) !== String(ownerId)) return res.status(403).json({ error: "Owner only" });
    if (String(targetUserId) === String(ownerId)) return res.status(400).json({ error: "Cannot change owner role" });

    const updated = await sql`
      UPDATE project_members
      SET role = ${safeRole}::project_role
      WHERE project_id = ${projectId} AND user_id = ${targetUserId}
      RETURNING user_id, role
    `;
    if (!updated.length) return res.status(404).json({ error: "Member not found" });
    io.to(String(projectId)).emit("members_updated", { projectId: String(projectId) });
    io.to(`user:${String(targetUserId)}`).emit("members_updated", { projectId: String(projectId) });
    res.json({ ok: true, userId: updated[0].user_id, role: updated[0].role });
  } catch (err) {
    console.error("Update member role error:", err);
    res.status(500).json({ error: "Failed to update role" });
  }
});

app.delete("/projects/:projectId/members/:userId", verifyToken, async (req, res) => {
  const projectId = req.params.projectId;
  const ownerId = req.user.userId;
  const targetUserId = req.params.userId;

  try {
    const p = await sql`SELECT owner_id FROM projects WHERE id = ${projectId} LIMIT 1`;
    if (!p.length) return res.status(404).json({ error: "Project not found" });
    if (String(p[0].owner_id) !== String(ownerId)) return res.status(403).json({ error: "Owner only" });
    if (String(targetUserId) === String(ownerId)) return res.status(400).json({ error: "Cannot remove owner" });

    await sql`
      DELETE FROM project_members
      WHERE project_id = ${projectId} AND user_id = ${targetUserId}
    `;
    io.to(String(projectId)).emit("members_updated", { projectId: String(projectId) });
    io.to(`user:${String(targetUserId)}`).emit("members_updated", { projectId: String(projectId) });
    res.json({ ok: true });
  } catch (err) {
    console.error("Kick member error:", err);
    res.status(500).json({ error: "Failed to remove member" });
  }
});

app.delete("/projects/:projectId", verifyToken, async (req, res) => {
  const projectId = req.params.projectId;
  const ownerId = req.user.userId;
  try {
    const p = await sql`SELECT owner_id FROM projects WHERE id = ${projectId} LIMIT 1`;
    if (!p.length) return res.status(404).json({ error: "Project not found" });
    if (String(p[0].owner_id) !== String(ownerId)) return res.status(403).json({ error: "Owner only" });

    if (isDriveConfigured()) {
      const links = await getDriveLinksForProject(projectId);
      for (const link of links) {
        try {
          await deleteDriveMirrorForLink(link);
        } catch (err) {
          console.error("Drive delete mirror error:", err);
        }
      }
    }

    const fileRows = await sql`SELECT id FROM project_files WHERE project_id = ${projectId}`;
    for (const f of fileRows) delete fileProjectMap[f.id];
    await sql`DELETE FROM projects WHERE id = ${projectId}`;
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete project error:", err);
    res.status(500).json({ error: "Failed to delete project" });
  }
});

// ── Socket.io ────────────────────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token || !tokens[token]) return next(new Error("Unauthorized"));
  socket.user = tokens[token];
  next();
});

io.on("connection", (socket) => {
  console.log("+ connected:", socket.id);
  socket.join(`user:${socket.user.userId}`);

  socket.on("join_project", async ({ projectId }) => {
    const userId = socket.user.userId;
    const userName = socket.user.displayName;
    const loaded = await loadProjectForUser({ projectId, userId });
    if (!loaded) { socket.emit("error_msg", "Project not found"); return; }

    const color = colorFor(userId);
    sessions[socket.id] = { userId, userName, color, projectId, role: loaded.role };
    socket.join(projectId);

    const projectLocks = {};
    for (const [fid, lock] of Object.entries(locks)) {
      if (loaded.project.files[fid]) projectLocks[fid] = lock;
    }
    // Seed in-memory file state for debounced saves.
    for (const f of Object.values(loaded.project.files)) {
      fileStates[f.id] = f.shapes ?? [];
    }
    socket.emit("init_state", { project: loaded.project, locks: projectLocks, color, myRole: loaded.role });
    socket.to(projectId).emit("user_joined", { userId, userName, color });
    io.to(projectId).emit("users_update", usersInProject(projectId));
    console.log(`  ${userName} joined ${projectId} (${loaded.role})`);
  });

  // Join a specific file/page room for presence updates.
  socket.on("join_file", ({ fileId }) => {
    const session = sessions[socket.id];
    const fid = String(fileId || "").trim();
    if (!session || !fid) return;

    socket.join(fid);
    ensureFilePresence(fid);

    if (!userSocketsByFile[fid][session.userId]) userSocketsByFile[fid][session.userId] = new Set();
    userSocketsByFile[fid][session.userId].add(socket.id);

    const existingIdx = activeUsersByFile[fid].findIndex(u => String(u.userId) === String(session.userId));
    const entry = { userId: session.userId, userName: session.userName, color: session.color };
    if (existingIdx === -1) activeUsersByFile[fid].push(entry);
    else activeUsersByFile[fid][existingIdx] = entry;

    emitActiveUsersForFile(io, fid);

    const lock = locks[fid];
    io.to(fid).emit("editing-user", lock ? lock.userId : null);
  });

  socket.on("leave_file", ({ fileId }) => {
    const session = sessions[socket.id];
    const fid = String(fileId || "").trim();
    if (!session || !fid) return;

    socket.leave(fid);
    const usersForFile = userSocketsByFile[fid];
    if (!usersForFile?.[session.userId]) return;

    usersForFile[session.userId].delete(socket.id);
    if (usersForFile[session.userId].size === 0) {
      delete usersForFile[session.userId];
      activeUsersByFile[fid] = (activeUsersByFile[fid] || []).filter(u => String(u.userId) !== String(session.userId));
    }

    emitActiveUsersForFile(io, fid);

    if (usersForFile && Object.keys(usersForFile).length === 0) {
      delete userSocketsByFile[fid];
      if ((activeUsersByFile[fid] || []).length === 0) delete activeUsersByFile[fid];
    }
  });

  socket.on("acquire_lock", ({ fileId }) => {
    const session = sessions[socket.id];
    if (!session) return;
    if (session.role !== "editor") return;
    const existing = locks[fileId];
    if (existing && existing.socketId !== socket.id) {
      socket.emit("lock_denied", { fileId, lockedBy: existing.userName });
      return;
    }
    locks[fileId] = { userId: session.userId, userName: session.userName, color: session.color, socketId: socket.id };
    io.to(session.projectId).emit("lock_acquired", { fileId, userId: session.userId, userName: session.userName, color: session.color });
    io.to(String(fileId)).emit("editing-user", session.userId);
  });

  socket.on("release_lock", ({ fileId }) => {
    const session = sessions[socket.id];
    if (!session || locks[fileId]?.socketId !== socket.id) return;
    flushFileSnapshot(fileId);
    delete locks[fileId];
    io.to(session.projectId).emit("lock_released", { fileId });
    io.to(String(fileId)).emit("editing-user", null);
  });

  socket.on("shape_add", ({ fileId, shape }) => {
    const session = sessions[socket.id];
    if (!session || locks[fileId]?.socketId !== socket.id) return;
    if (session.role !== "editor") return;
    const current = Array.isArray(fileStates[fileId]) ? fileStates[fileId] : [];
    const next = [...current, shape];
    scheduleSaveFileSnapshot({ fileId, shapes: next });
    socket.to(session.projectId).emit("shape_added", { fileId, shape });
  });

  socket.on("shape_update", ({ fileId, shapeId, changes }) => {
    const session = sessions[socket.id];
    if (!session || locks[fileId]?.socketId !== socket.id) return;
    if (session.role !== "editor") return;
    const current = Array.isArray(fileStates[fileId]) ? fileStates[fileId] : [];
    const next = current.map(s => (s?.id === shapeId ? { ...s, ...changes } : s));
    scheduleSaveFileSnapshot({ fileId, shapes: next });
    socket.to(session.projectId).emit("shape_updated", { fileId, shapeId, changes });
  });

  socket.on("shape_delete", ({ fileId, shapeId }) => {
    const session = sessions[socket.id];
    if (!session || locks[fileId]?.socketId !== socket.id) return;
    if (session.role !== "editor") return;
    const current = Array.isArray(fileStates[fileId]) ? fileStates[fileId] : [];
    const next = current.filter(s => s?.id !== shapeId);
    scheduleSaveFileSnapshot({ fileId, shapes: next });
    socket.to(session.projectId).emit("shape_deleted", { fileId, shapeId });
  });

  socket.on("snapshot", ({ fileId, shapes }) => {
    const session = sessions[socket.id];
    if (!session || locks[fileId]?.socketId !== socket.id) return;
    if (session.role !== "editor") return;
    scheduleSaveFileSnapshot({ fileId, shapes });
    socket.to(session.projectId).emit("snapshot", { fileId, shapes });
  });

  socket.on("add_file", ({ projectId, fileName }) => {
    // Deprecated: use add_file_v2 (no in-memory projects anymore).
  });

  socket.on("add_file_v2", async ({ fileName }) => {
    const session = sessions[socket.id];
    if (!session) return;
    if (session.role !== "editor") return;
    const name = String(fileName || "").trim();
    if (!name) return;
    try {
      const file = await sql`
        INSERT INTO project_files (project_id, name, shapes)
        VALUES (${session.projectId}, ${name}, '[]'::jsonb)
        RETURNING id, name
      `;
      fileProjectMap[file[0].id] = session.projectId;
      fileStates[file[0].id] = [];
      scheduleProjectDriveSync(session.projectId);
      io.to(session.projectId).emit("file_added", { file: { id: file[0].id, name: file[0].name, shapes: [] } });
    } catch (err) {
      console.error("Add file error:", err);
    }
  });

  socket.on("disconnect", () => {
    const session = sessions[socket.id];
    // Presence cleanup even if they never joined a project.
    removeSocketFromAllFiles(io, socket.id);
    if (!session) return;
    for (const [fid, lock] of Object.entries(locks)) {
      if (lock.socketId === socket.id) {
        flushFileSnapshot(fid);
        delete locks[fid];
        io.to(session.projectId).emit("lock_released", { fileId: fid });
        io.to(String(fid)).emit("editing-user", null);
      }
    }
    socket.to(session.projectId).emit("user_left", { userId: session.userId });
    delete sessions[socket.id];
    io.to(session.projectId).emit("users_update", usersInProject(session.projectId));
    console.log(`- disconnected: ${session.userName}`);
  });
});

// Listen on all interfaces so other devices on LAN can connect.
ensureDriveIntegrationSchema()
  .then(() => {
    console.log("[drive] integration schema ready");
  })
  .catch((err) => {
    console.error("[drive] schema init failed:", err);
  });

server.listen(3001, "0.0.0.0", () => console.log("Server on http://localhost:3001"));