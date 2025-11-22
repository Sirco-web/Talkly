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

// --- Audio Context ---
let audioCtx = null;
let toneNode = null;
let toneGain = null;
function playTone(freq, type = "sine", vol = 0.5) {
  if (toneNode) stopTone();
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  toneNode = audioCtx.createOscillator();
  toneGain = audioCtx.createGain();
  toneNode.type = type;
  toneNode.frequency.value = freq;
  toneGain.gain.value = vol;
  toneNode.connect(toneGain);
  toneGain.connect(audioCtx.destination);
  toneNode.start();
}
function stopTone() {
  if (toneNode) { try { toneNode.stop(); } catch{} toneNode.disconnect(); toneNode = null; }
  if (toneGain) { toneGain.disconnect(); toneGain = null; }
}

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

function CallOverlay({ call, onClose, isIncoming }) {
  const [status, setStatus] = useState(isIncoming ? "Incoming Call..." : "Calling...");
  const [connected, setConnected] = useState(false);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerRef = useRef(null);
  const pollRef = useRef(null);

  // WebRTC Setup
  const startWebRTC = useCallback(async (isCaller) => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    peerRef.current = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) jsonFetch(`/api/calls/${call.id}/signal`, { method: 'POST', body: JSON.stringify({ type: 'candidate', data: e.candidate }) });
    };
    pc.ontrack = (e) => {
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = e.streams[0];
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: call.type === 'video' });
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        localVideoRef.current.muted = true;
      }
      stream.getTracks().forEach(t => pc.addTrack(t, stream));

      if (isCaller) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await jsonFetch(`/api/calls/${call.id}/signal`, { method: 'POST', body: JSON.stringify({ type: 'offer', data: offer }) });
      }
    } catch (e) {
      console.error(e);
      alert("Media access failed");
    }
  }, [call]);

  // Polling for signals
  useEffect(() => {
    if (!connected) return;
    let lastTs = Date.now();
    const interval = setInterval(async () => {
      try {
        const res = await jsonFetch(`/api/calls/${call.id}/signal?since=${lastTs}`);
        if (res.signals) {
          for (const sig of res.signals) {
            lastTs = Math.max(lastTs, sig.ts);
            const pc = peerRef.current;
            if (!pc) continue;
            if (sig.type === 'offer') {
              await pc.setRemoteDescription(new RTCSessionDescription(sig.data));
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              await jsonFetch(`/api/calls/${call.id}/signal`, { method: 'POST', body: JSON.stringify({ type: 'answer', data: answer }) });
            } else if (sig.type === 'answer') {
              await pc.setRemoteDescription(new RTCSessionDescription(sig.data));
            } else if (sig.type === 'candidate') {
              await pc.addIceCandidate(new RTCIceCandidate(sig.data));
            }
          }
        }
      } catch {}
    }, 1000);
    return () => clearInterval(interval);
  }, [connected, call.id]);

  // Initial Call Logic
  useEffect(() => {
    if (isIncoming) {
      playTone(880, 'triangle'); // Ringtone
    } else {
      playTone(425, 'sine'); // Dial tone
      // Poll for acceptance
      pollRef.current = setInterval(async () => {
        try {
          const res = await jsonFetch(`/api/calls/${call.id}`);
          if (res.call.status === 'connected') {
            clearInterval(pollRef.current);
            stopTone();
            setStatus("Connected");
            setConnected(true);
            startWebRTC(true);
          } else if (res.call.status === 'ended') {
            clearInterval(pollRef.current);
            stopTone();
            onClose();
            alert("Call ended");
          }
        } catch {}
      }, 1000);
    }
    return () => {
      stopTone();
      if (pollRef.current) clearInterval(pollRef.current);
      if (peerRef.current) peerRef.current.close();
    };
  }, []);

  const handleAccept = async () => {
    stopTone();
    await jsonFetch(`/api/calls/${call.id}/accept`, { method: 'POST' });
    setStatus("Connected");
    setConnected(true);
    startWebRTC(false);
  };

  const handleHangup = async () => {
    stopTone();
    if (isIncoming && !connected) {
      await jsonFetch(`/api/calls/${call.id}/decline`, { method: 'POST' });
    }
    // Clean up local stream
    if (localVideoRef.current && localVideoRef.current.srcObject) {
      localVideoRef.current.srcObject.getTracks().forEach(t => t.stop());
    }
    onClose();
  };

  // Draggable Video Logic
  const dragRef = useRef({ isDragging: false, startX: 0, startY: 0, initialLeft: 0, initialTop: 0 });
  const handleMouseDown = (e) => {
    const vid = localVideoRef.current;
    if (!vid) return;
    dragRef.current.isDragging = true;
    dragRef.current.startX = e.clientX;
    dragRef.current.startY = e.clientY;
    const rect = vid.getBoundingClientRect();
    const parent = vid.parentElement.getBoundingClientRect();
    dragRef.current.initialLeft = rect.left - parent.left;
    dragRef.current.initialTop = rect.top - parent.top;
    vid.style.cursor = 'grabbing';
    vid.style.bottom = 'auto'; vid.style.right = 'auto';
    vid.style.left = dragRef.current.initialLeft + 'px';
    vid.style.top = dragRef.current.initialTop + 'px';
  };
  const handleMouseMove = (e) => {
    if (!dragRef.current.isDragging) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    if (localVideoRef.current) {
      localVideoRef.current.style.left = (dragRef.current.initialLeft + dx) + 'px';
      localVideoRef.current.style.top = (dragRef.current.initialTop + dy) + 'px';
    }
  };
  const handleMouseUp = () => {
    dragRef.current.isDragging = false;
    if (localVideoRef.current) localVideoRef.current.style.cursor = 'grab';
  };

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  return (
    <div id="call-overlay">
      <div className="call-dialog" style={connected && call.type === 'video' ? { width: '100%', maxWidth: '800px', background: 'transparent', boxShadow: 'none' } : {}}>
        {!connected || call.type !== 'video' ? (
          <div className="call-dialog-body">
            <div className="call-screen">
              <div className="call-avatar">U</div>
              <div className="call-name">User {call.toUserId === call.fromUserId ? '...' : (isIncoming ? call.fromUserId : call.toUserId)}</div>
              <div className="call-status">{status}</div>
              <div className="call-buttons">
                {isIncoming && !connected && <button className="btn btn-primary" onClick={handleAccept}>Accept</button>}
                <button className="call-end-btn" onClick={handleHangup}>✕</button>
              </div>
            </div>
          </div>
        ) : (
          <div className="video-call-wrapper">
            <video id="remote-video" ref={remoteVideoRef} autoPlay playsInline />
            <video id="local-video" ref={localVideoRef} autoPlay playsInline muted onMouseDown={handleMouseDown} />
            <div className="call-overlay-controls">
              <button className="hangup" onClick={handleHangup}>✕</button>
            </div>
          </div>
        )}
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
  const [activeCall, setActiveCall] = useState(null); // { id, type, isIncoming }
  const [modals, setModals] = useState({ settings: false, newChat: false, admin: false, manageChat: null });
  const [inputText, setInputText] = useState("");

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

  // Polling for Calls
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(async () => {
      try {
        const res = await jsonFetch('/api/calls/pending');
        if (res.calls && res.calls.length > 0 && !activeCall) {
          setActiveCall({ ...res.calls[0], isIncoming: true });
        }
      } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, [user, activeCall]);

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

  const handleSendMessage = async () => {
    if (!inputText.trim() || !activeChatId) return;
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
      const ciphertextBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(inputText));
      
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
    useEffect(() => { decryptMessage(chatId, msg).then(setText); }, [msg, chatId, chatKeys]);
    const isMe = msg.fromUserId === user.id;
    return (
      <div className={`msg-row ${isMe ? 'me' : 'them'}`}>
        <div className={`msg-bubble ${isMe ? 'me' : 'them'}`}>{text}</div>
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

      {/* Call Strip */}
      <div className="call-strip">
        <button className="call-button video" onClick={() => {
          const target = prompt("Enter username to call:");
          if (target) setActiveCall({ id: 'pending', type: 'video', toUserId: target, isIncoming: false });
        }}>
          <div className="icon-badge">🎥</div>
          <span className="label"><span className="label-main">Video call</span></span>
        </button>
        <button className="call-button audio" onClick={() => {
           const target = prompt("Enter username to call:");
           if (target) setActiveCall({ id: 'pending', type: 'audio', toUserId: target, isIncoming: false });
        }}>
          <div className="icon-badge">📞</div>
          <span className="label"><span className="label-main">Audio call</span></span>
        </button>
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
            <input value={inputText} onChange={e => setInputText(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSendMessage()} placeholder="Message" />
            <button onClick={handleSendMessage}>Send</button>
          </div>
        </div>
      </div>

      {/* Modals */}
      {activeCall && (
        <CallOverlay 
          call={activeCall.id === 'pending' ? { id: 'temp', ...activeCall } : activeCall} 
          isIncoming={activeCall.isIncoming} 
          onClose={() => setActiveCall(null)} 
        />
      )}

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