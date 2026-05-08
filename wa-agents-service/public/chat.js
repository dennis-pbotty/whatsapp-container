// ---------- service info / banner color ----------
const TAG_COLORS = [
  { id: 'green',  bg: '#166534', text: '#dcfce7' },
  { id: 'red',    bg: '#991b1b', text: '#fee2e2' },
  { id: 'blue',   bg: '#1e40af', text: '#dbeafe' },
  { id: 'purple', bg: '#581c87', text: '#f3e8ff' },
  { id: 'orange', bg: '#9a3412', text: '#ffedd5' },
  { id: 'teal',   bg: '#115e59', text: '#ccfbf1' },
  { id: 'gold',   bg: '#854d0e', text: '#fef9c3' },
  { id: 'pink',   bg: '#9d174d', text: '#fce7f3' },
  { id: 'indigo', bg: '#312e81', text: '#e0e7ff' },
  { id: 'slate',  bg: '#334155', text: '#e2e8f0' },
];

async function initServiceInfo() {
  try {
    const res = await fetch('/api/info');
    const info = await res.json();
    if (info.label) document.title = info.label + ' — Chat';
    const banner = document.getElementById('service-banner');
    if (!banner) return;
    banner.textContent = info.label ? info.label.toUpperCase() : '';
    if (info.color) {
      const c = TAG_COLORS.find(x => x.id === info.color);
      if (c) {
        banner.style.background = c.bg;
        banner.style.color = c.text;
        banner.style.borderBottomColor = 'transparent';
      }
    }
  } catch (_) {}
}

// ---------- state ----------
let token = null;
let currentChat = null;
let allChats = [];
let lidMap = {};        // "@lid JID" -> "@s.whatsapp.net JID"
let contactsMap = {};   // phone digits -> display name
let chatKindFilter = '';
let threadSearchMode = false;
let threadSearchQuery = '';
let canSend = false;
let composeDraftId = null;

const MSG_PAGE = 100;

// ---------- theme ----------
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('theme-toggle').textContent = theme === 'dark' ? '☀' : '🌙';
  localStorage.setItem('wa-chat-theme', theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

// ---------- boot ----------
async function init() {
  const saved = localStorage.getItem('wa-chat-theme') || 'dark';
  applyTheme(saved);
  await initServiceInfo();

  token = await fetchToken();
  if (!token) { showToast('No active tokens found. Create one in the dashboard first.'); return; }

  const caps = await fetchCapabilities();
  canSend = !!caps.send;

  await loadLidMap();
  await loadContacts();
  await loadChats();
}

async function fetchToken() {
  try {
    const res = await fetch('/api/tokens');
    const data = await res.json();
    const active = (data.tokens || []).filter(t => t.active);
    return active.length ? active[0].token : null;
  } catch (_) { return null; }
}

async function fetchCapabilities() {
  try {
    const res = await fetch('/api/capabilities');
    return await res.json();
  } catch (_) { return { send: false }; }
}

async function loadLidMap() {
  try {
    const res = await fetch('/api/db/lid-map', { headers: { Authorization: 'Bearer ' + token } });
    if (res.ok) lidMap = await res.json();
  } catch (_) {}
}

async function loadContacts() {
  try {
    const res = await fetch('/api/db/contacts?limit=5000', { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return;
    const data = await res.json();
    contactsMap = {};
    for (const c of (data.contacts || [])) {
      const name = c.full_name || c.push_name || c.first_name || c.business_name;
      if (name && c.phone) contactsMap[c.phone] = name;
    }
  } catch (_) {}
}

// ---------- chat list ----------
async function loadChats() {
  try {
    const res = await fetch('/api/db/chats?limit=500', {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (res.status === 503) { showToast('WhatsApp DB not ready. Pair the device first.'); return; }
    const data = await res.json();
    allChats = mergeChats(data.chats || []);
    renderChatList();
  } catch (e) { showToast('Failed to load chats: ' + e.message); }
}

// Merge LID chats into their phone-JID counterpart using the lid_map.
// A merged chat carries `allJids: [jid1, jid2]` for multi-JID message loading.
function mergeChats(chats) {
  const byJid = Object.fromEntries(chats.map(c => [c.jid, c]));
  const absorbed = new Set();

  for (const [lidJid, phoneJid] of Object.entries(lidMap)) {
    const lidChat   = byJid[lidJid];
    const phoneChat = byJid[phoneJid];
    if (!lidChat) continue;
    if (phoneChat) {
      // Merge: keep phone chat, absorb LID chat into it
      phoneChat.msgs = (phoneChat.msgs || 0) + (lidChat.msgs || 0);
      phoneChat.last_message_ts = Math.max(phoneChat.last_message_ts || 0, lidChat.last_message_ts || 0);
      phoneChat.allJids = [phoneJid, lidJid];
      absorbed.add(lidJid);
    } else {
      // No phone-JID chat: resolve display name from contacts map, then phone number
      // (wacli stores the bot's own sender_name as the chat name for outgoing-only chats)
      const phone = phoneJid.replace(/@s\.whatsapp\.net$/, '');
      lidChat.displayName = contactsMap[phone] || phone;
      lidChat.resolvedPhone = phone;
      lidChat.allJids = [lidJid, phoneJid];
    }
  }

  return chats
    .filter(c => !absorbed.has(c.jid))
    .map(c => {
      const base = { ...c, allJids: c.allJids || [c.jid] };
      if (base.displayName) return base; // already resolved
      // For DM phone-JID chats: enrich name from contacts map
      const phone = base.jid.replace(/@s\.whatsapp\.net$/, '');
      if (base.jid.endsWith('@s.whatsapp.net') && contactsMap[phone]) {
        base.displayName = contactsMap[phone];
      }
      return base;
    });
}

function renderChatList() {
  const q = document.getElementById('chat-search').value.trim().toLowerCase();
  const filtered = allChats.filter(c => {
    if (chatKindFilter && c.kind !== chatKindFilter) return false;
    if (q && !((c.displayName || c.name || c.jid || '').toLowerCase().includes(q))) return false;
    return true;
  });

  const ul = document.getElementById('chat-list');
  ul.innerHTML = '';
  for (const chat of filtered) {
    const li = document.createElement('li');
    li.className = 'chat-item' + (currentChat && chat.jid === currentChat.jid ? ' active' : '');
    li.dataset.jid = chat.jid;
    const isGroup = chat.kind === 'group';
    const chatDisplayName = chat.displayName || chat.name || chat.jid;
    li.innerHTML = `
      <div class="chat-avatar ${isGroup ? 'group' : ''}">${esc(nameInitials(chatDisplayName))}</div>
      <div class="chat-info">
        <div class="chat-name">${esc(chatDisplayName)}</div>
        <div class="chat-meta">${esc(fmtChatTime(chat.last_message_ts))}</div>
      </div>
      ${chat.msgs ? `<span class="chat-count">${chat.msgs}</span>` : ''}
    `;
    li.addEventListener('click', () => openChat(chat));
    ul.appendChild(li);
  }
}

// ---------- open chat ----------
async function openChat(chat) {
  currentChat = chat;
  threadSearchMode = false;
  threadSearchQuery = '';
  composeDraftId = null;

  document.querySelectorAll('.chat-item').forEach(el =>
    el.classList.toggle('active', el.dataset.jid === chat.jid)
  );

  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('thread-panel').style.display = 'flex';

  document.getElementById('thread-title').textContent = chat.displayName || chat.name || chat.jid;
  document.getElementById('thread-meta').textContent =
    (chat.kind === 'group' ? 'Group' : 'DM') + (chat.msgs ? ` · ${chat.msgs} messages` : '');
  document.getElementById('thread-search').value = '';
  document.getElementById('thread-search-clear').style.display = 'none';
  document.getElementById('thread-search-meta').textContent = '';
  document.getElementById('load-more-wrap').style.display = 'none';

  const composeWrap = document.getElementById('compose-wrap');
  const composePreview = document.getElementById('compose-preview');
  if (canSend) {
    composeWrap.style.display = '';
    composePreview.style.display = 'none';
    document.getElementById('compose-text').value = '';
    document.getElementById('compose-send-btn').disabled = false;
  } else {
    composeWrap.style.display = 'none';
  }

  document.getElementById('messages-list').innerHTML = '<div class="loading">Loading…</div>';
  await loadMessages(chat.allJids, 0, false);
}

// ---------- messages ----------
async function loadMessages(jids, offset, prepend) {
  if (!Array.isArray(jids)) jids = [jids];
  const isMerged = jids.length > 1;
  try {
    // For merged chats: fetch from both JIDs and combine. Offset/limit apply to total.
    let rows, total;
    if (isMerged) {
      const results = await Promise.all(jids.map(jid => {
        const p = new URLSearchParams({ chat: jid, limit: 300, offset: 0, order: 'asc' });
        return fetch('/api/db/messages?' + p, { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
      }));
      const all = results.flatMap(r => r.rows || []).sort((a, b) => a.ts - b.ts || a.id - b.id);
      total = all.length;
      rows = offset ? all.slice(offset) : all;
    } else {
      const params = new URLSearchParams({ chat: jids[0], limit: MSG_PAGE, offset, order: 'asc' });
      const res = await fetch('/api/db/messages?' + params, { headers: { Authorization: 'Bearer ' + token } });
      const data = await res.json();
      rows = data.rows || [];
      total = data.total || 0;
    }

    const list = document.getElementById('messages-list');
    if (!prepend) list.innerHTML = '';

    const moreWrap = document.getElementById('load-more-wrap');
    // Load more only for single-JID chats (merged chats load everything at once)
    const loaded = offset + rows.length;
    moreWrap.style.display = (!isMerged && loaded < total) ? '' : 'none';
    document.getElementById('load-more-btn').dataset.offset = loaded;

    if (!rows.length && !prepend) {
      list.innerHTML = '<div class="loading muted">No messages.</div>';
      return;
    }

    const frag = document.createDocumentFragment();
    let lastDate = null;
    for (const msg of rows) {
      const dateStr = new Date(msg.ts * 1000).toLocaleDateString();
      if (dateStr !== lastDate) {
        lastDate = dateStr;
        const sep = document.createElement('div');
        sep.className = 'date-sep';
        sep.textContent = dateStr;
        frag.appendChild(sep);
      }
      frag.appendChild(buildBubble(msg));
    }

    if (prepend) {
      const container = document.getElementById('messages-container');
      const prevHeight = container.scrollHeight;
      list.insertBefore(frag, list.firstChild);
      container.scrollTop += container.scrollHeight - prevHeight;
    } else {
      list.appendChild(frag);
      requestAnimationFrame(() => {
        const c = document.getElementById('messages-container');
        c.scrollTop = c.scrollHeight;
      });
    }
  } catch (e) { showToast('Error: ' + e.message); }
}

// ---------- in-thread search ----------
async function runThreadSearch() {
  const q = document.getElementById('thread-search').value.trim();
  if (!q) { clearThreadSearch(); return; }
  threadSearchMode = true;
  threadSearchQuery = q;
  document.getElementById('thread-search-clear').style.display = '';
  await loadSearchResults(0, false);
}

async function loadSearchResults(offset, prepend) {
  try {
    const params = new URLSearchParams({
      chat: currentChat.jid, q: threadSearchQuery,
      limit: MSG_PAGE, offset, order: 'asc',
    });
    const res = await fetch('/api/db/messages?' + params, {
      headers: { Authorization: 'Bearer ' + token },
    });
    const data = await res.json();
    const rows = data.rows || [];
    const total = data.total || 0;

    document.getElementById('thread-search-meta').textContent =
      total ? `${total} result${total !== 1 ? 's' : ''}` : 'No results';

    const list = document.getElementById('messages-list');
    if (!prepend) list.innerHTML = '';

    const loaded = offset + rows.length;
    document.getElementById('load-more-wrap').style.display = loaded < total ? '' : 'none';
    document.getElementById('load-more-btn').dataset.offset = loaded;

    const frag = document.createDocumentFragment();
    for (const msg of rows) frag.appendChild(buildBubble(msg));
    list.appendChild(frag);
  } catch (e) { showToast('Search error: ' + e.message); }
}

function clearThreadSearch() {
  threadSearchMode = false;
  threadSearchQuery = '';
  document.getElementById('thread-search').value = '';
  document.getElementById('thread-search-clear').style.display = 'none';
  document.getElementById('thread-search-meta').textContent = '';
  if (currentChat) {
    document.getElementById('messages-list').innerHTML = '';
    loadMessages(currentChat.allJids, 0, false);
  }
}

// ---------- compose / send ----------
async function previewCompose() {
  const text = document.getElementById('compose-text').value.trim();
  if (!text || !currentChat) return;

  const btn = document.getElementById('compose-send-btn');
  btn.disabled = true;
  btn.textContent = '…';

  // For LID chats with no phone entry, use resolvedPhone; otherwise strip JID suffix
  const to = currentChat.resolvedPhone || currentChat.jid.replace(/@s\.whatsapp\.net$/, '');

  try {
    const res = await fetch('/api/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ to, body: text }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast('Draft error: ' + (data.error || res.status));
      btn.disabled = false;
      btn.textContent = 'Send';
      return;
    }
    composeDraftId = data.id;
    document.getElementById('compose-preview-body').textContent = data.body;
    document.getElementById('compose-preview').style.display = '';
  } catch (e) {
    showToast('Error: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Send';
  }
}

async function confirmCompose() {
  if (!composeDraftId) return;
  const btn = document.getElementById('compose-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    const res = await fetch('/api/confirm/' + composeDraftId, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
    });
    const data = await res.json();
    if (res.ok) {
      document.getElementById('compose-text').value = '';
      document.getElementById('compose-preview').style.display = 'none';
      document.getElementById('compose-send-btn').disabled = false;
      document.getElementById('compose-send-btn').textContent = 'Send';
      composeDraftId = null;
      showToast('Queued — will appear once delivered…');
    } else {
      showToast('Send failed: ' + (data.error || res.status));
    }
  } catch (e) {
    showToast('Error: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '✓ Confirm & Send';
  }
}

async function cancelCompose() {
  if (composeDraftId) {
    try {
      await fetch('/api/drafts/' + composeDraftId, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + token },
      });
    } catch (_) {}
    composeDraftId = null;
  }
  document.getElementById('compose-preview').style.display = 'none';
  document.getElementById('compose-send-btn').disabled = false;
  document.getElementById('compose-send-btn').textContent = 'Send';
}

// ---------- bubble builder ----------
function buildBubble(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-bubble-wrap ' + (msg.from_me ? 'outgoing' : 'incoming');

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (!msg.from_me && msg.chat_kind === 'group' && (msg.sender_name || msg.sender_phone)) {
    const nameEl = document.createElement('div');
    nameEl.className = 'msg-sender';
    nameEl.textContent = msg.sender_name || msg.sender_phone || '';
    bubble.appendChild(nameEl);
  }

  if (msg.media_type) bubble.appendChild(buildMedia(msg));

  if (msg.text) {
    const textEl = document.createElement('div');
    textEl.className = 'msg-text';
    textEl.setAttribute('dir', 'auto');
    textEl.textContent = msg.text;
    bubble.appendChild(textEl);
  } else if (!msg.media_type) {
    const ph = document.createElement('div');
    ph.className = 'msg-text muted';
    ph.textContent = '[no text]';
    bubble.appendChild(ph);
  }

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = fmtMsgTime(msg.ts * 1000);
  bubble.appendChild(meta);

  wrap.appendChild(bubble);
  return wrap;
}

function buildMedia(msg) {
  const div = document.createElement('div');
  div.className = 'msg-media';
  const url = '/api/media/' + msg.id;

  if (msg.media_type === 'image' || msg.media_type === 'sticker') {
    const img = document.createElement('img');
    img.className = 'msg-img';
    img.alt = msg.media_type;
    img.loading = 'lazy';
    img.src = url;
    img.addEventListener('click', () => openLightbox(url));
    img.onerror = () => {
      div.innerHTML = '';
      const p = document.createElement('div');
      p.className = 'media-unavail';
      p.textContent = '[' + msg.media_type + ' — unavailable or expired]';
      div.appendChild(p);
    };
    div.appendChild(img);
  } else if (msg.media_type === 'video') {
    const vid = document.createElement('video');
    vid.className = 'msg-video';
    vid.controls = true;
    vid.preload = 'none';
    vid.src = url;
    div.appendChild(vid);
  } else if (msg.media_type === 'audio') {
    const aud = document.createElement('audio');
    aud.controls = true;
    aud.preload = 'none';
    aud.src = url;
    div.appendChild(aud);
  } else {
    const a = document.createElement('a');
    a.href = url;
    a.className = 'msg-doc-link';
    a.download = msg.filename || 'file';
    a.target = '_blank';
    a.textContent = '📎 ' + (msg.filename || msg.media_type || 'file');
    div.appendChild(a);
  }

  if (msg.media_caption) {
    const cap = document.createElement('div');
    cap.className = 'msg-caption';
    cap.setAttribute('dir', 'auto');
    cap.textContent = msg.media_caption;
    div.appendChild(cap);
  }

  return div;
}

// ---------- lightbox ----------
function openLightbox(src) {
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox').classList.add('open');
}

// ---------- utils ----------
function fmtChatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const today = new Date();
  if (d.toDateString() === today.toDateString())
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function fmtMsgTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function nameInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, 4000);
}

// ---------- event listeners ----------
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
  document.getElementById('chat-search').addEventListener('input', renderChatList);

  document.querySelectorAll('.kind-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.kind-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      chatKindFilter = btn.dataset.kind;
      renderChatList();
    });
  });

  document.getElementById('thread-search-btn').addEventListener('click', runThreadSearch);
  document.getElementById('thread-search').addEventListener('keydown', e => {
    if (e.key === 'Enter') runThreadSearch();
  });
  document.getElementById('thread-search-clear').addEventListener('click', clearThreadSearch);

  document.getElementById('load-more-btn').addEventListener('click', () => {
    const offset = parseInt(document.getElementById('load-more-btn').dataset.offset || '0', 10);
    if (threadSearchMode) loadSearchResults(offset, true);
    else loadMessages(currentChat.allJids, offset, true);
  });

  document.getElementById('compose-send-btn').addEventListener('click', previewCompose);
  document.getElementById('compose-confirm-btn').addEventListener('click', confirmCompose);
  document.getElementById('compose-cancel-btn').addEventListener('click', cancelCompose);

  // Ctrl+Enter sends
  document.getElementById('compose-text').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      previewCompose();
    }
  });

  document.getElementById('lightbox').addEventListener('click', () => {
    document.getElementById('lightbox').classList.remove('open');
  });

  init().then(() => {
    startSSE();
    startPoller();
  });
});

// ---------- SSE: refresh thread when a queued message is delivered ----------
function startSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('message_update', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.status === 'sent' && currentChat && !document.hidden) {
      // Give wacli sync a moment to write the delivered message back to wacli.db
      setTimeout(() => loadMessages(currentChat.allJids, 0, false), 3000);
    }
  });
  es.onerror = () => {};
}

// ---------- visibility-aware periodic refresh (incoming messages) ----------
function startPoller() {
  setInterval(() => {
    if (currentChat && !document.hidden) {
      loadMessages(currentChat.allJids, 0, false);
    }
  }, 20_000);
}
