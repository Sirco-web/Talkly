// server.js - Talky demo Node.js server with GitHub-backed storage
// Node 18+ recommended (built-in fetch).
// Stores a single JSON file in a GitHub repo using the REST "contents" API.

import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// --------- Config via environment variables ---------
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER; // e.g. "Sirco-team"
const GITHUB_REPO = process.env.GITHUB_REPO;   // e.g. "talky-data"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const DATA_PATH = process.env.DATA_PATH || "talky/data.json";

if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
  console.error("Missing GitHub config. Set GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO.");
  process.exit(1);
}

// --------- Helpers for GitHub API ---------
const GITHUB_API_BASE = "https://api.github.com";

async function githubRequest(apiPath, options = {}) {
  const url = `${GITHUB_API_BASE}${apiPath}`;
  const headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "talky-node-demo",
    "Authorization": `Bearer ${GITHUB_TOKEN}`,
    "X-GitHub-Api-Version": "2022-11-28",
    ...(options.headers || {})
  };

  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`GitHub API ${res.status} ${res.statusText}: ${text}`);
    err.status = res.status;
    throw err;
  }
  // Some endpoints (like 204) have no body
  if (res.status === 204) return null;
  return await res.json();
}

// Get contents of the data file (or null if it doesn't exist)
async function getDataFile() {
  try {
    const json = await githubRequest(
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(DATA_PATH)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`
    );
    // json.content is base64-encoded
    const content = Buffer.from(json.content, "base64").toString("utf8");
    const data = JSON.parse(content);
    return { data, sha: json.sha };
  } catch (err) {
    if (err.status === 404) {
      return null;
    }
    throw err;
  }
}

// Create or update the data file
async function putDataFile(newData, shaOrNull, message) {
  const content = Buffer.from(JSON.stringify(newData, null, 2), "utf8").toString("base64");
  const body = {
    message,
    content,
    branch: GITHUB_BRANCH
  };
  if (shaOrNull) {
    body.sha = shaOrNull;
  }

  const json = await githubRequest(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(DATA_PATH)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );
  return json;
}

// Ensure the data file exists; returns { data, sha }
async function ensureDataFile() {
  const current = await getDataFile();
  if (current) return current;

  // Initialize with simple data structure
  const initialData = {
    version: 1,
    createdAt: new Date().toISOString(),
    chats: [
      {
        id: 1,
        name: "Alex Johnson",
        time: "9:12 AM",
        presence: "Online • Available"
      },
      {
        id: 2,
        name: "Family Group",
        time: "Yesterday",
        presence: "3 members • Notifications on"
      }
    ],
    messages: {
      "1": [
        { from: "them", text: "Hey! Just checking if you’re free later tonight?", ts: Date.now() - 600000 },
        { from: "them", text: "I want to show you something cool on video.", ts: Date.now() - 590000 },
        { from: "me", text: "Yeah, I’m free after 7.", ts: Date.now() - 580000 },
        { from: "them", text: "Perfect, I’ll call you on Talky!", ts: Date.now() - 570000 }
      ],
      "2": [
        { from: "them", text: "Don’t forget Sunday dinner at 6pm.", ts: Date.now() - 3600000 },
        { from: "them", text: "Let’s try using Talky this time 👍", ts: Date.now() - 3500000 },
        { from: "me", text: "I’ll help Grandma join the call.", ts: Date.now() - 3400000 }
      ]
    }
  };

  await putDataFile(initialData, null, "Initialize Talky data file");
  return { data: initialData, sha: null }; // sha not needed immediately
}

// Update data with a function
async function updateData(updater, commitMessage) {
  const current = await ensureDataFile();
  const { data, sha } = current;
  const updated = await updater(structuredClone(data));
  await putDataFile(updated, sha, commitMessage);
  return updated;
}

// --------- Express setup ---------
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// API: Get chats + messages
app.get("/api/data", async (req, res) => {
  try {
    const current = await ensureDataFile();
    res.json(current.data);
  } catch (err) {
    console.error("GET /api/data failed:", err);
    res.status(500).json({ error: "Failed to load data from GitHub." });
  }
});

// API: Post a message to a chat
app.post("/api/message", async (req, res) => {
  const { chatId, from, text } = req.body || {};
  if (!chatId || !from || !text) {
    return res.status(400).json({ error: "chatId, from, and text are required." });
  }

  try {
    const updated = await updateData((data) => {
      const idStr = String(chatId);
      if (!data.messages[idStr]) {
        data.messages[idStr] = [];
      }
      const now = Date.now();
      const msg = { from, text, ts: now };
      data.messages[idStr].push(msg);

      // also bump chat "time" for simple UI
      const chat = data.chats.find((c) => String(c.id) === idStr);
      if (chat) {
        const d = new Date();
        const hour = d.getHours();
        const minute = d.getMinutes().toString().padStart(2, "0");
        const ampm = hour >= 12 ? "PM" : "AM";
        const hour12 = ((hour + 11) % 12) + 1;
        chat.time = `${hour12}:${minute} ${ampm}`;
      }
      return data;
    }, `Add message in chat ${chatId}`);

    res.json({ ok: true, data: updated });
  } catch (err) {
    console.error("POST /api/message failed:", err);
    if (err.status === 409) {
      return res.status(409).json({ error: "GitHub file conflict, try again." });
    }
    res.status(500).json({ error: "Failed to append message." });
  }
});

// Fallback: serve index.html for any unknown route (basic SPA-ish)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Talky server listening on http://localhost:${PORT}`);
});
