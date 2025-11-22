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
      hide(authScreen);
      show(mainScreen);
      loadChatKeyCache();
      startPendingCallPolling();
      await loadChats();
    } else {
      show(authScreen);
      hide(mainScreen);
      stopPendingCallPolling();
    }
  } catch (err) {
    console.error("Failed to refresh /api/me:", err);
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

function renderChatDetail(chat) {
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

  chatDetailName.textContent = chat.name;

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

  chatCallTarget.textContent = `Your Talky ID: ${currentUser ? currentUser.id : "?"}`;

  // Show key status
  const hasKey = !!(chatKeyCache[chat.id] && chatKeyCache[chat.id].code);
  if (!hasKey) {
    chatDetailPresence.textContent += " • 🔒 Locked (no chat key)";
    const btn = document.createElement("button");
    btn.className = "btn-pill";
    btn.textContent = "Import chat key";
    btn.style.marginLeft = "8px";
    btn.addEventListener("click", () => importKeyForChat(chat));
    chatDetailPresence.appendChild(document.createTextNode(" "));
    chatDetailPresence.appendChild(btn);
  }

  renderMessages(chat);
}

async function importKeyForChat(chat) {
  const code = prompt(
    "Paste the chat key code for this conversation (the letters + emojis)."
  );
  if (!code) return;
  try {
    const keyBytes = await deriveKeyBytesFromCode(code);
    const hashHex = bytesToHex(keyBytes);
    const expected = chat.encryption && chat.encryption.keyHash;
    if (!expected) {
      alert("This chat does not have encryption metadata.");
      return;
    }
    if (hashHex !== expected) {
      alert("That key does not match this chat.");
      return;
    }
    if (!chatKeyCache[chat.id]) chatKeyCache[chat.id] = {};
    chatKeyCache[chat.id].code = code;
    saveChatKeyCache();
    alert("Chat key saved. Reloading messages...");
    await loadChats();
    const c = chats.find((x) => x.id === chat.id);
    if (c) renderChatDetail(c);
  } catch (e) {
    alert("Failed to import key: " + e.message);
  }
}

chatSearchInput.addEventListener("input", () => {
  renderChatList();
});

btnChatSend.addEventListener("click", () => {
  sendMessage();
});

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

async function sendMessage() {
  if (!activeChatId) {
    alert("Select a chat first.");
    return;
  }
  const text = chatInput.value.trim();
  if (!text) return;

  const chat = chats.find((c) => c.id === activeChatId);
  if (!chat) {
    alert("Chat not found.");
    return;
  }

  if (!chatKeyCache[chat.id] || !chatKeyCache[chat.id].code) {
    alert("This chat is locked. Import the chat key first.");
    return;
  }

  try {
    const { ciphertext, iv } = await encryptMessageForChat(chat.id, text);
    const res = await jsonFetch("/api/messages", {
      method: "POST",
      body: JSON.stringify({ chatId: chat.id, ciphertext, iv })
    });
    const msg = res.message;
    if (!messagesByChat[chat.id]) messagesByChat[chat.id] = [];
    messagesByChat[chat.id].push(msg);
    chatInput.value = "";
    renderChatList();
    const updatedChat = chats.find((c) => c.id === chat.id);
    if (updatedChat) renderChatDetail(updatedChat);
  } catch (err) {
    console.error("Failed to send message:", err);
    alert(err.message || "Failed to send message.");
  }
}

btnNewChat.addEventListener("click", async () => {
  if (!currentUser) return;
  const name = prompt("Chat name:");
  if (!name) return;
  const rawParticipants = prompt(
    "Enter usernames to add (comma-separated, at least one)."
  );
  if (!rawParticipants) return;
  const participants = rawParticipants
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!participants.length) {
    alert("You must add at least one other user.");
    return;
  }

  const code = generateChatKeyCode();
  const keyBytes = await deriveKeyBytesFromCode(code);
  const encryptionKeyHash = bytesToHex(keyBytes);

  try {
    const res = await jsonFetch("/api/chats", {
      method: "POST",
      body: JSON.stringify({ name, participants, encryptionKeyHash })
    });
    const chat = res.chat;

    if (!chatKeyCache[chat.id]) chatKeyCache[chat.id] = {};
    chatKeyCache[chat.id].code = code;
    saveChatKeyCache();

    chats.push(chat);
    messagesByChat[chat.id] = [];
    activeChatId = chat.id;
    renderChatList();
    renderChatDetail(chat);

    alert(
      "Chat created.\n\nShare this chat key code with the other people so they can decrypt messages:\n\n" +
        code
    );
  } catch (err) {
    console.error("Failed to create chat:", err);
    alert(err.message || "Failed to create chat.");
  }
});

// ---------- Calls (signaling only) ----------
function openCallOverlayLayout(callType, title, bodyContent) {
  callDialogTitle.textContent =
    callType === "video" ? "Video Call" : "Audio Call";
  callDialogBody.innerHTML = "";
  callDialogBody.appendChild(bodyContent);
  callOverlay.classList.remove("hidden");
}

function closeCallOverlay() {
  callOverlay.classList.add("hidden");
}

callDialogClose.addEventListener("click", closeCallOverlay);
callOverlay.addEventListener("click", (e) => {
  if (e.target === callOverlay) {
    closeCallOverlay();
  }
});

function buildCallScreen(name, type, statusText, extraButtons = []) {
  const screen = document.createElement("div");
  screen.className = "call-screen";

  const avatar = document.createElement("div");
  avatar.className = "call-avatar";
  avatar.textContent = name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const nameEl = document.createElement("div");
  nameEl.className = "call-name";
  nameEl.textContent = name;

  const statusEl = document.createElement("div");
  statusEl.className = "call-status";
  statusEl.textContent = statusText;

  const typePill = document.createElement("div");
  typePill.className = "call-type-pill";
  typePill.textContent =
    type === "video" ? "Video call" : "Audio call";

  const buttonsRow = document.createElement("div");
  buttonsRow.className = "call-buttons";

  const endBtn = document.createElement("button");
  endBtn.className = "call-end-btn";
  endBtn.textContent = "✕";
  endBtn.addEventListener("click", closeCallOverlay);

  buttonsRow.appendChild(endBtn);
  extraButtons.forEach((b) => buttonsRow.appendChild(b));

  screen.appendChild(avatar);
  screen.appendChild(nameEl);
  screen.appendChild(statusEl);
  screen.appendChild(typePill);
  screen.appendChild(buttonsRow);

  return screen;
}

function openCallStartDialog(type) {
  if (!currentUser) {
    alert("Log in first.");
    return;
  }

  const container = document.createElement("div");
  container.style.display = "flex";
  container.style.flexDirection = "column";
  container.style.gap = "10px";

  const label1 = document.createElement("div");
  label1.textContent = "Start a call with:";
  label1.style.fontSize = "13px";

  const select = document.createElement("select");
  select.style.width = "100%";
  select.style.padding = "6px";
  select.style.borderRadius = "10px";
  select.style.border = "1px solid #e5e5ea";
  const optionNone = document.createElement("option");
  optionNone.value = "";
  optionNone.textContent = "— Pick from your chats —";
  select.appendChild(optionNone);

  chats.forEach((chat) => {
    const others = (chat.participantIds || []).filter(
      (id) => currentUser && id !== currentUser.id
    );
    if (!others.length) return;
    const opt = document.createElement("option");
    opt.value = chat.id;
    opt.textContent = `${chat.name} (${chat.type === "group" ? "group" : "dm"})`;
    select.appendChild(opt);
  });

  const orDiv = document.createElement("div");
  orDiv.style.fontSize = "11px";
  orDiv.style.color = "#999";
  orDiv.textContent = "or call by username:";

  const usernameInput = document.createElement("input");
  usernameInput.type = "text";
  usernameInput.placeholder = "Username (exact)";
  usernameInput.style.width = "100%";
  usernameInput.style.padding = "8px";
  usernameInput.style.borderRadius = "10px";
  usernameInput.style.border = "1px solid #e5e5ea";

  const startBtn = document.createElement("button");
  startBtn.className = "btn btn-primary";
  startBtn.textContent = type === "video" ? "Start video call" : "Start audio call";
  startBtn.style.marginTop = "4px";

  startBtn.addEventListener("click", async () => {
    let toUsername = usernameInput.value.trim();
    let chatId = null;

    if (!toUsername && select.value) {
      const chat = chats.find((c) => c.id === select.value);
      if (!chat) {
        alert("Chat not found.");
        return;
      }
      const others = (chat.participantIds || []).filter(
        (id) => currentUser && id !== currentUser.id
      );
      if (!others.length) {
        alert("This chat has no other users.");
        return;
      }
      toUsername = prompt(
        "This chat may include multiple users.\n\nEnter the username you want to call from this chat:"
      );
      if (!toUsername) return;
      chatId = chat.id;
    } else if (!toUsername && !select.value) {
      alert("Select a chat or type a username.");
      return;
    }

    try {
      const res = await jsonFetch("/api/calls", {
        method: "POST",
        body: JSON.stringify({ toUsername, type, chatId })
      });
      const call = res.call;
      const name = toUsername;
      const screen = buildCallScreen(
        name,
        type,
        "Calling using Talky IDs…"
      );
      openCallOverlayLayout(type, type === "video" ? "Video Call" : "Audio Call", screen);
    } catch (err) {
      alert(err.message || "Failed to start call.");
    }
  });

  container.appendChild(label1);
  container.appendChild(select);
  container.appendChild(orDiv);
  container.appendChild(usernameInput);
  container.appendChild(startBtn);

  openCallOverlayLayout(type, type === "video" ? "Video Call" : "Audio Call", container);
}

videoCallBtn.addEventListener("click", () => openCallStartDialog("video"));
audioCallBtn.addEventListener("click", () => openCallStartDialog("audio"));

// Poll for incoming calls
async function pollPendingCalls() {
  if (!currentUser) return;
  try {
    const res = await jsonFetch("/api/calls/pending");
    const calls = res.calls || [];
    if (!calls.length) return;
    const call = calls[0];

    const fromUserLabel = `User ${call.fromUserId}`;
    const screen = document.createElement("div");
    screen.className = "call-screen";

    const avatar = document.createElement("div");
    avatar.className = "call-avatar";
    avatar.textContent = "IN";

    const nameEl = document.createElement("div");
    nameEl.className = "call-name";
    nameEl.textContent = fromUserLabel;

    const statusEl = document.createElement("div");
    statusEl.className = "call-status";
    statusEl.textContent =
      call.type === "video"
        ? "Incoming video call…"
        : "Incoming audio call…";

    const typePill = document.createElement("div");
    typePill.className = "call-type-pill";
    typePill.textContent =
      call.type === "video" ? "Video call" : "Audio call";

    const buttonsRow = document.createElement("div");
    buttonsRow.className = "call-buttons";

    const acceptBtn = document.createElement("button");
    acceptBtn.className = "btn btn-primary";
    acceptBtn.textContent = "Accept";
    acceptBtn.style.borderRadius = "999px";
    acceptBtn.addEventListener("click", async () => {
      try {
        await jsonFetch(`/api/calls/${encodeURIComponent(call.id)}/accept`, {
          method: "POST"
        });
        const inCallScreen = buildCallScreen(
          fromUserLabel,
          call.type,
          "Call connected (demo)."
        );
        openCallOverlayLayout(call.type, "In Call", inCallScreen);
      } catch (err) {
        alert(err.message || "Failed to accept call.");
      }
    });

    const declineBtn = document.createElement("button");
    declineBtn.className = "btn-pill";
    declineBtn.textContent = "Decline";
    declineBtn.addEventListener("click", async () => {
      try {
        await jsonFetch(`/api/calls/${encodeURIComponent(call.id)}/decline`, {
          method: "POST"
        });
        closeCallOverlay();
      } catch (err) {
        alert(err.message || "Failed to decline.");
      }
    });

    const endBtn = document.createElement("button");
    endBtn.className = "call-end-btn";
    endBtn.textContent = "✕";
    endBtn.addEventListener("click", async () => {
      try {
        await jsonFetch(`/api/calls/${encodeURIComponent(call.id)}/decline`, {
          method: "POST"
        });
        closeCallOverlay();
      } catch (err) {
        closeCallOverlay();
      }
    });

    buttonsRow.appendChild(acceptBtn);
    buttonsRow.appendChild(declineBtn);
    buttonsRow.appendChild(endBtn);

    screen.appendChild(avatar);
    screen.appendChild(nameEl);
    screen.appendChild(statusEl);
    screen.appendChild(typePill);
    screen.appendChild(buttonsRow);

    openCallOverlayLayout(call.type, "Incoming Call", screen);
  } catch (err) {
    console.error("Failed to poll calls:", err);
  }
}

function startPendingCallPolling() {
  if (pendingCallPollTimer) return;
  pendingCallPollTimer = setInterval(pollPendingCalls, 5000);
}

function stopPendingCallPolling() {
  if (pendingCallPollTimer) {
    clearInterval(pendingCallPollTimer);
    pendingCallPollTimer = null;
  }
}

// ---------- Admin secret menu ----------
document.addEventListener("keydown", async (e) => {
  const onLoginScreen =
    !authScreen.classList.contains("hidden") &&
    mainScreen.classList.contains("hidden");

  if (
    onLoginScreen &&
    e.key.toLowerCase() === "z" &&
    e.ctrlKey &&
    e.altKey &&
    e.shiftKey
  ) {
    e.preventDefault();
    await openAdminMenu();
  }
});

async function openAdminMenu() {
  if (isAdminOpen) return;

  const pass = prompt("Enter admin password:");
  if (!pass) return;

  try {
    await jsonFetch("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: pass })
    });
  } catch (err) {
    alert(err.message || "Admin login failed.");
    return;
  }

  isAdminOpen = true;
  adminOverlay.classList.remove("hidden");
  await loadAdminUsers();
}

adminClose.addEventListener("click", () => {
  adminOverlay.classList.add("hidden");
  isAdminOpen = false;
});

adminOverlay.addEventListener("click", (e) => {
  if (e.target === adminOverlay) {
    adminOverlay.classList.add("hidden");
    isAdminOpen = false;
  }
});

async function loadAdminUsers() {
  adminBody.innerHTML = "Loading users…";
  try {
    const res = await jsonFetch("/api/admin/users");
    const users = res.users || [];
    if (!users.length) {
      adminBody.innerHTML =
        "<div style='font-size:12px;color:#999'>No users yet.</div>";
      return;
    }
    const container = document.createElement("div");
    users.forEach((u) => {
      const row = document.createElement("div");
      row.className = "admin-row";

      const main = document.createElement("div");
      main.className = "admin-user-main";

      const name = document.createElement("div");
      name.className = "admin-user-name";
      name.textContent = `${u.username} (${u.id})`;

      const meta = document.createElement("div");
      meta.className = "admin-user-meta";
      meta.textContent = `Joined: ${new Date(u.createdAt).toLocaleString()}`;

      main.appendChild(name);
      main.appendChild(meta);

      const right = document.createElement("div");
      right.style.display = "flex";
      right.style.alignItems = "center";
      right.style.gap = "6px";

      if (u.isAdmin) {
        const badge = document.createElement("span");
        badge.className = "admin-badge-admin";
        badge.textContent = "Admin";
        right.appendChild(badge);
      }

      const delBtn = document.createElement("button");
      delBtn.className = "admin-delete-btn";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", async () => {
        if (
          !confirm(
            `Delete user ${u.username}? This removes their chats, messages, and calls.`
          )
        ) {
          return;
        }
        try {
          await jsonFetch(`/api/admin/users/${encodeURIComponent(u.id)}`, {
            method: "DELETE"
          });
          await loadAdminUsers();
        } catch (err) {
          alert(err.message || "Failed to delete user.");
        }
      });

      right.appendChild(delBtn);

      row.appendChild(main);
      row.appendChild(right);
      container.appendChild(row);
    });
    adminBody.innerHTML = "";
    adminBody.appendChild(container);
  } catch (err) {
    console.error("Failed to load admin users:", err);
    adminBody.innerHTML =
      "<div style='font-size:12px;color:#b00'>Failed to load users.</div>";
  }
}

// ---------- Init ----------
switchAuthTab("login");
refreshMe();
