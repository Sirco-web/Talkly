// app.js - Talky front-end (GitHub-backed, encrypted chats, call signaling)

const { useState, useEffect, useRef, useMemo, useCallback } = React;

// --- Utilities & Crypto ---
async function jsonFetch(url, options = {}) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, credentials: "same-origin", ...options });
  let data; try { data = await res.json(); } catch { data = null; }
  if (!res.ok) { const msg = (data && data.error) || `Request failed (${res.status})`; throw new Error(msg); }
  return data;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
function bufToBase64(buf) {
  let binary = ""; const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function base64ToBuf(b64) {
  const binary = atob(b64); const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
async function deriveKeyBytesFromCode(code) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(code));
  return new Uint8Array(digest);
}
async function getAesKeyFromCode(code) {
  const keyBytes = await deriveKeyBytesFromCode(code);
  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
function generateChatKeyCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const emojis = ["😀", "😎", "✨", "🔥", "🌙", "⭐", "🎧", "📞", "💬", "🔒"];
  const randChars = (len) => Array(len).fill(0).map(() => letters[Math.floor(Math.random() * letters.length)]).join("");
  return `${randChars(4)}-${randChars(4)}-${randChars(4)}-${randChars(4)} ${emojis[Math.floor(Math.random()*emojis.length)]}${emojis[Math.floor(Math.random()*emojis.length)]}`;
}
function bytesToHex(bytes) { return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(""); }

// --- Components ---

function Modal({ title, onClose, children }) {
  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-dialog">
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          <button className="call-end-btn" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function AuthScreen({ onLogin }) {
  const [tab, setTab] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const saved = localStorage.getItem("talky_remember_username");
    if (saved) {
      try {
        const p = JSON.parse(saved);
        if (p.username) setUsername(p.username);
      } catch {}
    }
  }, []);

  const handleSubmit = async () => {
    if (!username || !password) return setError("Fill all fields");
    setError("");
    try {
      const endpoint = tab === 'login' ? '/api/auth/login' : '/api/auth/signup';
      const res = await jsonFetch(endpoint, { method: 'POST', body: JSON.stringify({ username, password }) });
      localStorage.setItem("talky_remember_username", JSON.stringify({ username, remember: true }));
      onLogin(res.user);
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div id="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">
          <div className="auth-logo-mark">T</div>
          <div className="auth-logo-title">Talky</div>
          <div className="auth-logo-sub">Secure calling & messaging</div>
        </div>
        <div className="auth-tabs">
          <div className={`auth-tab ${tab==='login'?'active':''}`} onClick={()=>setTab('login')}>Log In</div>
          <div className={`auth-tab ${tab==='signup'?'active':''}`} onClick={()=>setTab('signup')}>Sign Up</div>
        </div>
        <div className="auth-panel">
          <div className="field-row">
            <div className="field-label">Username</div>
            <input className="field-input" value={username} onChange={e=>setUsername(e.target.value)} />
          </div>
          <div className="field-row">
            <div className="field-label">Password</div>
            <input className="field-input" type="password" value={password} onChange={e=>setPassword(e.target.value)} />
          </div>
          <button className="btn-primary" onClick={handleSubmit}>{tab==='login'?'Log In':'Create Account'}</button>
          <div className="auth-error">{error}</div>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [chats, setChats] = useState([]);
  const [messages, setMessages] = useState({});
  const [activeChatId, setActiveChatId] = useState(null);
  const [chatKeys, setChatKeys] = useState({});
  const [modals, setModals] = useState({ settings: false, newChat: false, admin: false, manageChat: null });
  const [inputText, setInputText] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  // Load Keys
  useEffect(() => {
    try {
      const raw = localStorage.getItem("talky_chat_keys");
      if (raw) setChatKeys(JSON.parse(raw));
    } catch {}
  }, []);
  const saveKeys = (newKeys) => {
    setChatKeys(newKeys);
    localStorage.setItem("talky_chat_keys", JSON.stringify(newKeys));
  };

  // Initial Load
  useEffect(() => {
    jsonFetch('/api/me').then(res => {
      if (res.user) {
        setUser(res.user);
        loadChats();
      }
    });
  }, []);

  // Polling for Messages (Fast polling 1s)
  useEffect(() => {
    if (!user) return;
    const pollMessages = async () => {
      try {
        const res = await jsonFetch('/api/chats');
        if (res.chats) {
          setChats(prev => JSON.stringify(prev) === JSON.stringify(res.chats) ? prev : res.chats);
          setMessages(prev => JSON.stringify(prev) === JSON.stringify(res.messagesByChat) ? prev : res.messagesByChat || {});
        }
      } catch (e) { console.error(e); }
    };
    pollMessages();
    const interval = setInterval(pollMessages, 1000);
    return () => clearInterval(interval);
  }, [user]);

  // Admin Shortcut
  useEffect(() => {
    const handler = (e) => {
      if (e.key.toLowerCase() === 'z' && e.ctrlKey && e.altKey && e.shiftKey) {
        e.preventDefault();
        const pass = prompt("Admin Password:");
        if (pass) jsonFetch('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: pass }) })
          .then(() => setModals(m => ({ ...m, admin: true })))
          .catch(e => alert(e.message));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const loadChats = async () => {
    try {
      const res = await jsonFetch('/api/chats');
      setChats(res.chats || []);
      setMessages(res.messagesByChat || {});
    } catch (e) { console.error(e); }
  };

  const handleSendMessage = async (content = inputText) => {
    if (!content.trim() || !activeChatId) return;
    const chat = chats.find(c => c.id === activeChatId);
    if (!chat) return;
    
    const keyEntry = chatKeys[chat.id];
    if (!keyEntry || !keyEntry.code) {
      alert("No key for this chat. Import or create one.");
      return;
    }

    try {
      const key = await getAesKeyFromCode(keyEntry.code);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertextBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(content));
      
      await jsonFetch('/api/messages', {
        method: 'POST',
        body: JSON.stringify({
          chatId: chat.id,
          ciphertext: bufToBase64(ciphertextBuf),
          iv: bufToBase64(iv.buffer)
        })
      });
      setInputText("");
      loadChats();
    } catch (e) {
      alert("Send failed: " + e.message);
    }
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    // Limit check (GitHub API limit is ~100MB, express limit 50MB)
    if (file.size > 45 * 1024 * 1024) { 
      alert("File too large (max 45MB)");
      return;
    }

    if (!activeChatId) return;
    const chat = chats.find(c => c.id === activeChatId);
    if (!chat) return;
    const keyEntry = chatKeys[chat.id];
    if (!keyEntry || !keyEntry.code) {
      alert("No key for this chat.");
      return;
    }

    setUploading(true);
    try {
      // 1. Read File
      const arrayBuffer = await file.arrayBuffer();
      
      // 2. Encrypt File
      const key = await getAesKeyFromCode(keyEntry.code);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encryptedBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, arrayBuffer);
      
      // 3. Convert to Base64 for upload
      const encryptedBase64 = bufToBase64(encryptedBuffer);
      const ext = "." + (file.name.split('.').pop() || "dat");

      // 4. Upload
      const res = await jsonFetch('/api/upload', {
        method: 'POST',
        body: JSON.stringify({ content: encryptedBase64, ext })
      });

      // 5. Send Message with Link
      // Format: FILE:<path>:<iv_base64>:<mime_type>:<original_name>
      const fileMsg = `FILE:${res.path}:${bufToBase64(iv.buffer)}:${file.type}:${file.name}`;
      
      // Encrypt the message text itself (which contains the link)
      const msgIv = crypto.getRandomValues(new Uint8Array(12));
      const msgCipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: msgIv }, key, enc.encode(fileMsg));

      await jsonFetch('/api/messages', {
        method: 'POST',
        body: JSON.stringify({
          chatId: chat.id,
          ciphertext: bufToBase64(msgCipher),
          iv: bufToBase64(msgIv.buffer)
        })
      });
      
      loadChats();
    } catch (e) {
      alert("Upload failed: " + e.message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const decryptMessage = async (chatId, msg) => {
    const keyEntry = chatKeys[chatId];
    if (!keyEntry) return "🔒 Encrypted";
    try {
      const key = await getAesKeyFromCode(keyEntry.code);
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(base64ToBuf(msg.iv)) },
        key,
        base64ToBuf(msg.ciphertext)
      );
      return dec.decode(plain);
    } catch { return "🔒 Decrypt Failed"; }
  };

  // Sub-components for rendering
  const ChatMessage = ({ msg, chatId }) => {
    const [text, setText] = useState("...");
    const [fileUrl, setFileUrl] = useState(null);
    const [isImage, setIsImage] = useState(false);
    const [fileName, setFileName] = useState("");

    useEffect(() => { 
      decryptMessage(chatId, msg).then(async (decrypted) => {
        if (decrypted.startsWith("FILE:")) {
          // FILE:<path>:<iv>:<mime>:<name>
          const parts = decrypted.split(":");
          if (parts.length >= 5) {
            const path = parts[1];
            const ivB64 = parts[2];
            const mime = parts[3];
            const name = parts.slice(4).join(":");
            
            setFileName(name);
            setText("Loading file...");
            
            try {
              // Fetch encrypted file
              const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
              if (!res.ok) throw new Error("Fetch failed");
              const encryptedBlob = await res.arrayBuffer();
              
              // Decrypt
              const keyEntry = chatKeys[chatId];
              const key = await getAesKeyFromCode(keyEntry.code);
              const plainBuffer = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: new Uint8Array(base64ToBuf(ivB64)) },
                key,
                encryptedBlob
              );
              
              const blob = new Blob([plainBuffer], { type: mime });
              const url = URL.createObjectURL(blob);
              setFileUrl(url);
              if (mime.startsWith("image/")) setIsImage(true);
              setText("");
            } catch (e) {
              setText("Error loading file");
            }
          } else {
            setText(decrypted);
          }
        } else {
          setText(decrypted);
        }
      }); 
    }, [msg, chatId, chatKeys]);

    const isMe = msg.fromUserId === user.id;

    return (
      <div className={`msg-row ${isMe ? 'me' : 'them'}`}>
        <div className={`msg-bubble ${isMe ? 'me' : 'them'}`}>
          {fileUrl ? (
            isImage ? (
              <img src={fileUrl} alt={fileName} className="msg-image" />
            ) : (
              <a href={fileUrl} download={fileName} style={{color: isMe?'white':'black', textDecoration:'underline'}}>
                📎 {fileName}
              </a>
            )
          ) : (
            text
          )}
        </div>
      </div>
    );
  };

  if (!user) return <AuthScreen onLogin={(u) => { setUser(u); loadChats(); }} />;

  const activeChat = chats.find(c => c.id === activeChatId);
  const activeMsgs = activeChatId ? (messages[activeChatId] || []) : [];

  return (
    <div id="main-screen">
      {/* Top Bar */}
      <div className="top-bar">
        <div className="top-left">
          <div className="top-app-name">Talky</div>
          <div className="top-app-sub">React Frontend</div>
        </div>
        <div className="top-right">
          <div className="user-pill">
            <div className="user-pill-main">{user.username}</div>
            <div className="user-pill-sub">ID: {user.id}</div>
          </div>
          <button className="btn-pill" onClick={() => setModals({ ...modals, settings: true })}>⚙️</button>
          <button id="btn-logout" onClick={() => { jsonFetch('/api/auth/logout', { method: 'POST' }); setUser(null); }}>Log Out</button>
        </div>
      </div>

      {/* App Shell */}
      <div className="app-shell">
        <div className="panel panel-left">
          <div className="panel-header">
            <div className="panel-header-title">Chats</div>
            <button className="btn-pill" onClick={() => setModals({ ...modals, newChat: true })}>New Chat</button>
          </div>
          <div className="chat-search"><input placeholder="Search chats" /></div>
          <div id="chat-items">
            {chats.map(chat => (
              <div key={chat.id} className={`chat-item ${activeChatId === chat.id ? 'active' : ''}`} onClick={() => setActiveChatId(chat.id)}>
                <div className="chat-avatar">{chat.name.slice(0, 2).toUpperCase()}</div>
                <div className="chat-text">
                  <div className="chat-name">{chat.name}</div>
                  <div className="chat-last-message">Click to view</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel panel-right">
          <div className="chat-detail-header">
            <div className="chat-detail-name">{activeChat ? activeChat.name : "Select a chat"}</div>
            {activeChat && (
              <button className="btn-pill" style={{ marginLeft: 'auto' }} onClick={() => setModals({ ...modals, manageChat: activeChat })}>Manage</button>
            )}
          </div>
          <div id="chat-messages">
            {activeMsgs.map(m => <ChatMessage key={m.id} msg={m} chatId={activeChatId} />)}
          </div>
          <div className="chat-input-row">
            <input type="file" ref={fileInputRef} style={{display:'none'}} onChange={handleFileUpload} />
            <button className="btn-icon" onClick={() => fileInputRef.current.click()} disabled={uploading}>
              {uploading ? "⏳" : "📎"}
            </button>
            <input id="chat-input" value={inputText} onChange={e => setInputText(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSendMessage()} placeholder="Message" />
            <button id="btn-chat-send" onClick={() => handleSendMessage()}>Send</button>
          </div>
        </div>
      </div>

      {/* Modals */}
      {modals.newChat && (
        <Modal title="New Chat" onClose={() => setModals({ ...modals, newChat: false })}>
          <div className="modal-row">
            <div>Chat Name</div>
            <input id="new-chat-name" placeholder="Team Project" />
          </div>
          <div className="modal-row">
            <div>Participants (usernames, comma sep)</div>
            <input id="new-chat-parts" placeholder="alice, bob" />
          </div>
          <div className="modal-actions">
            <button className="btn-primary" onClick={async () => {
              const name = document.getElementById('new-chat-name').value;
              const parts = document.getElementById('new-chat-parts').value.split(',').map(s => s.trim()).filter(Boolean);
              if (!name || !parts.length) return alert("Fields required");
              const code = generateChatKeyCode();
              const hash = bytesToHex(await deriveKeyBytesFromCode(code));
              try {
                const res = await jsonFetch('/api/chats', { method: 'POST', body: JSON.stringify({ name, participants: parts, encryptionKeyHash: hash }) });
                saveKeys({ ...chatKeys, [res.chat.id]: { code } });
                setModals({ ...modals, newChat: false });
                loadChats();
                alert(`Chat created! Key: ${code}`);
              } catch (e) { alert(e.message); }
            }}>Create</button>
          </div>
        </Modal>
      )}

      {modals.manageChat && (
        <Modal title={`Manage ${modals.manageChat.name}`} onClose={() => setModals({ ...modals, manageChat: null })}>
          <button className="modal-menu-btn" onClick={async () => {
             const newName = prompt("New Name:");
             if (newName) {
               await jsonFetch(`/api/chats/${modals.manageChat.id}/rename`, { method: 'POST', body: JSON.stringify({ name: newName }) });
               loadChats(); setModals({ ...modals, manageChat: null });
             }
          }}>✏️ Rename Chat</button>
          <button className="modal-menu-btn" onClick={() => {
             const code = chatKeys[modals.manageChat.id]?.code;
             if (code) prompt("Copy Key:", code);
             else {
               const input = prompt("Enter Key:");
               if (input) {
                 saveKeys({ ...chatKeys, [modals.manageChat.id]: { code: input } });
                 alert("Key saved");
               }
             }
          }}>🔑 View/Import Key</button>
          <button className="modal-menu-btn danger" onClick={async () => {
             if (confirm("Delete chat?")) {
               await jsonFetch(`/api/chats/${modals.manageChat.id}`, { method: 'DELETE' });
               setActiveChatId(null); loadChats(); setModals({ ...modals, manageChat: null });
             }
          }}>🗑️ Delete Chat</button>
        </Modal>
      )}
      
      {modals.settings && (
        <Modal title="Settings" onClose={() => setModals({ ...modals, settings: false })}>
           <div className="modal-row"><div>Volume</div><input type="range" min="0" max="1" step="0.1" /></div>
           <div className="modal-actions"><button className="btn-primary" onClick={() => setModals({ ...modals, settings: false })}>Save</button></div>
        </Modal>
      )}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);