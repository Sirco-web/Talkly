// app.js - Talky front-end

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

let currentUser = null;
let chats = [];
let messagesByChat = {};
let activeChatId = null;

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

async function refreshMe() {
  try {
    const res = await jsonFetch("/api/me");
    currentUser = res.user;
    if (currentUser) {
      headerUsername.textContent = currentUser.username;
      headerUserId.textContent = `ID: ${currentUser.id}`;
      hide(authScreen);
      show(mainScreen);
      await loadChats();
    } else {
      show(authScreen);
      hide(mainScreen);
    }
  } catch (err) {
    console.error("Failed to refresh /api/me:", err);
    show(authScreen);
    hide(mainScreen);
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
  show(authScreen);
  hide(mainScreen);
});

async function loadChats() {
  if (!currentUser) return;
  try {
    const res = await jsonFetch("/api/chats");
    chats = res.chats || [];
    messagesByChat = res.messagesByChat || {};
    renderChatList();
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
    const msgs = messagesByChat[c.id] || [];
    const lastText = msgs.length ? msgs[msgs.length - 1].text : "";
    return (
      c.name.toLowerCase().includes(q) ||
      lastText.toLowerCase().includes(q)
    );
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

    const msgs = messagesByChat[chat.id] || [];
    const lastMessage = msgs.length ? msgs[msgs.length - 1].text : "";

    const msgEl = document.createElement("div");
    msgEl.className = "chat-last-message";
    msgEl.textContent = lastMessage;

    const metaEl = document.createElement("div");
    metaEl.className = "chat-meta";
    metaEl.textContent = msgs.length
      ? new Date(msgs[msgs.length - 1].ts).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit"
        })
      : "";

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

function renderMessages(messages) {
  chatMessages.innerHTML = "";
  if (!messages || !messages.length) {
    const info = document.createElement("div");
    info.style.fontSize = "12px";
    info.style.color = "#777";
    info.textContent = "Pick a chat on the left to see the conversation here.";
    chatMessages.appendChild(info);
    return;
  }

  messages.forEach((m) => {
    const row = document.createElement("div");
    const isMe = currentUser && m.fromUserId === currentUser.id;
    row.className = "msg-row " + (isMe ? "me" : "them");

    const bubble = document.createElement("div");
    bubble.className = "msg-bubble " + (isMe ? "me" : "them");
    bubble.textContent = m.text;

    row.appendChild(bubble);
    chatMessages.appendChild(row);
  });

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function renderChatDetail(chat) {
  if (!chat) {
    chatDetailName.textContent = "Select a chat";
    chatDetailPresence.textContent = "No conversation selected.";
    chatCallTarget.textContent = "Talky ID will show here";
    renderMessages([]);
    return;
  }
  chatDetailName.textContent = chat.name;
  chatDetailPresence.textContent = "Talky chat owned by your ID.";
  chatCallTarget.textContent = `Your Talky ID: ${currentUser ? currentUser.id : "?"}`;
  const messages = messagesByChat[chat.id] || [];
  renderMessages(messages);
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

  try {
    const res = await jsonFetch("/api/messages", {
      method: "POST",
      body: JSON.stringify({ chatId: activeChatId, text })
    });
    const msg = res.message;
    if (!messagesByChat[activeChatId]) messagesByChat[activeChatId] = [];
    messagesByChat[activeChatId].push(msg);
    chatInput.value = "";
    renderChatList();
    const chat = chats.find((c) => c.id === activeChatId);
    if (chat) renderChatDetail(chat);
  } catch (err) {
    console.error("Failed to send message:", err);
    alert(err.message || "Failed to send message.");
  }
}

btnNewChat.addEventListener("click", async () => {
  const name = prompt("Chat name:");
  if (!name) return;
  try {
    const res = await jsonFetch("/api/chats", {
      method: "POST",
      body: JSON.stringify({ name })
    });
    chats.push(res.chat);
    messagesByChat[res.chat.id] = [];
    activeChatId = res.chat.id;
    renderChatList();
    renderChatDetail(res.chat);
  } catch (err) {
    console.error("Failed to create chat:", err);
    alert(err.message || "Failed to create chat.");
  }
});

function openCallOverlay(type) {
  if (!currentUser) {
    alert("Log in first.");
    return;
  }
  const chat = chats.find((c) => c.id === activeChatId);
  let targetName = chat ? chat.name : "Talky contact";
  callDialogTitle.textContent =
    type === "video" ? "Video Call" : "Audio Call";
  renderCallScreen(type, targetName);
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

videoCallBtn.addEventListener("click", () => openCallOverlay("video"));
audioCallBtn.addEventListener("click", () => openCallOverlay("audio"));

function renderCallScreen(type, name) {
  callDialogBody.innerHTML = "";

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
  statusEl.textContent =
    type === "video" ? "Video calling using Talky IDs…" : "Audio calling using Talky IDs…";

  const typePill = document.createElement("div");
  typePill.className = "call-type-pill";
  typePill.textContent =
    type === "video" ? "Video call (layout demo)" : "Audio call (layout demo)";

  const buttonsRow = document.createElement("div");
  buttonsRow.className = "call-buttons";

  const endBtn = document.createElement("button");
  endBtn.className = "call-end-btn";
  endBtn.textContent = "✕";
  endBtn.addEventListener("click", closeCallOverlay);

  buttonsRow.appendChild(endBtn);

  screen.appendChild(avatar);
  screen.appendChild(nameEl);
  screen.appendChild(statusEl);
  screen.appendChild(typePill);
  screen.appendChild(buttonsRow);

  callDialogBody.appendChild(screen);
}

let isAdminOpen = false;

document.addEventListener("keydown", async (e) => {
  const onLoginScreen = !authScreen.classList.contains("hidden") &&
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
        if (!confirm(`Delete user ${u.username}? This removes their chats/messages.`)) {
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

switchAuthTab("login");
refreshMe();
