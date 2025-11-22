// server.js - Talky with GitHub-backed storage + encrypted chats + basic calls
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const session = require("express-session");

// Add a portable fetch reference (Node >=18 has global fetch; fallback to undici)
let fetch = globalThis.fetch;
if (!fetch) {
  try {
    fetch = require("undici").fetch;
  } catch (e) {
    console.error(
      "Fetch API not available. Install 'undici' (npm install undici) or run Node >=18."
    );
    throw e;
  }
}

const app = express();

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
      secure: false,
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  })
);

app.use(express.static(path.join(__dirname, "public")));

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

async function githubRequest(path, options = {}) {
  const url = `https://api.github.com${path}`;

  // Merge default headers with any provided in options
  const defaultHeaders = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const providedHeaders = options.headers || {};
  const headers = { ...defaultHeaders, ...providedHeaders };

  // If a body is present and Content-Type wasn't explicitly provided, assume JSON
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, {
    ...options,
    headers
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

async function loadDB() {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    return { users: [], chats: [], messages: [], calls: [], globalPaused: { messages: false, calls: false } };
  }

  try {
    const file = await githubRequest(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(
        DATA_PATH
      )}?ref=${encodeURIComponent(GITHUB_BRANCH)}`
    );
    const content = Buffer.from(file.content, "base64").toString("utf8");
    const json = JSON.parse(content);

    json._sha = file.sha;
    if (!Array.isArray(json.users)) json.users = [];
    if (!Array.isArray(json.chats)) json.chats = [];
    if (!Array.isArray(json.messages)) json.messages = [];
    if (!Array.isArray(json.calls)) json.calls = [];
    if (!json.globalPaused || typeof json.globalPaused !== "object")
      json.globalPaused = { messages: false, calls: false };

    return json;
  } catch (err) {
    if (String(err.message).includes("404")) {
      return { users: [], chats: [], messages: [], calls: [], globalPaused: { messages: false, calls: false } };
    }
    console.error("Failed to load DB from GitHub:", err);
    return { users: [], chats: [], messages: [], calls: [], globalPaused: { messages: false, calls: false } };
  }
}

async function saveDB(db) {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) return false;
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

  try {
    const res = await githubRequest(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(
        DATA_PATH
      )}`,
      {
        method: "PUT",
        body: JSON.stringify(body)
      }
    );

    if (res && res.content && res.content.sha) {
      db._sha = res.content.sha;
    }
    return true;
  } catch (err) {
    console.error("Failed to save DB to GitHub:", err);
    // Don't throw to avoid turning API calls into 5xx when GitHub is unavailable.
    return false;
  }
}

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
  const isAdmin = db.users.length === 0;

  const user = {
    id,
    username,
    passwordHash,
    isAdmin,
    createdAt: new Date().toISOString()
  };
  db.users.push(user);

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

app.get("/api/chats", requireAuth, async (req, res) => {
  const db = await loadDB();
  const userId = req.session.userId;
  const chats = db.chats.filter((c) => (c.participantIds || []).includes(userId));
  const messagesByChat = {};
  for (const chat of chats) {
    messagesByChat[chat.id] = db.messages
      .filter((m) => m.chatId === chat.id)
      .sort((a, b) => a.ts - b.ts);
  }
  res.json({ chats, messagesByChat });
});

app.post("/api/chats", requireAuth, async (req, res) => {
  const { name, participants, encryptionKeyHash } = req.body || {};
  if (!name) return res.status(400).json({ error: "Chat name required." });
  if (!Array.isArray(participants) || participants.length === 0) {
    return res.status(400).json({ error: "At least one other participant is required." });
  }
  if (!encryptionKeyHash || typeof encryptionKeyHash !== "string") {
    return res.status(400).json({ error: "Missing encryption key hash." });
  }

  const db = await loadDB();
  const allUsers = db.users;
  const participantIds = [];

  const currentUserId = req.session.userId;
  participantIds.push(currentUserId);

  // Resolve each participant entry: if it looks like an id (u_...) validate directly,
  // otherwise treat as username and resolve to id.
  const missing = [];
  for (const p of participants) {
    if (typeof p !== "string") {
      missing.push(String(p));
      continue;
    }

    let u = null;
    if (p.startsWith("u_")) {
      u = allUsers.find((user) => user.id === p);
      if (!u) missing.push(p);
    } else {
      u = allUsers.find(
        (user) => user.username.toLowerCase() === p.toLowerCase()
      );
      if (!u) missing.push(p);
    }

    if (u && !participantIds.includes(u.id)) {
      participantIds.push(u.id);
    }
  }

  if (missing.length) {
    return res
      .status(400)
      .json({ error: `User(s) not found: ${missing.join(", ")}` });
  }

  const type = participantIds.length > 2 ? "group" : "dm";

  const chat = {
    id: generateId("c"),
    name,
    type,
    participantIds,
    encryption: {
      version: 1,
      keyHash: encryptionKeyHash
    },
    createdAt: new Date().toISOString()
  };

  db.chats.push(chat);
  // attempt to save, but don't fail the request if GitHub is unavailable
  await saveDB(db);

  res.status(201).json({ chat });
});

// Messages endpoint: check global pause
app.post("/api/messages", requireAuth, async (req, res) => {
  const { chatId, ciphertext, iv } = req.body || {};
  if (!chatId || !ciphertext || !iv) {
    return res.status(400).json({ error: "chatId, ciphertext, and iv are required." });
  }

  const db = await loadDB();

  if (db.globalPaused && db.globalPaused.messages && !req.session.isAdmin) {
    return res.status(503).json({ error: "Messaging is currently disabled by admin." });
  }

  const chat = db.chats.find((c) => c.id === chatId);
  const userId = req.session.userId;

  if (!chat || !(chat.participantIds || []).includes(userId)) {
    return res.status(404).json({ error: "Chat not found." });
  }

  const msg = {
    id: generateId("m"),
    chatId,
    fromUserId: userId,
    ciphertext,
    iv,
    ts: Date.now()
  };
  db.messages.push(msg);
  await saveDB(db);

  res.status(201).json({ message: msg });
});

// Calls endpoint: check global pause
app.post("/api/calls", requireAuth, async (req, res) => {
  const { toUsername, type, chatId } = req.body || {};
  if (!toUsername || !type) {
    return res.status(400).json({ error: "toUsername and type are required." });
  }
  if (!["video", "audio"].includes(type)) {
    return res.status(400).json({ error: "Invalid call type." });
  }

  const db = await loadDB();

  if (db.globalPaused && db.globalPaused.calls && !req.session.isAdmin) {
    return res.status(503).json({ error: "Calling is currently disabled by admin." });
  }

  const toUser = db.users.find(
    (u) => u.username.toLowerCase() === String(toUsername).toLowerCase() || u.id === String(toUsername)
  );
  if (!toUser) {
    return res.status(400).json({ error: "Target user not found." });
  }

  const call = {
    id: generateId("call"),
    type,
    fromUserId: req.session.userId,
    toUserId: toUser.id,
    chatId: chatId || null,
    status: "ringing",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  db.calls.push(call);
  await saveDB(db);
  res.status(201).json({ call });
});

// Chat management endpoints: rename, clear messages, delete, set-key in-place, rotate(create new & delete old)
app.post("/api/chats/:id/rename", requireAuth, async (req, res) => {
  const chatId = req.params.id;
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: "New name required." });
  const db = await loadDB();
  const chat = db.chats.find((c) => c.id === chatId);
  const userId = req.session.userId;
  if (!chat || !(chat.participantIds || []).includes(userId)) {
    return res.status(404).json({ error: "Chat not found." });
  }
  chat.name = String(name).slice(0, 200);
  await saveDB(db);
  res.json({ chat });
});

app.post("/api/chats/:id/clear", requireAuth, async (req, res) => {
  const chatId = req.params.id;
  const db = await loadDB();
  const chat = db.chats.find((c) => c.id === chatId);
  const userId = req.session.userId;
  if (!chat || !(chat.participantIds || []).includes(userId)) {
    return res.status(404).json({ error: "Chat not found." });
  }
  db.messages = db.messages.filter((m) => m.chatId !== chatId);
  await saveDB(db);
  res.json({ ok: true });
});

app.delete("/api/chats/:id", requireAuth, async (req, res) => {
  const chatId = req.params.id;
  const db = await loadDB();
  const chatIndex = db.chats.findIndex((c) => c.id === chatId);
  const userId = req.session.userId;
  if (chatIndex === -1) return res.status(404).json({ error: "Chat not found." });
  const chat = db.chats[chatIndex];
  if (!(chat.participantIds || []).includes(userId)) {
    return res.status(403).json({ error: "Not a participant." });
  }
  db.chats.splice(chatIndex, 1);
  db.messages = db.messages.filter((m) => m.chatId !== chatId);
  await saveDB(db);
  res.json({ ok: true });
});

// Set key in-place (update encryption.keyHash) - client will still keep raw code locally
app.post("/api/chats/:id/set-key", requireAuth, async (req, res) => {
  const chatId = req.params.id;
  const { encryptionKeyHash } = req.body || {};
  if (!encryptionKeyHash) return res.status(400).json({ error: "encryptionKeyHash required." });
  const db = await loadDB();
  const chat = db.chats.find((c) => c.id === chatId);
  const userId = req.session.userId;
  if (!chat || !(chat.participantIds || []).includes(userId)) {
    return res.status(404).json({ error: "Chat not found." });
  }
  chat.encryption = chat.encryption || {};
  chat.encryption.version = (chat.encryption && chat.encryption.version) || 1;
  chat.encryption.keyHash = encryptionKeyHash;
  chat.updatedAt = new Date().toISOString();
  await saveDB(db);
  res.json({ chat });
});

// Rotate key: create a new chat with same participants & name (new id), delete old chat + messages.
// returns the new chat object. Clients should share the new code out-of-band.
app.post("/api/chats/:id/rotate", requireAuth, async (req, res) => {
  const chatId = req.params.id;
  const { encryptionKeyHash } = req.body || {};
  if (!encryptionKeyHash) return res.status(400).json({ error: "encryptionKeyHash required." });

  const db = await loadDB();
  const oldIndex = db.chats.findIndex((c) => c.id === chatId);
  const userId = req.session.userId;
  if (oldIndex === -1) return res.status(404).json({ error: "Chat not found." });
  const oldChat = db.chats[oldIndex];
  if (!(oldChat.participantIds || []).includes(userId)) {
    return res.status(403).json({ error: "Not a participant." });
  }

  const newChat = {
    id: generateId("c"),
    name: oldChat.name + " (rotated)",
    type: oldChat.type,
    participantIds: [...oldChat.participantIds],
    encryption: {
      version: (oldChat.encryption && oldChat.encryption.version) || 1,
      keyHash: encryptionKeyHash
    },
    createdAt: new Date().toISOString()
  };

  // remove old chat and its messages
  db.chats.splice(oldIndex, 1);
  db.chats.push(newChat);
  db.messages = db.messages.filter((m) => m.chatId !== chatId);

  await saveDB(db);
  res.json({ chat: newChat });
});

// Admin: pause/unpause messaging or calls or both
app.post("/api/admin/pause", requireAdmin, async (req, res) => {
  const { pauseMessages, pauseCalls } = req.body || {};
  const db = await loadDB();
  db.globalPaused = db.globalPaused || { messages: false, calls: false };
  if (typeof pauseMessages === "boolean") db.globalPaused.messages = pauseMessages;
  if (typeof pauseCalls === "boolean") db.globalPaused.calls = pauseCalls;
  await saveDB(db);
  res.json({ globalPaused: db.globalPaused });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Talky (GitHub-backed, encrypted) running on http://localhost:${PORT}`);
});
