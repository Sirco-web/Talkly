// server.js - Talky with GitHub-backed JSON storage
// Node.js + Express + sessions + GitHub Contents API for persistence.

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const session = require("express-session");

const app = express();

// ---- Env vars ----
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const DATA_PATH = process.env.DATA_PATH || "talky/data.json";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me-admin-pass";

if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
  console.error("Missing GitHub env vars. Set GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO.");
}

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "talky-session-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false, // set to true behind HTTPS proxy
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  })
);

app.use(express.static(path.join(__dirname, "public")));

// -------- Small helpers --------

function generateId(prefix) {
  const rnd = crypto.randomBytes(4).toString("hex");
  return `${prefix}_${rnd}`;
}

function hashPassword(password, salt) {
  return crypto.createHmac("sha256", salt).update(password).digest("hex");
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);
  return `${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split("$");
  const computed = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(computed));
}

// -------- GitHub JSON "DB" helpers --------

async function githubRequest(path, options = {}) {
  const url = `https://api.github.com${path}`;
  const res = await fetch(url, {
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28"
    },
    ...options
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

// Load data.json from GitHub (or initialize if missing)
async function loadDB() {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    // fallback in case env not set, but avoid crashing
    return { users: [], chats: [], messages: [] };
  }

  try {
    const file = await githubRequest(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(
        DATA_PATH
      )}?ref=${encodeURIComponent(GITHUB_BRANCH)}`
    );
    const content = Buffer.from(file.content, "base64").toString("utf8");
    const json = JSON.parse(content);
    // attach sha so we can update
    json._sha = file.sha;
    return json;
  } catch (err) {
    // If 404, create a new one
    if (String(err.message).includes("404")) {
      return { users: [], chats: [], messages: [] };
    }
    console.error("Failed to load DB from GitHub:", err);
    return { users: [], chats: [], messages: [] };
  }
}

// Save DB back to GitHub
async function saveDB(db) {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) return;
  const sha = db._sha;
  const payload = { ...db };
  delete payload._sha;

  const content = Buffer.from(JSON.stringify(payload, null, 2), "utf8").toString(
    "base64"
  );

  const body = {
    message: "Update Talky data.json",
    content,
    branch: GITHUB_BRANCH
  };
  if (sha) body.sha = sha;

  const res = await githubRequest(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(
      DATA_PATH
    )}`,
    {
      method: "PUT",
      body: JSON.stringify(body)
    }
  );

  // store new sha
  if (res && res.content && res.content.sha) {
    db._sha = res.content.sha;
  }
}

// -------- Middleware: auth / admin --------

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.isAdmin) {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
}

// -------- Routes: me / auth --------

app.get("/api/me", async (req, res) => {
  const db = await loadDB();
  const userId = req.session.userId;
  if (!userId) return res.json({ user: null });
  const user = db.users.find((u) => u.id === userId);
  if (!user) return res.json({ user: null });
  res.json({
    user: {
      id: user.id,
      username: user.username,
      isAdmin: !!user.isAdmin
    }
  });
});

app.post("/api/auth/signup", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required." });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }

  const db = await loadDB();
  const existing = db.users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase()
  );
  if (existing) {
    return res.status(409).json({ error: "Username already taken." });
  }

  const id = generateId("u");
  const passwordHash = createPasswordHash(password);
  const isAdmin = db.users.length === 0; // first user = admin

  const user = {
    id,
    username,
    passwordHash,
    isAdmin,
    createdAt: new Date().toISOString()
  };
  db.users.push(user);

  // Seed default chats for first user only (demo)
  if (db.chats.length === 0) {
    const c1 = { id: generateId("c"), name: "Alex Johnson", ownerId: id };
    const c2 = { id: generateId("c"), name: "Family Group", ownerId: id };
    db.chats.push(c1, c2);
    db.messages.push(
      {
        id: generateId("m"),
        chatId: c1.id,
        fromUserId: "contact_alex",
        text: "Hey! Just checking if you’re free later tonight?",
        ts: Date.now() - 600000
      },
      {
        id: generateId("m"),
        chatId: c1.id,
        fromUserId: "contact_alex",
        text: "I want to show you something cool on video.",
        ts: Date.now() - 590000
      },
      {
        id: generateId("m"),
        chatId: c1.id,
        fromUserId: id,
        text: "Yeah, I’m free after 7.",
        ts: Date.now() - 580000
      },
      {
        id: generateId("m"),
        chatId: c1.id,
        fromUserId: "contact_alex",
        text: "Perfect, I’ll call you here!",
        ts: Date.now() - 570000
      },
      {
        id: generateId("m"),
        chatId: c2.id,
        fromUserId: "contact_family",
        text: "Don’t forget Sunday dinner at 6pm.",
        ts: Date.now() - 3600000
      },
      {
        id: generateId("m"),
        chatId: c2.id,
        fromUserId: "contact_family",
        text: "Let’s try using Talky this time 👍",
        ts: Date.now() - 3500000
      },
      {
        id: generateId("m"),
        chatId: c2.id,
        fromUserId: id,
        text: "I’ll help Grandma join.",
        ts: Date.now() - 3400000
      }
    );
  }

  await saveDB(db);

  req.session.userId = user.id;
  req.session.isAdmin = user.isAdmin;

  res.status(201).json({
    user: {
      id: user.id,
      username: user.username,
      isAdmin: user.isAdmin
    }
  });
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required." });
  }

  const db = await loadDB();
  const user = db.users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase()
  );
  if (!user) {
    return res.status(401).json({ error: "Invalid username or password." });
  }

  if (!verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: "Invalid username or password." });
  }

  req.session.userId = user.id;
  req.session.isAdmin = !!user.isAdmin;

  res.json({
    user: {
      id: user.id,
      username: user.username,
      isAdmin: user.isAdmin
    }
  });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// -------- Chats & messages --------

app.get("/api/chats", requireAuth, async (req, res) => {
  const db = await loadDB();
  const userId = req.session.userId;
  const chats = db.chats.filter((c) => c.ownerId === userId);
  const messagesByChat = {};
  for (const chat of chats) {
    messagesByChat[chat.id] = db.messages
      .filter((m) => m.chatId === chat.id)
      .sort((a, b) => a.ts - b.ts);
  }
  res.json({ chats, messagesByChat });
});

app.post("/api/messages", requireAuth, async (req, res) => {
  const { chatId, text } = req.body || {};
  if (!chatId || !text) {
    return res.status(400).json({ error: "chatId and text are required." });
  }

  const db = await loadDB();
  const chat = db.chats.find((c) => c.id === chatId);
  if (!chat || chat.ownerId !== req.session.userId) {
    return res.status(404).json({ error: "Chat not found." });
  }

  const msg = {
    id: generateId("m"),
    chatId,
    fromUserId: req.session.userId,
    text,
    ts: Date.now()
  };
  db.messages.push(msg);
  await saveDB(db);

  res.status(201).json({ message: msg });
});

app.post("/api/chats", requireAuth, async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "Chat name required." });

  const db = await loadDB();
  const chat = {
    id: generateId("c"),
    name,
    ownerId: req.session.userId
  };
  db.chats.push(chat);
  await saveDB(db);
  res.status(201).json({ chat });
});

// -------- Admin endpoints --------

app.post("/api/admin/login", async (req, res) => {
  const { password } = req.body || {};
  if (!password) {
    return res.status(400).json({ error: "Password required." });
  }
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid admin password." });
  }
  req.session.isAdmin = true;
  res.json({ ok: true });
});

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  const db = await loadDB();
  res.json({
    users: db.users.map((u) => ({
      id: u.id,
      username: u.username,
      isAdmin: !!u.isAdmin,
      createdAt: u.createdAt
    }))
  });
});

app.delete("/api/admin/users/:id", requireAdmin, async (req, res) => {
  const userId = req.params.id;
  const db = await loadDB();

  const userIndex = db.users.findIndex((u) => u.id === userId);
  if (userIndex === -1) {
    return res.status(404).json({ error: "User not found." });
  }

  const chatsToDelete = db.chats.filter((c) => c.ownerId === userId).map((c) => c.id);
  db.users.splice(userIndex, 1);
  db.chats = db.chats.filter((c) => c.ownerId !== userId);
  db.messages = db.messages.filter((m) => !chatsToDelete.includes(m.chatId));

  await saveDB(db);
  res.json({ ok: true });
});

// -------- SPA fallback --------

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Talky (GitHub-backed) running on http://localhost:${PORT}`);
});
