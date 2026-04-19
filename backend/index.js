require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const crypto = require("crypto");
const sql = require("./db.js");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "http://localhost:5173", methods: ["GET", "POST"] },
});

// ── Hash password utilities ────────────────────────────────────────────
function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

// ── Initialize database ────────────────────────────────────────────────
async function initDb() {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email varchar(255) UNIQUE NOT NULL,
        display_name varchar(255) NOT NULL,
        password varchar(255) NOT NULL,
        created_at timestamp DEFAULT CURRENT_TIMESTAMP
      )
    `;
    console.log("✓ Database initialized");
  } catch (err) {
    console.error("✗ Database init error:", err);
  }
}

initDb();

// ── In-memory state ──────────────────────────────────────────────────────
const projects = {};
const sessions = {};  // socketId -> { userId, userName, color, projectId }
const locks = {};     // fileId  -> { userId, userName, color, socketId }
const tokens = {};    // token -> { userId, email, displayName, createdAt }

const COLORS = ["#6366f1","#f59e0b","#10b981","#ef4444","#3b82f6","#ec4899","#14b8a6","#f97316"];
const assignedColors = {};
let colorIdx = 0;
function colorFor(userId) {
  if (!assignedColors[userId]) assignedColors[userId] = COLORS[colorIdx++ % COLORS.length];
  return assignedColors[userId];
}

// Seed a demo project
const DEMO_ID = "demo";
projects[DEMO_ID] = {
  id: DEMO_ID,
  name: "Demo Project",
  ownerId: "system",
  ownerName: "System",
  files: {
    "f1": { id: "f1", name: "Page 1", shapes: [] },
    "f2": { id: "f2", name: "Page 2", shapes: [] },
  },
};

function usersInProject(projectId) {
  return Object.values(sessions)
      .filter(s => s.projectId === projectId)
      .map(s => ({ userId: s.userId, userName: s.userName, color: s.color }));
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
    tokens[token] = { userId: user[0].id, email: user[0].email, displayName: user[0].display_name };

    res.json({ token, user: { userId: user[0].id, userName: user[0].display_name, email: user[0].email } });
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
    tokens[token] = { userId: user.id, email: user.email, displayName: user.display_name };

    res.json({ token, user: { userId: user.id, userName: user.display_name, email: user.email } });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// Verify token route
app.post("/auth/verify", verifyToken, (req, res) => {
  res.json({ user: { userId: req.user.userId, userName: req.user.displayName, email: req.user.email } });
});

// Project endpoints
app.get("/projects", (_req, res) => {
  res.json(Object.values(projects).map(p => ({
    id: p.id,
    name: p.name,
    ownerName: p.ownerName,
    fileCount: Object.keys(p.files).length,
  })));
});

app.post("/projects", (req, res) => {
  const { name, userId, userName } = req.body;
  const id = uuidv4();
  const fileId = uuidv4();
  projects[id] = {
    id, name,
    ownerId: userId,
    ownerName: userName,
    files: { [fileId]: { id: fileId, name: "Page 1", shapes: [] } },
  };
  res.json(projects[id]);
});

// ── Socket.io ────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("+ connected:", socket.id);

  socket.on("join_project", ({ userId, userName, projectId }) => {
    const color = colorFor(userId);
    sessions[socket.id] = { userId, userName, color, projectId };
    socket.join(projectId);

    const project = projects[projectId];
    if (!project) { socket.emit("error_msg", "Project not found"); return; }

    const projectLocks = {};
    for (const [fid, lock] of Object.entries(locks)) {
      if (project.files[fid]) projectLocks[fid] = lock;
    }
    socket.emit("init_state", { project, locks: projectLocks, color });
    socket.to(projectId).emit("user_joined", { userId, userName, color });
    io.to(projectId).emit("users_update", usersInProject(projectId));
    console.log(`  ${userName} joined ${projectId}`);
  });

  socket.on("acquire_lock", ({ fileId }) => {
    const session = sessions[socket.id];
    if (!session) return;
    const existing = locks[fileId];
    if (existing && existing.socketId !== socket.id) {
      socket.emit("lock_denied", { fileId, lockedBy: existing.userName });
      return;
    }
    locks[fileId] = { userId: session.userId, userName: session.userName, color: session.color, socketId: socket.id };
    io.to(session.projectId).emit("lock_acquired", { fileId, userId: session.userId, userName: session.userName, color: session.color });
  });

  socket.on("release_lock", ({ fileId }) => {
    const session = sessions[socket.id];
    if (!session || locks[fileId]?.socketId !== socket.id) return;
    delete locks[fileId];
    io.to(session.projectId).emit("lock_released", { fileId });
  });

  socket.on("shape_add", ({ fileId, shape }) => {
    const session = sessions[socket.id];
    if (!session || locks[fileId]?.socketId !== socket.id) return;
    const file = projects[session.projectId]?.files[fileId];
    if (!file) return;
    file.shapes.push(shape);
    socket.to(session.projectId).emit("shape_added", { fileId, shape });
  });

  socket.on("shape_update", ({ fileId, shapeId, changes }) => {
    const session = sessions[socket.id];
    if (!session || locks[fileId]?.socketId !== socket.id) return;
    const file = projects[session.projectId]?.files[fileId];
    if (!file) return;
    const idx = file.shapes.findIndex(s => s.id === shapeId);
    if (idx !== -1) file.shapes[idx] = { ...file.shapes[idx], ...changes };
    socket.to(session.projectId).emit("shape_updated", { fileId, shapeId, changes });
  });

  socket.on("shape_delete", ({ fileId, shapeId }) => {
    const session = sessions[socket.id];
    if (!session || locks[fileId]?.socketId !== socket.id) return;
    const file = projects[session.projectId]?.files[fileId];
    if (!file) return;
    file.shapes = file.shapes.filter(s => s.id !== shapeId);
    socket.to(session.projectId).emit("shape_deleted", { fileId, shapeId });
  });

  socket.on("snapshot", ({ fileId, shapes }) => {
    const session = sessions[socket.id];
    if (!session || locks[fileId]?.socketId !== socket.id) return;
    const file = projects[session.projectId]?.files[fileId];
    if (!file) return;
    file.shapes = shapes;
    socket.to(session.projectId).emit("snapshot", { fileId, shapes });
  });

  socket.on("add_file", ({ projectId, fileName }) => {
    const project = projects[projectId];
    if (!project) return;
    const fileId = uuidv4();
    const file = { id: fileId, name: fileName, shapes: [] };
    project.files[fileId] = file;
    io.to(projectId).emit("file_added", { file });
  });

  socket.on("disconnect", () => {
    const session = sessions[socket.id];
    if (!session) return;
    for (const [fid, lock] of Object.entries(locks)) {
      if (lock.socketId === socket.id) {
        delete locks[fid];
        io.to(session.projectId).emit("lock_released", { fileId: fid });
      }
    }
    socket.to(session.projectId).emit("user_left", { userId: session.userId });
    delete sessions[socket.id];
    io.to(session.projectId).emit("users_update", usersInProject(session.projectId));
    console.log(`- disconnected: ${session.userName}`);
  });
});

server.listen(3001, () => console.log("Server on http://localhost:3001"));