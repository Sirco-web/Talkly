// app.js - Talky front-end (GitHub-backed, encrypted chats, call signaling)

// Inject Video Call Styles
const videoStyles = document.createElement('style');
videoStyles.textContent = `
  .video-call-wrapper {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 400px;
    background: #000;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border-radius: 12px;
  }
  #remote-video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  #local-video {
    position: absolute;
    bottom: 16px;
    right: 16px;
    width: 160px;
    height: 120px;
    background: #333;
    border: 2px solid rgba(255,255,255,0.3);
    border-radius: 12px;
    object-fit: cover;
    cursor: grab;
    z-index: 10;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    transition: box-shadow 0.2s;
  }
  #local-video:active {
    cursor: grabbing;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  }
  .call-overlay-controls {
    position: absolute;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 16px;
    z-index: 20;
    background: rgba(0,0,0,0.6);
    padding: 12px 24px;
    border-radius: 999px;
    backdrop-filter: blur(4px);
  }
  .call-overlay-controls button {
    background: transparent;
    border: none;
    color: white;
    font-size: 20px;
    cursor: pointer;
    padding: 8px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    transition: background 0.2s;
  }
  .call-overlay-controls button:hover {
    background: rgba(255,255,255,0.2);
  }
  .call-overlay-controls button.hangup {
    background: #ff4d4f;
  }
  .call-overlay-controls button.hangup:hover {
    background: #ff7875;
  }
`;
document.head.appendChild(videoStyles);

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
try {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (raw) talkySettings = JSON.parse(raw);
} catch {}

// ---------- WebRTC State ----------
let localStream = null;
let peerConnection = null;
let signalingInterval = null;
let currentCallId = null;
const rtcConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

// ---------- Audio Helpers ----------
let audioCtx = null;
let toneNode = null;
let toneGain = null;

function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function playTone(freq, type = "sine") {
  stopTone();
  ensureAudio();
  toneNode = audioCtx.createOscillator();
  toneGain = audioCtx.createGain();
  toneNode.type = type;
  toneNode.frequency.value = freq;
  toneGain.gain.value = talkySettings.volume;
  toneNode.connect(toneGain);
  toneGain.connect(audioCtx.destination);
  toneNode.start();
}

function playDialTone() { playTone(425); }
function playRingtone() { playTone(880, "triangle"); } // Distinct ringtone
function stopTone() {
  if (toneNode) { try { toneNode.stop(); } catch{} toneNode.disconnect(); toneNode = null; }
  if (toneGain) { toneGain.disconnect(); toneGain = null; }
}

// ---------- WebRTC Logic ----------
async function startWebRTC(isCaller, callId, type) {
  currentCallId = callId;
  peerConnection = new RTCPeerConnection(rtcConfig);

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) sendSignal(callId, "candidate", event.candidate);
  };

  peerConnection.ontrack = (event) => {
    const remoteVid = document.getElementById("remote-video");
    if (remoteVid) remoteVid.srcObject = event.streams[0];
  };

  try {
    const constraints = { audio: true, video: type === "video" };
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    
    const localVid = document.getElementById("local-video");
    if (localVid) {
      localVid.srcObject = localStream;
      localVid.muted = true;
    }

    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    if (isCaller) {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      await sendSignal(callId, "offer", offer);
    }
    
    startSignalingPolling(callId);
  } catch (err) {
    console.error("Media Error:", err);
    alert("Could not access camera/microphone. Ensure you are on HTTPS or localhost.");
  }
}

async function sendSignal(callId, type, data) {
  await jsonFetch(`/api/calls/${encodeURIComponent(callId)}/signal`, {
    method: "POST",
    body: JSON.stringify({ type, data })
  });
}

function startSignalingPolling(callId) {
  if (signalingInterval) clearInterval(signalingInterval);
  let lastSignalTs = Date.now();
  
  signalingInterval = setInterval(async () => {
    try {
      const res = await jsonFetch(`/api/calls/${encodeURIComponent(callId)}/signal?since=${lastSignalTs}`);
      if (res.signals && res.signals.length) {
        for (const sig of res.signals) {
          lastSignalTs = Math.max(lastSignalTs, sig.ts);
          await handleSignal(sig);
        }
      }
    } catch (e) { console.error(e); }
  }, 1000);
}

async function handleSignal(sig) {
  if (!peerConnection) return;
  if (sig.type === "offer") {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(sig.data));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    await sendSignal(currentCallId, "answer", answer);
  } else if (sig.type === "answer") {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(sig.data));
  } else if (sig.type === "candidate") {
    await peerConnection.addIceCandidate(new RTCIceCandidate(sig.data));
  }
}

function stopWebRTC() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (signalingInterval) {
    clearInterval(signalingInterval);
    signalingInterval = null;
  }
  currentCallId = null;
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

// Settings modal (open when clicking header username or settings button)
headerUsername.style.cursor = "pointer";
headerUsername.addEventListener("click", openSettingsModal);

const btnSettings = document.getElementById("btn-settings");
if (btnSettings) {
  btnSettings.addEventListener("click", openSettingsModal);
}

function openSettingsModal() {
  const { overlay, dialog } = createModalOverlay();

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

  const body = document.createElement("div");
  body.style.padding = "10px 0";

  // Ringtone Row
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

  // Volume Row
  const rowV = document.createElement("div");
  rowV.className = "modal-row";
  const lblV = document.createElement("div");
  lblV.textContent = "Volume";
  const vol = document.createElement("input");
  vol.type = "range"; vol.min = 0; vol.max = 1; vol.step = 0.01; vol.value = talkySettings.volume;
  rowV.appendChild(lblV);
  rowV.appendChild(vol);

  body.appendChild(rowR);
  body.appendChild(rowV);

  // Test Button
  const testBtn = document.createElement("button");
  testBtn.className = "modal-menu-btn";
  testBtn.textContent = "🔊 Test Ringtone";
  testBtn.addEventListener("click", () => {
    talkySettings.ringtone = sel.value;
    talkySettings.volume = Number(vol.value);
    saveSettings();
    playRingtone();
    setTimeout(stopTone, 800);
  });
  body.appendChild(testBtn);

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const done = document.createElement("button");
  done.className = "btn btn-primary";
  done.textContent = "Save & Close";
  done.addEventListener("click", async () => {
    talkySettings.ringtone = sel.value;
    talkySettings.volume = Number(vol.value);
    saveSettings();
    await ensureNotifications();
    document.body.removeChild(overlay);
  });
  actions.appendChild(done);

  dialog.appendChild(header);
  dialog.appendChild(body);
  dialog.appendChild(actions);
  document.body.appendChild(overlay);
}

// ---------- Chat detail management UI ----------

// Consolidated Chat Settings Modal (Replaces the cluttered button row)
function openChatSettingsModal(chat) {
  const { overlay, dialog } = createModalOverlay();
  
  const header = document.createElement("div");
  header.className = "modal-header";
  const title = document.createElement("div");
  title.className = "modal-title";
  title.textContent = "Manage Chat";
  const closeBtn = document.createElement("button");
  closeBtn.className = "call-end-btn";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => document.body.removeChild(overlay));
  header.appendChild(title);
  header.appendChild(closeBtn);

  const body = document.createElement("div");
  body.style.display = "flex";
  body.style.flexDirection = "column";
  body.style.gap = "8px";
  body.style.padding = "16px 0";

  // 1. Rename
  const btnRename = document.createElement("button");
  btnRename.className = "modal-menu-btn";
  btnRename.textContent = "✏️ Rename Chat";
  btnRename.addEventListener("click", async () => {
    document.body.removeChild(overlay);
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

  // 2. Import/View Key
  const btnKey = document.createElement("button");
  btnKey.className = "modal-menu-btn";
  const hasKey = !!(chatKeyCache[chat.id] && chatKeyCache[chat.id].code);
  btnKey.textContent = hasKey ? "🔑 View Chat Key" : "📥 Import Chat Key";
  btnKey.addEventListener("click", async () => {
    document.body.removeChild(overlay);
    if (hasKey) {
      showCopyableKeyModal("Current Chat Key", chatKeyCache[chat.id].code);
    } else {
      await importKeyForChat(chat);
    }
  });

  // 3. Clear Messages
  const btnClear = document.createElement("button");
  btnClear.className = "modal-menu-btn";
  btnClear.textContent = "🧹 Clear History";
  btnClear.addEventListener("click", async () => {
    document.body.removeChild(overlay);
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

  // 4. Rotate Key
  const btnRotate = document.createElement("button");
  btnRotate.className = "modal-menu-btn";
  btnRotate.textContent = "🔄 Rotate Key (Re-create Chat)";
  btnRotate.addEventListener("click", async () => {
    document.body.removeChild(overlay);
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

  // 5. Delete Chat
  const btnDelete = document.createElement("button");
  btnDelete.className = "modal-menu-btn danger";
  btnDelete.textContent = "🗑️ Delete Chat";
  btnDelete.addEventListener("click", async () => {
    document.body.removeChild(overlay);
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

  body.appendChild(btnRename);
  body.appendChild(btnKey);
  body.appendChild(btnClear);
  body.appendChild(btnRotate);
  body.appendChild(btnDelete);

  dialog.appendChild(header);
  dialog.appendChild(body);
  document.body.appendChild(overlay);
}

// Modify renderChatDetail to use the new single "Manage" button
async function renderChatDetail(chat) {
  // Cleanup previous header-manage/delete button if present
  const existingManage = document.getElementById("btn-chat-manage");
  if (existingManage) existingManage.remove();
  
  // Remove old rows if they exist
  const oldRow = document.getElementById("chat-manage-row");
  if (oldRow) oldRow.remove();
  const oldDel = document.getElementById("btn-chat-delete");
  if (oldDel) oldDel.remove();

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

  // Add "Manage" button to header
  const manageBtn = document.createElement("button");
  manageBtn.id = "btn-chat-manage";
  manageBtn.className = "btn-pill";
  manageBtn.textContent = "Manage";
  manageBtn.style.marginLeft = "auto";
  manageBtn.addEventListener("click", () => openChatSettingsModal(chat));
  chatDetailName.parentElement.appendChild(manageBtn);

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

  // Show key status text (no inline button, use Manage menu)
  const hasKey = !!(chatKeyCache[chat.id] && chatKeyCache[chat.id].code);
  if (!hasKey) {
    chatDetailPresence.textContent += " • 🔒 Locked (no key)";
  }

  renderMessages(chat);
}

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

  if (type === "video" && (statusText.includes("Connected") || statusText.includes("In Call"))) {
    const vidContainer = document.createElement("div");
    vidContainer.className = "video-call-wrapper";
    
    const remoteVideo = document.createElement("video");
    remoteVideo.id = "remote-video";
    remoteVideo.autoplay = true;
    remoteVideo.playsInline = true;
    
    const localVideo = document.createElement("video");
    localVideo.id = "local-video";
    localVideo.autoplay = true;
    localVideo.playsInline = true;
    localVideo.muted = true;

    // Draggable logic for local video
    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    localVideo.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = localVideo.getBoundingClientRect();
      const parentRect = vidContainer.getBoundingClientRect();
      initialLeft = rect.left - parentRect.left;
      initialTop = rect.top - parentRect.top;
      localVideo.style.cursor = 'grabbing';
      localVideo.style.bottom = 'auto';
      localVideo.style.right = 'auto';
      localVideo.style.left = `${initialLeft}px`;
      localVideo.style.top = `${initialTop}px`;
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      localVideo.style.left = `${initialLeft + dx}px`;
      localVideo.style.top = `${initialTop + dy}px`;
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      if(localVideo) localVideo.style.cursor = 'grab';
    });

    // Overlay controls
    const controls = document.createElement("div");
    controls.className = "call-overlay-controls";
    
    const hangupBtn = document.createElement("button");
    hangupBtn.className = "hangup";
    hangupBtn.innerHTML = "✕";
    hangupBtn.title = "End Call";
    hangupBtn.addEventListener("click", () => {
      stopTone();
      stopWebRTC();
      closeCallOverlay();
    });
    controls.appendChild(hangupBtn);
    vidContainer.appendChild(controls);

    screen.appendChild(vidContainer);
  } else {
    const avatar = document.createElement("div");
    avatar.className = "call-avatar";
    avatar.textContent = name.slice(0, 2).toUpperCase();
    screen.appendChild(avatar);

    const nameEl = document.createElement("div");
    nameEl.className = "call-name";
    nameEl.textContent = name;
    screen.appendChild(nameEl);

    const statusEl = document.createElement("div");
    statusEl.className = "call-status";
    statusEl.textContent = statusText;
    screen.appendChild(statusEl);

    const buttonsRow = document.createElement("div");
    buttonsRow.className = "call-buttons";

    const endBtn = document.createElement("button");
    endBtn.className = "call-end-btn";
    endBtn.textContent = "✕";
    endBtn.addEventListener("click", () => {
      stopTone();
      stopWebRTC();
      closeCallOverlay();
    });

    buttonsRow.appendChild(endBtn);
    extraButtons.forEach((b) => buttonsRow.appendChild(b));
    screen.appendChild(buttonsRow);
  }

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

  // replace the click handler body to play dialing tone and stop when accepted/failed
  startBtn.addEventListener("click", async () => {
    let toUsername = usernameInput.value.trim();
    let chatId = null;

    if (!toUsername && select.value) {
      const chat = chats.find((c) => c.id === select.value);
      if (!chat) {
        await showAlert("Error", "Chat not found.");
        return;
      }
      const others = (chat.participantIds || []).filter(
        (id) => currentUser && id !== currentUser.id
      );
      if (!others.length) {
        await showAlert("Error", "This chat has no other users.");
        return;
      }
      const picked = await showPrompt(
        "Pick username",
        "This chat may include multiple users. Enter the username you want to call from this chat:"
      );
      if (!picked) return;
      toUsername = picked;
      chatId = chat.id;
    } else if (!toUsername && !select.value) {
      alert("Select a chat or type a username.");
      return;
    }

    try {
      playDialTone();
      const res = await jsonFetch("/api/calls", {
        method: "POST",
        body: JSON.stringify({ toUsername, type, chatId })
      });
      const call = res.call;
      
      const screen = buildCallScreen(toUsername, type, "Calling...");
      openCallOverlayLayout(type, "Calling", screen);

      // Poll for acceptance
      const pollAccept = setInterval(async () => {
        try {
          const cRes = await jsonFetch(`/api/calls/${call.id}`);
          if (cRes.call && cRes.call.status === "connected") {
            clearInterval(pollAccept);
            stopTone();
            const inCallScreen = buildCallScreen(toUsername, type, "Connected");
            openCallOverlayLayout(type, "In Call", inCallScreen);
            startWebRTC(true, call.id, type); // Caller starts WebRTC
          } else if (cRes.call && cRes.call.status === "ended") {
            clearInterval(pollAccept);
            stopTone();
            closeCallOverlay();
            alert("Call declined or ended.");
          }
        } catch {}
      }, 1000);

    } catch (err) {
      stopTone();
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

// Poll for incoming calls (play ringtone + show notification)
async function pollPendingCalls() {
  if (!currentUser) return;
  try {
    const res = await jsonFetch("/api/calls/pending");
    const calls = res.calls || [];
    if (!calls.length) return;
    const call = calls[0];

    // Avoid re-ringing for same call
    if (currentCallId === call.id) return;

    playRingtone();

    const acceptBtn = document.createElement("button");
    acceptBtn.className = "btn btn-primary";
    acceptBtn.textContent = "Accept";
    acceptBtn.addEventListener("click", async () => {
      stopTone();
      await jsonFetch(`/api/calls/${encodeURIComponent(call.id)}/accept`, { method: "POST" });
      const inCallScreen = buildCallScreen(`User ${call.fromUserId}`, call.type, "Connected");
      openCallOverlayLayout(call.type, "In Call", inCallScreen);
      startWebRTC(false, call.id, call.type); // Callee starts WebRTC
    });

    const declineBtn = document.createElement("button");
    declineBtn.className = "btn-pill";
    declineBtn.textContent = "Decline";
    declineBtn.addEventListener("click", async () => {
      stopTone();
      await jsonFetch(`/api/calls/${encodeURIComponent(call.id)}/decline`, { method: "POST" });
      closeCallOverlay();
    });

    const screen = buildCallScreen(`User ${call.fromUserId}`, call.type, "Incoming Call...", [acceptBtn, declineBtn]);
    // Remove the default end button from buildCallScreen for incoming view if desired, or keep it
    openCallOverlayLayout(call.type, "Incoming Call", screen);

  } catch (err) { console.error(err); }
}

// ---------- integrate settings & tone stop on overlay close ----------
callDialogClose.addEventListener("click", () => {
  stopTone();
  closeCallOverlay();
});
callOverlay.addEventListener("click", (e) => {
  if (e.target === callOverlay) {
    stopTone();
    closeCallOverlay();
  }
});

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

// Ensure we request notification permission on startup for better UX
(async () => {
  try {
    await ensureNotifications();
  } catch {}
})();

// ---------- Missing Polling Functions (Fixes "startPendingCallPolling is not defined") ----------
function startPendingCallPolling() {
  if (pendingCallPollTimer) clearInterval(pendingCallPollTimer);
  pollPendingCalls(); // run immediately
  pendingCallPollTimer = setInterval(pollPendingCalls, 3000);
}

function stopPendingCallPolling() {
  if (pendingCallPollTimer) clearInterval(pendingCallPollTimer);
  pendingCallPollTimer = null;
}

// ---------- Event Wiring & Logic ----------

function initApp() {
  // Re-query elements to be safe
  const btnNewChatRef = document.getElementById("btn-new-chat");
  const btnChatSendRef = document.getElementById("btn-chat-send");
  const chatInputRef = document.getElementById("chat-input");
  const videoCallBtnRef = document.getElementById("btn-video-call");
  const audioCallBtnRef = document.getElementById("btn-audio-call");

  if (btnNewChatRef) {
    btnNewChatRef.removeEventListener("click", openNewChatModal); // prevent duplicates
    btnNewChatRef.addEventListener("click", (e) => {
      e.preventDefault();
      openNewChatModal();
    });
  } else {
    console.warn("New Chat button not found in DOM");
  }

  if (btnChatSendRef) {
    btnChatSendRef.addEventListener("click", sendMessage);
  }

  if (chatInputRef) {
    chatInputRef.addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendMessage();
    });
  }

  if (videoCallBtnRef) {
    videoCallBtnRef.addEventListener("click", () => openCallStartDialog("video"));
  }

  if (audioCallBtnRef) {
    audioCallBtnRef.addEventListener("click", () => openCallStartDialog("audio"));
  }
}

// Run init when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || !activeChatId) return;

  const chat = chats.find((c) => c.id === activeChatId);
  if (!chat) return;

  try {
    // Encrypt
    const { ciphertext, iv } = await encryptMessageForChat(chat.id, text);
    
    // Send
    await jsonFetch("/api/messages", {
      method: "POST",
      body: JSON.stringify({ chatId: chat.id, ciphertext, iv })
    });

    chatInput.value = "";
    await loadChats(); // Refresh UI
  } catch (err) {
    console.error(err);
    await showAlert("Error", "Failed to send message: " + err.message);
  }
}

async function openNewChatModal() {
  console.log("Opening new chat modal...");
  const { overlay, dialog } = createModalOverlay();
  
  const header = document.createElement("div");
  header.className = "modal-header";
  const title = document.createElement("div");
  title.className = "modal-title";
  title.textContent = "New Chat";
  const closeBtn = document.createElement("button");
  closeBtn.className = "call-end-btn";
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => document.body.removeChild(overlay));
  header.appendChild(title);
  header.appendChild(closeBtn);

  const body = document.createElement("div");
  body.style.padding = "10px 0";
  
  // Name input
  const row1 = document.createElement("div");
  row1.className = "modal-row";
  const lbl1 = document.createElement("div"); lbl1.textContent = "Chat Name";
  const inpName = document.createElement("input"); inpName.type = "text"; inpName.placeholder = "e.g. Team Project";
  row1.appendChild(lbl1); row1.appendChild(inpName);

  // Participants input
  const row2 = document.createElement("div");
  row2.className = "modal-row";
  const lbl2 = document.createElement("div"); lbl2.textContent = "Participants (usernames or IDs, comma separated)";
  const inpPart = document.createElement("input"); inpPart.type = "text"; inpPart.placeholder = "alice, bob, u_12345";
  row2.appendChild(lbl2); row2.appendChild(inpPart);

  body.appendChild(row1);
  body.appendChild(row2);

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const createBtn = document.createElement("button");
  createBtn.className = "btn btn-primary";
  createBtn.textContent = "Create";
  
  createBtn.addEventListener("click", async () => {
    const name = inpName.value.trim();
    const rawPart = inpPart.value.trim();
    if (!name) { alert("Name required"); return; }
    if (!rawPart) { alert("Participants required"); return; }

    const participants = rawPart.split(",").map(s => s.trim()).filter(Boolean);
    
    try {
      // 1. Generate key
      const code = generateChatKeyCode();
      const keyBytes = await deriveKeyBytesFromCode(code);
      const hashHex = bytesToHex(keyBytes);

      // 2. Create chat
      const res = await jsonFetch("/api/chats", {
        method: "POST",
        body: JSON.stringify({ name, participants, encryptionKeyHash: hashHex })
      });

      // 3. Save key locally
      if (!chatKeyCache[res.chat.id]) chatKeyCache[res.chat.id] = {};
      chatKeyCache[res.chat.id].code = code;
      saveChatKeyCache();

      // 4. Close & Refresh
      document.body.removeChild(overlay);
      await loadChats();
      
      // 5. Show key
      showCopyableKeyModal("Chat Created", code);
      
    } catch (e) {
      alert(e.message);
    }
  });

  actions.appendChild(createBtn);
  dialog.appendChild(header);
  dialog.appendChild(body);
  dialog.appendChild(actions);
  document.body.appendChild(overlay);
  
  // Focus input
  setTimeout(() => inpName.focus(), 50);
}