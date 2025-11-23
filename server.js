// server.js - Talky with GitHub-backed storage + encrypted chats (Calls Removed)
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

// --- In-Memory Cache for Speed ---
let dbCache = null;
let dbCacheTime = 0;
const CACHE_TTL = 5000; // 5 seconds TTL for external changes, otherwise we use local cache

// Background save queue to prevent race conditions and allow instant response
let saveQueue = Promise.resolve();
function queueSaveDB(db) {
  // Update cache immediately
  dbCache = db;
  dbCacheTime = Date.now();
  
  // Queue the GitHub write
  saveQueue = saveQueue.then(() => saveDBInternal(db)).catch(err => console.error("Background save failed:", err));
}

if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
  console.error("Missing GitHub env vars. Set GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO.");
}

app.use(express.json({ limit: "50mb" }));
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
    return { users: [], chats: [], messages: [], globalPaused: { messages: false } };
  }

  // Serve from cache if available and fresh enough (or if we just wrote to it)
  if (dbCache && (Date.now() - dbCacheTime < CACHE_TTL)) {
    // Return a deep copy to prevent mutation issues
    return JSON.parse(JSON.stringify(dbCache));
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
    if (!json.globalPaused || typeof json.globalPaused !== "object")
      json.globalPaused = { messages: false };

    // Update cache
    dbCache = json;
    dbCacheTime = Date.now();

    return json;
  } catch (err) {
    if (String(err.message).includes("404")) {
      return { users: [], chats: [], messages: [], globalPaused: { messages: false } };
    }
    console.error("Failed to load DB from GitHub:", err);
    // Return cache if available even if expired, better than crashing
    if (dbCache) return JSON.parse(JSON.stringify(dbCache));
    return { users: [], chats: [], messages: [], globalPaused: { messages: false } };
  }
}

async function saveDBInternal(db) {
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
      if (dbCache) dbCache._sha = res.content.sha;
    }
    return true;
  } catch (err) {
    console.error("Failed to save DB to GitHub:", err);
    return false;
  }
}

async function saveDB(db) {
  queueSaveDB(db);
  return true;
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
  await saveDB(db);

  res.status(201).json({ chat });
});

// NEW: Upload File to GitHub (separate from data.json)
app.post("/api/upload", requireAuth, async (req, res) => {
  const { content, ext } = req.body; // content is base64 encrypted data
  if (!content || !ext) return res.status(400).json({ error: "Missing content or extension" });

  const userId = req.session.userId;
  const randomName = crypto.randomBytes(16).toString("hex");
  const fileName = `${randomName}${ext}`;
  const filePath = `talky/uploads/${userId}/${fileName}`;

  const body = {
    message: `Upload ${fileName}`,
    content: content, // GitHub API expects base64 content
    branch: GITHUB_BRANCH
  };

  try {
    await githubRequest(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(filePath)}`,
      { method: "PUT", body: JSON.stringify(body) }
    );
    res.json({ path: filePath });
  } catch (err) {
    console.error("Upload failed:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// NEW: Get File from GitHub
app.get("/api/file", requireAuth, async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send("Missing path");

  try {
    const file = await githubRequest(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`
    );
    // file.content is base64
    const buffer = Buffer.from(file.content, "base64");
    res.set("Content-Type", "application/octet-stream");
    res.send(buffer);
  } catch (err) {
    console.error("File fetch failed:", err);
    res.status(404).send("File not found");
  }
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
  
  // Use non-blocking save for instant response
  queueSaveDB(db);

  res.status(201).json({ message: msg });
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

// Admin: pause/unpause messaging
app.post("/api/admin/pause", requireAdmin, async (req, res) => {
  const { pauseMessages } = req.body || {};
  const db = await loadDB();
  db.globalPaused = db.globalPaused || { messages: false };
  if (typeof pauseMessages === "boolean") db.globalPaused.messages = pauseMessages;
  await saveDB(db);
  res.json({ globalPaused: db.globalPaused });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Talky (GitHub-backed, encrypted) running on http://localhost:${PORT}`);
});
