// app.js - front-end logic talking to Node.js + GitHub-backed JSON

const chatItemsEl = document.getElementById("chat-items");
const chatSearchInput = document.getElementById("chat-search-input");
const chatDetailName = document.getElementById("chat-detail-name");
const chatDetailPresence = document.getElementById("chat-detail-presence");
const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const btnChatSend = document.getElementById("btn-chat-send");
const btnNewChat = document.getElementById("btn-new-chat");
const headerUsername = document.getElementById("header-username");

const videoCallBtn = document.getElementById("btn-video-call");
const audioCallBtn = document.getElementById("btn-audio-call");
const callOverlay = document.getElementById("call-overlay");
const callDialogBody = document.getElementById("call-dialog-body");
const callDialogTitle = document.getElementById("call-dialog-title");
const callDialogClose = document.getElementById("call-dialog-close");

let data = null;
let activeChatId = null;
let filteredChats = [];

// Simple demo username stored in localStorage
const USERNAME_KEY = "talky_demo_username";
function initUsername() {
  let name = localStorage.getItem(USERNAME_KEY);
  if (!name) {
    name = "guest-" + Math.floor(Math.random() * 1000);
    localStorage.setItem(USERNAME_KEY, name);
  }
  headerUsername.textContent = name;
  return name;
}
const currentUsername = initUsername();

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

async function loadData() {
  const json = await fetchJSON("/api/data");
  data = json;
  filteredChats = data.chats || [];
  renderChatList();
  renderChatDetail(null);
}

function renderChatList() {
  chatItemsEl.innerHTML = "";
  const q = chatSearchInput.value.trim().toLowerCase();

  filteredChats = (data.chats || []).filter((c) => {
    if (!q) return true;
    const msgs = (data.messages && data.messages[c.id]) || [];
    const lastText = msgs.length ? msgs[msgs.length - 1].text : "";
    return (
      c.name.toLowerCase().includes(q) ||
      lastText.toLowerCase().includes(q)
    );
  });

  if (!filteredChats.length) {
    const empty = document.createElement("div");
    empty.style.padding = "12px";
    empty.style.fontSize = "12px";
    empty.style.color = "#a0a0a6";
    empty.textContent = "No chats yet. Click 'New chat (demo)' to imagine creating one.";
    chatItemsEl.appendChild(empty);
    return;
  }

  filteredChats.forEach((chat) => {
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

    const lastMessages = (data.messages && data.messages[chat.id]) || [];
    const lastMessage = lastMessages.length
      ? lastMessages[lastMessages.length - 1].text
      : "";

    const msgEl = document.createElement("div");
    msgEl.className = "chat-last-message";
    msgEl.textContent = lastMessage;

    const metaEl = document.createElement("div");
    metaEl.className = "chat-meta";
    metaEl.textContent = chat.time || "";

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
    row.className = "msg-row " + (m.from === "me" ? "me" : "them");

    const bubble = document.createElement("div");
    bubble.className = "msg-bubble " + (m.from === "me" ? "me" : "them");
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
    renderMessages([]);
    return;
  }
  chatDetailName.textContent = chat.name;
  chatDetailPresence.textContent = chat.presence || "";
  const messages = (data.messages && data.messages[chat.id]) || [];
  renderMessages(messages);
}

chatSearchInput.addEventListener("input", () => {
  renderChatList();
});

btnChatSend.addEventListener("click", () => {
  sendCurrentMessage();
});

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendCurrentMessage();
  }
});

async function sendCurrentMessage() {
  if (!activeChatId) {
    alert("Select a chat first.");
    return;
  }
  const text = chatInput.value.trim();
  if (!text) return;

  try {
    await fetchJSON("/api/message", {
      method: "POST",
      body: JSON.stringify({
        chatId: activeChatId,
        from: "me",
        text
      })
    });
    chatInput.value = "";
    await loadData();
    const chat = (data.chats || []).find((c) => c.id === activeChatId);
    if (chat) renderChatDetail(chat);
  } catch (err) {
    console.error("sendCurrentMessage failed:", err);
    alert("Failed to send message. Check server logs.");
  }
}

btnNewChat.addEventListener("click", () => {
  alert(
    "In a full version, this button would let you create a brand new chat and sync it via GitHub.
For this demo, chats are seeded from the server-side JSON file."
  );
});

// ---------------- Call overlay ----------------

function openCallOverlay(type) {
  callDialogTitle.textContent =
    type === "video" ? "Start Video Call (Demo)" : "Start Audio Call (Demo)";
  renderCallScreen(type, "Demo Contact");
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
    type === "video" ? "Video calling…" : "Audio calling…";

  const typePill = document.createElement("div");
  typePill.className = "call-type-pill";
  typePill.textContent =
    type === "video" ? "Video call (mock)" : "Audio call (mock)";

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

// Init
loadData().catch((err) => {
  console.error("Failed to load data:", err);
  chatMessages.innerHTML =
    "<div style='font-size:12px;color:#b00'>Failed to load data from /api/data. Check server & GitHub config.</div>";
});
