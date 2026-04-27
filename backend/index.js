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

const COLORS = ["#6366f1","#f59e0b","#10b981","#ef4444","#3b82f6","#ec4899","#14b8a6","#f97316"];
const assignedColors = {};
let colorIdx = 0;
function colorFor(userId) {
  if (!assignedColors[userId]) assignedColors[userId] = COLORS[colorIdx++ % COLORS.length];
  return assignedColors[userId];
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
      fileStates[file[0].id] = [];
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
server.listen(3001, "0.0.0.0", () => console.log("Server on http://localhost:3001"));