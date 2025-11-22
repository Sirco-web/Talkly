// app.js - Talky front-end (GitHub-backed, encrypted chats, call signaling)

// ---------- Element refs ----------
const authScreen = document.getElementById("auth-screen");
const mainScreen = document.getElementById("main-screen");

const tabLogin = document.getElementById("tab-login");
const tabSignup = document.getElementById("tab-signup");
const loginPanel = document.getElementById("auth-login-panel");
const signupPanel = document.getElementById("auth-signup-panel");

const loginUsernameInput = document.getElementById("login-username");
const loginPasswordInput = document.getElementById("login-password");
const signupUsernameInput = document.getElementById("signup-username");
const signupPasswordInput = document.getElementById("signup-password");

const loginErrorEl = document.getElementById("auth-login-error");
const signupErrorEl = document.getElementById("auth-signup-error");

const btnLogin = document.getElementById("btn-login");
const btnSignup = document.getElementById("btn-signup");
const btnLogout = document.getElementById("btn-logout");

const headerUsername = document.getElementById("header-username");
const headerUserId = document.getElementById("header-userid");

const chatItemsEl = document.getElementById("chat-items");
const chatSearchInput = document.getElementById("chat-search-input");
const chatDetailName = document.getElementById("chat-detail-name");
const chatDetailPresence = document.getElementById("chat-detail-presence");
const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const btnChatSend = document.getElementById("btn-chat-send");
const btnNewChat = document.getElementById("btn-new-chat");
const chatCallTarget = document.getElementById("chat-call-target");

const videoCallBtn = document.getElementById("btn-video-call");
const audioCallBtn = document.getElementById("btn-audio-call");
const callOverlay = document.getElementById("call-overlay");
const callDialogBody = document.getElementById("call-dialog-body");
const callDialogTitle = document.getElementById("call-dialog-title");
const callDialogClose = document.getElementById("call-dialog-close");

const adminOverlay = document.getElementById("admin-overlay");
const adminBody = document.getElementById("admin-body");
const adminClose = document.getElementById("admin-close");

// ---------- State ----------
let currentUser = null;
let chats = [];
let messagesByChat = {};
let activeChatId = null;
let isAdminOpen = false;
let pendingCallPollTimer = null;

// local chat key cache (chatId -> { code })
let chatKeyCache = {};

// ---------- Utilities ----------
async function jsonFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...options
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = (data && data.error) || `Request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

function show(el) {
  el.classList.remove("hidden");
}
function hide(el) {
  el.classList.add("hidden");
}

function switchAuthTab(tab) {
  if (tab === "login") {
    tabLogin.classList.add("active");
    tabSignup.classList.remove("active");
    show(loginPanel);
    hide(signupPanel);
  } else {
    tabSignup.classList.add("active");
    tabLogin.classList.remove("active");
    show(signupPanel);
    hide(loginPanel);
  }
  loginErrorEl.textContent = "";
  signupErrorEl.textContent = "";
}

tabLogin.addEventListener("click", () => switchAuthTab("login"));
tabSignup.addEventListener("click", () => switchAuthTab("signup"));

// ---------- Chat key helpers (SHA-based code -> AES key) ----------
const enc = new TextEncoder();
const dec = new TextDecoder();

function loadChatKeyCache() {
  try {
    const raw = localStorage.getItem("talky_chat_keys");
    if (!raw) {
      chatKeyCache = {};
      return;
    }
    chatKeyCache = JSON.parse(raw);
  } catch {
    chatKeyCache = {};
  }
}

function saveChatKeyCache() {
  localStorage.setItem("talky_chat_keys", JSON.stringify(chatKeyCache));
}

// Generate a human-ish code: groups of letters + emojis
function generateChatKeyCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const emojis = ["😀", "😎", "✨", "🔥", "🌙", "⭐", "🎧", "📞", "💬", "🔒"];
  function randChars(len) {
    let out = "";
    for (let i = 0; i < len; i++) {
      const idx = Math.floor(Math.random() * letters.length);
      out += letters[idx];
    }
    return out;
  }
  let code = `${randChars(4)}-${randChars(4)}-${randChars(4)}-${randChars(4)}`;
  const e1 = emojis[Math.floor(Math.random() * emojis.length)];
  const e2 = emojis[Math.floor(Math.random() * emojis.length)];
  code += ` ${e1}${e2}`;
  return code;
}

async function deriveKeyBytesFromCode(code) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(code));
  return new Uint8Array(digest);
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBuf(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function getAesKeyFromCode(code) {
  const keyBytes = await deriveKeyBytesFromCode(code);
  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [
    "encrypt",
    "decrypt"
  ]);
}

async function encryptMessageForChat(chatId, plaintext) {
  const entry = chatKeyCache[chatId];
  if (!entry || !entry.code) {
    throw new Error("Missing chat key code for this chat.");
  }
  const key = await getAesKeyFromCode(entry.code);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plaintext)
  );
  return {
    ciphertext: bufToBase64(ciphertextBuf),
    iv: bufToBase64(iv.buffer)
  };
}

async function decryptMessageForChat(chat, message) {
  const entry = chatKeyCache[chat.id];
  if (!entry || !entry.code) {
    throw new Error("Missing chat key code");
  }
  const key = await getAesKeyFromCode(entry.code);
  try {
    const ivBuf = base64ToBuf(message.iv);
    const cipherBuf = base64ToBuf(message.ciphertext);
    const plainBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(ivBuf) },
      key,
      cipherBuf
    );
    return dec.decode(plainBuf);
  } catch (e) {
    throw new Error("Decryption failed");
  }
}

// ---------- Auth flow ----------
async function refreshMe() {
  try {
    const res = await jsonFetch("/api/me");
    currentUser = res.user;
    if (currentUser) {
      headerUsername.textContent = currentUser.username;
      headerUserId.textContent = `ID: ${currentUser.id}`;

      // remove any stray overlays before showing main UI
      try { closeCallOverlay(); } catch {}
      document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());

      hide(authScreen);
      show(mainScreen);
      loadChatKeyCache();
      startPendingCallPolling();
      await loadChats();
    } else {
      // remove overlays that may block the auth screen
      try { closeCallOverlay(); } catch {}
      document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());

      show(authScreen);
      hide(mainScreen);
      stopPendingCallPolling();
    }
  } catch (err) {
    console.error("Failed to refresh /api/me:", err);

    // Ensure overlays don't block the auth screen on error
    try { closeCallOverlay(); } catch {}
    document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());

    show(authScreen);
    hide(mainScreen);
    stopPendingCallPolling();
  }
}

btnSignup.addEventListener("click", async () => {
  signupErrorEl.textContent = "";
  const username = signupUsernameInput.value.trim();
  const password = signupPasswordInput.value;

  if (!username || !password) {
    signupErrorEl.textContent = "Please fill out all fields.";
    return;
  }

  try {
    const res = await jsonFetch("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    currentUser = res.user;
    headerUsername.textContent = currentUser.username;
    headerUserId.textContent = `ID: ${currentUser.id}`;
    signupUsernameInput.value = "";
    signupPasswordInput.value = "";
    loadChatKeyCache();
    startPendingCallPolling();
    await loadChats();
    hide(authScreen);
    show(mainScreen);
  } catch (err) {
    console.error("Signup failed:", err);
    signupErrorEl.textContent = err.message;
  }
});

btnLogin.addEventListener("click", async () => {
  loginErrorEl.textContent = "";
  const username = loginUsernameInput.value.trim();
  const password = loginPasswordInput.value;

  if (!username || !password) {
    loginErrorEl.textContent = "Please fill out all fields.";
    return;
  }

  try {
    const res = await jsonFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    currentUser = res.user;
    headerUsername.textContent = currentUser.username;
    headerUserId.textContent = `ID: ${currentUser.id}`;
    loginPasswordInput.value = "";
    loadChatKeyCache();
    startPendingCallPolling();
    await loadChats();
    hide(authScreen);
    show(mainScreen);
  } catch (err) {
    console.error("Login failed:", err);
    loginErrorEl.textContent = err.message;
  }
});

btnLogout.addEventListener("click", async () => {
  try {
    await jsonFetch("/api/auth/logout", { method: "POST" });
  } catch {}
  currentUser = null;
  chats = [];
  messagesByChat = {};
  activeChatId = null;
  chatItemsEl.innerHTML = "";
  chatMessages.innerHTML = "";
  stopPendingCallPolling();
  show(authScreen);
  hide(mainScreen);
});

// ---------- Chats + messages ----------
async function loadChats() {
  if (!currentUser) return;
  try {
    const res = await jsonFetch("/api/chats");
    chats = res.chats || [];
    messagesByChat = res.messagesByChat || {};
    renderChatList();
    if (activeChatId) {
      const chat = chats.find((c) => c.id === activeChatId);
      if (chat) {
        renderChatDetail(chat);
        return;
      }
    }
    renderChatDetail(null);
  } catch (err) {
    console.error("Failed to load chats:", err);
    chatItemsEl.innerHTML =
      "<div style='padding:10px;font-size:12px;color:#b00'>Failed to load chats.</div>";
  }
}

function renderChatList() {
  chatItemsEl.innerHTML = "";
  const q = chatSearchInput.value.trim().toLowerCase();

  const visible = chats.filter((c) => {
    if (!q) return true;
    return c.name.toLowerCase().includes(q);
  });

  if (!visible.length) {
    const empty = document.createElement("div");
    empty.style.padding = "12px";
    empty.style.fontSize = "12px";
    empty.style.color = "#a0a0a6";
    empty.textContent = "No chats yet. Tap “New chat” to create one.";
    chatItemsEl.appendChild(empty);
    return;
  }

  visible.forEach((chat) => {
    const item = document.createElement("div");
    item.className = "chat-item" + (chat.id === activeChatId ? " active" : "");
    item.dataset.chatId = chat.id;

    const avatar = document.createElement("div");
    avatar.className = "chat-avatar";
    avatar.textContent = chat.name
      .split(" ")
      .map((p) => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();

    const textContainer = document.createElement("div");
    textContainer.className = "chat-text";

    const leftCol = document.createElement("div");
    const nameEl = document.createElement("div");
    nameEl.className = "chat-name";
    nameEl.textContent = chat.name;
    leftCol.appendChild(nameEl);

    const rightCol = document.createElement("div");
    rightCol.style.textAlign = "right";

    const msgEl = document.createElement("div");
    msgEl.className = "chat-last-message";

    const metaEl = document.createElement("div");
    metaEl.className = "chat-meta";

    const msgs = messagesByChat[chat.id] || [];
    if (msgs.length) {
      const last = msgs[msgs.length - 1];
      msgEl.textContent = "[Encrypted message]";
      metaEl.textContent = new Date(last.ts).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit"
      });
    } else {
      msgEl.textContent = "No messages yet";
      metaEl.textContent = "";
    }

    rightCol.appendChild(msgEl);
    rightCol.appendChild(metaEl);

    textContainer.appendChild(leftCol);
    textContainer.appendChild(rightCol);

    item.appendChild(avatar);
    item.appendChild(textContainer);

    item.addEventListener("click", () => {
      activeChatId = chat.id;
      renderChatList();
      renderChatDetail(chat);
    });

    chatItemsEl.appendChild(item);
  });
}

async function renderMessages(chat) {
  chatMessages.innerHTML = "";
  const messages = messagesByChat[chat.id] || [];

  if (!messages.length) {
    const info = document.createElement("div");
    info.style.fontSize = "12px";
    info.style.color = "#777";
    info.textContent = "No messages yet. Say hi!";
    chatMessages.appendChild(info);
    return;
  }

  let hasKey = !!(chatKeyCache[chat.id] && chatKeyCache[chat.id].code);

  for (const m of messages) {
    const row = document.createElement("div");
    const isMe = currentUser && m.fromUserId === currentUser.id;
    row.className = "msg-row " + (isMe ? "me" : "them");

    const bubble = document.createElement("div");
    bubble.className = "msg-bubble " + (isMe ? "me" : "them");

    if (!hasKey) {
      bubble.textContent = "🔒 Encrypted message (no chat key)";
    } else {
      try {
        const text = await decryptMessageForChat(chat, m);
        bubble.textContent = text;
      } catch (e) {
        bubble.textContent = "🔒 Unable to decrypt (key mismatch)";
      }
    }

    row.appendChild(bubble);
    chatMessages.appendChild(row);
  }

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ---------- Settings (ringtone, volume) ----------
const SETTINGS_KEY = "talky_settings";
let talkySettings = { ringtone: "default", volume: 0.6 };

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) talkySettings = JSON.parse(raw);
  } catch {}
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(talkySettings));
}
loadSettings();

// Simple WebAudio tone player for dialing/ringtone
let audioCtx = null;
let toneNode = null;
let toneGain = null;
function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

function playDialTone() {
  stopTone();
  ensureAudio();
  toneNode = audioCtx.createOscillator();
  toneGain = audioCtx.createGain();
  toneNode.type = "sine";
  toneNode.frequency.value = 425; // simple dialing-ish tone
  toneGain.gain.value = talkySettings.volume;
  toneNode.connect(toneGain);
  toneGain.connect(audioCtx.destination);
  toneNode.start();
}
function playRingtone() {
  stopTone();
  ensureAudio();
  // use alternating beep pattern using oscillator and scheduling
  toneNode = audioCtx.createOscillator();
  toneGain = audioCtx.createGain();
  toneNode.type = "sine";
  toneNode.frequency.value = 880;
  toneGain.gain.value = talkySettings.volume * 0.8;
  toneNode.connect(toneGain);
  toneGain.connect(audioCtx.destination);
  toneNode.start();
}
function stopTone() {
  try {
    if (toneNode) {
      toneNode.stop();
      toneNode.disconnect();
    }
    if (toneGain) toneGain.disconnect();
  } catch {}
  toneNode = null;
  toneGain = null;
}

// Request notification permission on first use
async function ensureNotifications() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  try {
    const perm = await Notification.requestPermission();
    return perm === "granted";
  } catch {
    return false;
  }
}

// Show browser notification for incoming call/message
function showNotification(title, body, onClick) {
  try {
    if (Notification.permission === "granted") {
      const n = new Notification(title, { body, renotify: true });
      if (onClick) n.onclick = onClick;
    }
  } catch {}
}

// Settings modal (open when clicking header username)
headerUsername.style.cursor = "pointer";
headerUsername.addEventListener("click", openSettingsModal);

function openSettingsModal() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const dialog = document.createElement("div");
  dialog.className = "modal-dialog";

  const header = document.createElement("div");
  header.className = "modal-header";
  const title = document.createElement("div");
  title.className = "modal-title";
  title.textContent = "Settings";
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.className = "call-end-btn";
  closeBtn.addEventListener("click", () => document.body.removeChild(overlay));
  header.appendChild(title);
  header.appendChild(closeBtn);

  const rowR = document.createElement("div");
  rowR.className = "modal-row";
  const lblR = document.createElement("div");
  lblR.textContent = "Ringtone";
  const sel = document.createElement("select");
  ["default","dial","beep","chime"].forEach((v) => {
    const o = document.createElement("option"); o.value = v; o.textContent = v; if (talkySettings.ringtone === v) o.selected = true;
    sel.appendChild(o);
  });
  rowR.appendChild(lblR);
  rowR.appendChild(sel);

  const rowV = document.createElement("div");
  rowV.className = "modal-row";
  const lblV = document.createElement("div");
  lblV.textContent = "Volume";
  const vol = document.createElement("input");
  vol.type = "range"; vol.min = 0; vol.max = 1; vol.step = 0.01; vol.value = talkySettings.volume;
  rowV.appendChild(lblV);
  rowV.appendChild(vol);

  const testBtn = document.createElement("button");
  testBtn.className = "btn-pill";
  testBtn.textContent = "Test ringtone";
  testBtn.addEventListener("click", () => {
    talkySettings.ringtone = sel.value;
    talkySettings.volume = Number(vol.value);
    saveSettings();
    // quick test tone
    playRingtone();
    setTimeout(stopTone, 800);
  });

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const done = document.createElement("button");
  done.className = "btn btn-primary";
  done.textContent = "Save";
  done.addEventListener("click", async () => {
    talkySettings.ringtone = sel.value;
    talkySettings.volume = Number(vol.value);
    saveSettings();
    await ensureNotifications();
    document.body.removeChild(overlay);
  });
  actions.appendChild(testBtn);
  actions.appendChild(done);

  dialog.appendChild(header);
  dialog.appendChild(rowR);
  dialog.appendChild(rowV);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
}

// ---------- Chat detail management UI ----------
function addChatManagementButtons(chat) {
  // remove existing controls if any
  const existing = document.getElementById("chat-manage-row");
  if (existing) existing.remove();

  const row = document.createElement("div");
  row.id = "chat-manage-row";
  row.style.display = "flex";
  row.style.gap = "8px";
  row.style.marginLeft = "8px";
  row.style.alignItems = "center";

  const renameBtn = document.createElement("button");
  renameBtn.className = "btn-pill";
  renameBtn.textContent = "Rename";
  renameBtn.addEventListener("click", async () => {
    const newName = await showPrompt("Rename chat", "New chat name:", { placeholder: chat.name });
    if (!newName) return;
    try {
      const res = await jsonFetch(`/api/chats/${encodeURIComponent(chat.id)}/rename`, {
        method: "POST",
        body: JSON.stringify({ name: newName })
      });
      const updated = res.chat;
      const local = chats.find((c) => c.id === updated.id) || updated;
      local.name = updated.name;
      renderChatList();
      renderChatDetail(updated);
      await showAlert("Renamed", "Chat renamed.");
    } catch (e) {
      await showAlert("Error", e.message || "Rename failed.");
    }
  });

  const clearBtn = document.createElement("button");
  clearBtn.className = "btn-pill";
  clearBtn.textContent = "Clear messages";
  clearBtn.addEventListener("click", async () => {
    const ok = await showConfirm("Clear messages", "Clear all messages in this chat? This cannot be undone.");
    if (!ok) return;
    try {
      await jsonFetch(`/api/chats/${encodeURIComponent(chat.id)}/clear`, { method: "POST" });
      messagesByChat[chat.id] = [];
      renderMessages(chat);
      renderChatList();
      await showAlert("Cleared", "Messages cleared.");
    } catch (e) {
      await showAlert("Error", e.message || "Clear failed.");
    }
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn-pill";
  deleteBtn.textContent = "Delete chat";
  deleteBtn.style.background = "#ffecec";
  deleteBtn.addEventListener("click", async () => {
    const ok = await showConfirm("Delete chat", "Delete this chat and all messages? This cannot be undone.");
    if (!ok) return;
    try {
      await jsonFetch(`/api/chats/${encodeURIComponent(chat.id)}`, { method: "DELETE" });
      chats = chats.filter((c) => c.id !== chat.id);
      delete messagesByChat[chat.id];
      activeChatId = null;
      renderChatList();
      renderChatDetail(null);
      await showAlert("Deleted", "Chat deleted.");
    } catch (e) {
      await showAlert("Error", e.message || "Delete failed.");
    }
  });

  const setKeyBtn = document.createElement("button");
  setKeyBtn.className = "btn-pill";
  setKeyBtn.textContent = "Import key";
  setKeyBtn.addEventListener("click", async () => {
    const code = await showPrompt("Import chat key", "Paste the chat key code for this conversation (the letters + emojis).", { textarea: true, rows: 2 });
    if (!code) return;
    try {
      const keyBytes = await deriveKeyBytesFromCode(code);
      const hashHex = bytesToHex(keyBytes);
      await jsonFetch(`/api/chats/${encodeURIComponent(chat.id)}/set-key`, {
        method: "POST",
        body: JSON.stringify({ encryptionKeyHash: hashHex })
      });
      if (!chatKeyCache[chat.id]) chatKeyCache[chat.id] = {};
      chatKeyCache[chat.id].code = code;
      saveChatKeyCache();
      await showAlert("Success", "Chat key set. Reloading messages...");
      await loadChats();
    } catch (e) {
      await showAlert("Error", "Failed to import key: " + (e.message || e));
    }
  });

  const rotateBtn = document.createElement("button");
  rotateBtn.className = "btn-pill";
  rotateBtn.textContent = "Rotate key (new chat)";
  rotateBtn.addEventListener("click", async () => {
    const ok = await showConfirm("Rotate key", "Rotate this chat key: a new chat will be created and the old chat deleted. Continue?");
    if (!ok) return;
    const code = generateChatKeyCode();
    try {
      const keyBytes = await deriveKeyBytesFromCode(code);
      const hashHex = bytesToHex(keyBytes);
      const res = await jsonFetch(`/api/chats/${encodeURIComponent(chat.id)}/rotate`, {
        method: "POST",
        body: JSON.stringify({ encryptionKeyHash: hashHex })
      });
      const newChat = res.chat;
      if (!chatKeyCache[newChat.id]) chatKeyCache[newChat.id] = {};
      chatKeyCache[newChat.id].code = code;
      saveChatKeyCache();
      chats = chats.filter((c) => c.id !== chat.id);
      chats.push(newChat);
      messagesByChat[newChat.id] = [];
      activeChatId = newChat.id;
      renderChatList();
      renderChatDetail(newChat);
      showCopyableKeyModal("New chat key", code);
    } catch (e) {
      await showAlert("Error", e.message || "Rotate failed.");
    }
  });

  row.appendChild(renameBtn);
  row.appendChild(clearBtn);
  row.appendChild(deleteBtn);
  row.appendChild(setKeyBtn);
  row.appendChild(rotateBtn);

  chatDetailPresence.appendChild(document.createTextNode(" "));
  chatDetailPresence.appendChild(row);
}

// Modify renderChatDetail to include a visible "Delete chat" button in the header
async function renderChatDetail(chat) {
  // Cleanup previous header-manage/delete button if present
  const maybeBtn = document.getElementById("btn-chat-delete");
  if (maybeBtn) maybeBtn.remove();
  const existingManage = document.getElementById("chat-manage-row");
  if (existingManage) existingManage.remove();

  if (!chat) {
    chatDetailName.textContent = "Select a chat";
    chatDetailPresence.textContent = "No conversation selected.";
    chatCallTarget.textContent = "Talky ID will show here";
    chatMessages.innerHTML = "";
    const info = document.createElement("div");
    info.style.fontSize = "12px";
    info.style.color = "#777";
    info.textContent = "Pick a chat on the left to see the conversation here.";
    chatMessages.appendChild(info);
    return;
  }

  // Title
  chatDetailName.textContent = chat.name;

  // Add delete button to header (right side)
  try {
    const headerEl = chatDetailName.parentElement; // .chat-detail-header
    let delBtn = document.getElementById("btn-chat-delete");
    if (!delBtn) {
      delBtn = document.createElement("button");
      delBtn.id = "btn-chat-delete";
      delBtn.className = "btn-pill";
      delBtn.style.marginLeft = "8px";
      delBtn.textContent = "Delete chat";
      delBtn.addEventListener("click", async () => {
        const ok = await showConfirm(
          "Delete chat",
          "Delete this chat and all messages? This cannot be undone."
        );
        if (!ok) return;
        try {
          await jsonFetch(`/api/chats/${encodeURIComponent(chat.id)}`, { method: "DELETE" });
          // update local state
          chats = chats.filter((c) => c.id !== chat.id);
          delete messagesByChat[chat.id];
          activeChatId = null;
          renderChatList();
          renderChatDetail(null);
          await showAlert("Deleted", "Chat deleted.");
        } catch (e) {
          await showAlert("Error", e.message || "Delete failed.");
        }
      });
    }
    // attach if not already attached
    if (delBtn.parentElement !== headerEl) {
      if (delBtn.parentElement) delBtn.parentElement.removeChild(delBtn);
      headerEl.appendChild(delBtn);
    }
  } catch (e) {
    console.warn("Failed to add delete button:", e);
  }

  // Presence text
  const others = (chat.participantIds || []).filter(
    (id) => currentUser && id !== currentUser.id
  );
  if (!others.length) {
    chatDetailPresence.textContent = "Just you in this chat.";
  } else {
    chatDetailPresence.textContent =
      chat.type === "group"
        ? `Group chat with ${others.length} others.`
        : "Direct chat.";
  }

  // Show Talky ID / call target
  chatCallTarget.textContent = `Your Talky ID: ${currentUser ? currentUser.id : "?"}`;

  // Add management buttons row (rename, clear, import, rotate, delete handled here)
  addChatManagementButtons(chat);

  // Show key status (add a brief note if locked)
  const hasKey = !!(chatKeyCache[chat.id] && chatKeyCache[chat.id].code);
  if (!hasKey) {
    // Avoid duplicating text by appending to presence rather than replacing it
    const note = document.createElement("span");
    note.style.marginLeft = "8px";
    note.textContent = "• 🔒 Locked (no chat key)";
    chatDetailPresence.appendChild(note);
  }

  // Render messages (will show decrypt status per message)
  await renderMessages(chat);
}
