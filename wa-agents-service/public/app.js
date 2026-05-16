// ---------- tab switching ----------
const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.panel');

function activateTab(name) {
  tabs.forEach(x => x.classList.toggle('active', x.dataset.tab === name));
  panels.forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  if (name === 'tokens')   loadTokens();
  if (name === 'messages') loadMessages();
  if (name === 'send')     loadSendTokens();
  if (name === 'search')   loadSearchToken();
  if (name === 'schedule') { loadSchedTokens(); loadScheduled(); }
}

tabs.forEach((t) => {
  t.addEventListener('click', () => {
    if (!t.dataset.tab) return;
    location.hash = t.dataset.tab;
  });
});

function srchHashStr() {
  const p = new URLSearchParams();
  const q     = document.getElementById('srch-q').value.trim();
  const phone = document.getElementById('srch-phone').value.trim();
  const chat  = document.getElementById('srch-chat').value.trim();
  const dir   = document.getElementById('srch-dir').value;
  const since = document.getElementById('srch-since').value;
  const until = document.getElementById('srch-until').value;
  if (q)          p.set('q', q);
  if (phone)      p.set('phone', phone);
  if (chat)       p.set('chat', chat);
  if (dir)        p.set('dir', dir);
  if (since)      p.set('since', since);
  if (until)      p.set('until', until);
  if (srchPage > 1) p.set('page', String(srchPage));
  return p.toString();
}

function restoreFromHash() {
  const raw      = location.hash.slice(1);
  const qi       = raw.indexOf('?');
  const tabName  = qi >= 0 ? raw.slice(0, qi) : raw;
  const queryStr = qi >= 0 ? raw.slice(qi + 1) : '';
  const valid    = ['connection', 'send', 'schedule', 'tokens', 'messages', 'search', 'docs', 'settings'];
  activateTab(valid.includes(tabName) ? tabName : 'connection');
  if (tabName === 'search' && queryStr) {
    const p = new URLSearchParams(queryStr);
    if (p.has('q'))     document.getElementById('srch-q').value     = p.get('q');
    if (p.has('phone')) document.getElementById('srch-phone').value = p.get('phone');
    if (p.has('chat'))  document.getElementById('srch-chat').value  = p.get('chat');
    if (p.has('dir'))   document.getElementById('srch-dir').value   = p.get('dir');
    if (p.has('since')) document.getElementById('srch-since').value = p.get('since');
    if (p.has('until')) document.getElementById('srch-until').value = p.get('until');
    srchPage = parseInt(p.get('page') || '1');
    runSearch();
  }
}

window.addEventListener('hashchange', restoreFromHash);

// ---------- helpers ----------
function fmtDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString();
}
function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function maskToken(t) {
  if (!t) return '';
  if (t.length <= 10) return '••••••';
  return t.slice(0, 4) + '…' + t.slice(-4);
}
function statusBadge(status) {
  const cls = status === 'sent' ? 'green'
    : status === 'pending' ? 'yellow'
    : status === 'failed' ? 'red'
    : status === 'sending' ? 'blue'
    : '';
  return `<span class="badge ${cls}">${status}</span>`;
}
function appendEvent(text, level = '') {
  const ul = document.getElementById('event-log');
  const li = document.createElement('li');
  if (level) li.className = level;
  li.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  ul.prepend(li);
  while (ul.children.length > 80) ul.removeChild(ul.lastChild);
}

// ---------- connection / status ----------
async function refreshStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    setConnUI(data.connected, data.phone);
  } catch (e) {
    appendEvent('status fetch failed: ' + e.message, 'error');
  }
}
function setConnUI(connected, phone) {
  const dot = document.getElementById('conn-dot');
  const text = document.getElementById('conn-text');
  const phoneEl = document.getElementById('conn-phone');
  const phone2 = document.getElementById('conn-phone-2');
  const badge = document.getElementById('conn-badge');
  dot.classList.toggle('green', !!connected);
  dot.classList.toggle('red', !connected);
  text.textContent = connected ? 'connected' : 'disconnected';
  phoneEl.textContent = phone || 'no phone';
  phone2.textContent = phone ? `phone: ${phone}` : '—';
  badge.textContent = connected ? 'connected' : 'disconnected';
  badge.className = 'badge ' + (connected ? 'green' : 'red');
  // also refresh QR state
  if (connected) {
    document.getElementById('qr-section').innerHTML =
      '<div class="muted">Connected — no QR needed.</div>';
  }
}

async function refreshQR() {
  const sec = document.getElementById('qr-section');
  sec.innerHTML = '<div class="muted">Fetching QR…</div>';
  try {
    const res = await fetch('/api/qr');
    const data = await res.json();
    if (!data.qr) {
      sec.innerHTML = '<div class="muted">Scan QR via wacli auth (no QR available).</div>';
    } else if (data.qr.startsWith('data:image') || /^[A-Za-z0-9+/=]{200,}$/.test(data.qr)) {
      const src = data.qr.startsWith('data:image') ? data.qr : 'data:image/png;base64,' + data.qr;
      sec.innerHTML = `<img alt="QR" src="${src}" />`;
    } else {
      const pre = document.createElement('pre');
      pre.textContent = data.qr;
      sec.innerHTML = '';
      sec.appendChild(pre);
    }
  } catch (e) {
    sec.innerHTML = '<div class="muted">QR fetch failed: ' + e.message + '</div>';
  }
}

document.getElementById('refresh-status').addEventListener('click', refreshStatus);
document.getElementById('refresh-qr').addEventListener('click', refreshQR);

// ---------- SSE ----------
function startSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('open', () => appendEvent('SSE connected', 'ok'));
  es.addEventListener('status', (ev) => {
    const d = JSON.parse(ev.data);
    setConnUI(d.connected, d.phone);
    appendEvent('status: ' + (d.connected ? 'connected' : 'disconnected'));
  });
  es.addEventListener('connection_lost', (ev) => {
    appendEvent('🔴 CONNECTION LOST', 'error');
    setConnUI(false, null);
  });
  es.addEventListener('connection_restored', (ev) => {
    const d = JSON.parse(ev.data);
    appendEvent('🟢 CONNECTION RESTORED' + (d.phone ? ' (' + d.phone + ')' : ''), 'ok');
    setConnUI(true, d.phone);
  });
  es.addEventListener('message_update', (ev) => {
    const d = JSON.parse(ev.data);
    appendEvent(`message #${d.id} → ${d.status}` + (d.error ? ' (' + d.error + ')' : ''),
      d.status === 'failed' ? 'error' : d.status === 'sent' ? 'ok' : '');
    if (document.getElementById('tab-messages').classList.contains('active')) {
      loadMessages();
    }
  });
  es.onerror = () => appendEvent('SSE error / reconnecting', 'warn');
}

// ---------- settings ----------
const TAG_COLORS = [
  { id: 'green',  bg: '#166534', text: '#dcfce7', label: 'Green'  },
  { id: 'red',    bg: '#991b1b', text: '#fee2e2', label: 'Red'    },
  { id: 'blue',   bg: '#1e40af', text: '#dbeafe', label: 'Blue'   },
  { id: 'purple', bg: '#581c87', text: '#f3e8ff', label: 'Purple' },
  { id: 'orange', bg: '#9a3412', text: '#ffedd5', label: 'Orange' },
  { id: 'teal',   bg: '#115e59', text: '#ccfbf1', label: 'Teal'   },
  { id: 'gold',   bg: '#854d0e', text: '#fef9c3', label: 'Gold'   },
  { id: 'pink',   bg: '#9d174d', text: '#fce7f3', label: 'Pink'   },
  { id: 'indigo', bg: '#312e81', text: '#e0e7ff', label: 'Indigo' },
  { id: 'slate',  bg: '#334155', text: '#e2e8f0', label: 'Slate'  },
];

let settingsCurrentColor = null;
let settingsSelectedColor = null;

function applyBannerColor(colorId) {
  const banner = document.getElementById('service-banner');
  if (!colorId) return;
  const c = TAG_COLORS.find(x => x.id === colorId);
  if (!c) return;
  banner.style.background = c.bg;
  banner.style.color = c.text;
  banner.style.borderBottomColor = 'transparent';
}

function initColorSwatches(currentColorId) {
  settingsSelectedColor = currentColorId || null;
  const container = document.getElementById('color-swatches');
  container.innerHTML = '';
  for (const c of TAG_COLORS) {
    const div = document.createElement('div');
    div.className = 'color-swatch' + (c.id === currentColorId ? ' selected' : '');
    div.style.background = c.bg;
    div.title = c.label;
    div.dataset.colorId = c.id;
    div.addEventListener('click', () => {
      settingsSelectedColor = c.id;
      container.querySelectorAll('.color-swatch').forEach(s => {
        s.classList.toggle('selected', s.dataset.colorId === c.id);
      });
    });
    container.appendChild(div);
  }
}


async function saveSettings() {
  const secret = document.getElementById('settings-secret-input').value.trim();
  if (!secret) { alert('Enter admin secret first.'); return; }
  const newSecret = document.getElementById('settings-new-secret').value.trim();
  const body = {};
  if (settingsSelectedColor !== settingsCurrentColor) body.color = settingsSelectedColor;
  if (newSecret) body.newSecret = newSecret;
  if (!Object.keys(body).length) {
    document.getElementById('settings-result').textContent = 'No changes to save.';
    return;
  }
  try {
    const res = await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { document.getElementById('settings-result').textContent = 'Error: ' + (data.error || res.status); return; }
    settingsCurrentColor = settingsSelectedColor;
    if (newSecret) {
      document.getElementById('settings-secret-input').value = newSecret;
      document.getElementById('admin-secret-input').value = newSecret;
      document.getElementById('settings-new-secret').value = '';
    }
    applyBannerColor(settingsCurrentColor);
    const resultEl = document.getElementById('settings-result');
    resultEl.textContent = '✓ Saved';
    setTimeout(() => { resultEl.textContent = ''; }, 3000);
  } catch (e) {
    document.getElementById('settings-result').textContent = 'Error: ' + e.message;
  }
}

document.getElementById('settings-save-btn').addEventListener('click', saveSettings);

// ---------- service info ----------
async function initServiceInfo() {
  try {
    const res = await fetch('/api/info');
    const info = await res.json();
    document.title = info.label;
    document.getElementById('service-name').textContent = info.label;
    document.getElementById('service-banner').textContent = info.label.toUpperCase();
    settingsCurrentColor = info.color || null;
    initColorSwatches(settingsCurrentColor);
    if (info.color) applyBannerColor(info.color);
  } catch (_) {}
}

// ---------- tokens ----------
function getAdminSecret() {
  return (document.getElementById('admin-secret-input').value || '').trim();
}

async function loadTokens() {
  const res = await fetch('/api/tokens');
  const data = await res.json();
  const body = document.getElementById('tokens-body');
  body.innerHTML = '';
  for (const t of data.tokens) {
    const tr = document.createElement('tr');
    const scopeBadge = t.readonly
      ? '<span class="badge yellow">read only</span>'
      : '<span class="badge blue">full</span>';
    tr.innerHTML = `
      <td>${escapeHtml(t.name || '')}</td>
      <td class="mono">${maskToken(t.token)}</td>
      <td>${fmtDate(t.created_at)}</td>
      <td>${scopeBadge}</td>
      <td>${t.active ? '<span class="badge green">active</span>' : '<span class="badge">revoked</span>'}</td>
      <td>${t.active ? `<button class="danger" data-id="${t.id}">Revoke</button>` : ''}</td>
    `;
    body.appendChild(tr);
  }
  body.querySelectorAll('button.danger').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const secret = getAdminSecret();
      if (!secret) { alert('Enter the admin secret above first.'); return; }
      if (!confirm('Revoke this token?')) return;
      const r = await fetch('/api/tokens/' + btn.dataset.id, {
        method: 'DELETE',
        headers: { 'x-admin-secret': secret },
      });
      if (!r.ok) { const d = await r.json(); alert('Error: ' + (d.error || r.status)); return; }
      loadTokens();
    });
  });
}

document.getElementById('token-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const secret = getAdminSecret();
  if (!secret) { alert('Enter the admin secret above first.'); return; }
  const name = document.getElementById('token-name').value.trim();
  if (!name) return;
  const readonly = document.getElementById('token-readonly').checked;
  const res = await fetch('/api/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
    body: JSON.stringify({ name, readonly }),
  });
  const data = await res.json();
  if (!res.ok) { alert('Error: ' + (data.error || res.status)); return; }
  document.getElementById('token-name').value = '';
  const newDiv = document.getElementById('new-token');
  newDiv.classList.remove('hidden');
  newDiv.innerHTML = `
    <strong>New token created — copy it now, it won't be shown again.</strong>
    <code class="token-value">${escapeHtml(data.token)}</code>
  `;
  loadTokens();
});

// ---------- messages ----------
let msgPage = 1;
const msgLimit = 25;

async function loadMessages() {
  const status = document.getElementById('status-filter').value;
  const url = `/api/messages?page=${msgPage}&limit=${msgLimit}` + (status ? `&status=${status}` : '');
  const res = await fetch(url);
  const data = await res.json();
  const body = document.getElementById('messages-body');
  body.innerHTML = '';
  for (const m of data.messages) {
    const canDelete = m.status === 'pending' || m.status === 'failed';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono">${m.id}</td>
      <td class="mono">${escapeHtml(m.to_number)}</td>
      <td class="body-cell" title="${escapeHtml(m.body)}">${escapeHtml(truncate(m.body, 80))}</td>
      <td>${statusBadge(m.status)}</td>
      <td>${m.retries}/${m.max_retries}</td>
      <td>${fmtDate(m.created_at)}</td>
      <td>${fmtDate(m.sent_at)}</td>
      <td>${canDelete ? `<button class="danger msg-delete-btn" data-id="${m.id}">✕</button>` : ''}</td>
    `;
    body.appendChild(tr);
  }
  body.querySelectorAll('.msg-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const token = sendTokens.length ? sendTokens[0].token : null;
      if (!token) { alert('No active token — open Send tab first to load tokens.'); return; }
      if (!confirm(`Delete message #${btn.dataset.id}?`)) return;
      const r = await fetch('/api/messages/' + btn.dataset.id, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + token },
      });
      if (r.ok) loadMessages();
      else { const d = await r.json(); alert('Delete failed: ' + (d.error || r.status)); }
    });
  });
  document.getElementById('messages-meta').textContent =
    `${data.total} total · page ${data.page}`;
  document.getElementById('page-num').textContent = String(msgPage);
}

document.getElementById('refresh-messages').addEventListener('click', () => loadMessages());
document.getElementById('status-filter').addEventListener('change', () => {
  msgPage = 1;
  loadMessages();
});
document.getElementById('prev-page').addEventListener('click', () => {
  if (msgPage > 1) { msgPage--; loadMessages(); }
});
document.getElementById('next-page').addEventListener('click', () => {
  msgPage++; loadMessages();
});

setInterval(() => {
  if (document.getElementById('tab-messages').classList.contains('active')) {
    loadMessages();
  }
}, 15_000);

// ---------- send tab ----------

// Parse any Israeli or international number into E.164 without leading +
function parsePhone(raw) {
  // strip everything except digits and leading +
  let s = raw.replace(/[^\d+]/g, '');
  // drop leading +
  if (s.startsWith('+')) s = s.slice(1);
  // Israeli local: starts with 0 → drop 0, prepend 972
  if (s.startsWith('0')) s = '972' + s.slice(1);
  return s;
}

function phoneValid(parsed) {
  return /^\d{7,15}$/.test(parsed);
}

let sendTokens = [];
let currentDraftId = null;

async function loadSendTokens() {
  try {
    const res = await fetch('/api/tokens');
    const data = await res.json();
    sendTokens = (data.tokens || []).filter(t => t.active);
    const sel = document.getElementById('send-token-select');
    sel.innerHTML = '';
    if (!sendTokens.length) {
      sel.innerHTML = '<option value="">No active tokens — create one in Tokens tab</option>';
      document.getElementById('send-token-hint').textContent = '';
      return;
    }
    for (const t of sendTokens) {
      const opt = document.createElement('option');
      opt.value = t.token;
      opt.textContent = t.name + '  (' + maskToken(t.token) + ')';
      sel.appendChild(opt);
    }
    document.getElementById('send-token-hint').textContent =
      'Using token "' + sendTokens[0].name + '". Change above if needed.';
  } catch (e) {
    document.getElementById('send-token-hint').textContent = 'Failed to load tokens: ' + e.message;
  }
}

function updateToPreview() {
  const raw = document.getElementById('send-to').value;
  const hint = document.getElementById('send-to-parsed');
  if (!raw.trim()) { hint.textContent = ''; return; }
  const parsed = parsePhone(raw);
  if (phoneValid(parsed)) {
    hint.textContent = '→ ' + parsed;
    hint.style.color = 'var(--green)';
  } else {
    hint.textContent = '→ ' + parsed + ' (looks short — double-check)';
    hint.style.color = 'var(--yellow)';
  }
}

function updateBodyCount() {
  const body = document.getElementById('send-body').value;
  document.getElementById('send-body-count').textContent = body.length + ' chars';
}

async function createDraft() {
  const token = document.getElementById('send-token-select').value;
  if (!token) { alert('Select a token first.'); return; }

  const rawTo = document.getElementById('send-to').value.trim();
  const to = parsePhone(rawTo);
  if (!phoneValid(to)) { alert('Phone number looks invalid: ' + to); return; }

  const body = document.getElementById('send-body').value.trim();
  if (!body) { alert('Message body is empty.'); return; }

  const btn = document.getElementById('send-draft-btn');
  btn.disabled = true;
  btn.textContent = 'Creating draft…';

  try {
    const res = await fetch('/api/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ to, body }),
    });
    const data = await res.json();
    if (!res.ok) { alert('Draft error: ' + (data.error || res.status)); return; }

    currentDraftId = data.id;
    document.getElementById('preview-to').textContent = data.to;
    document.getElementById('preview-body').textContent = data.body;
    document.getElementById('send-preview-card').classList.remove('hidden');
    document.getElementById('send-result').classList.add('hidden');
    document.getElementById('send-result').className = 'send-result hidden';
    appendEvent('Draft created: to=' + data.to);
  } catch (e) {
    alert('Draft failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Preview draft';
  }
}

async function confirmDraft() {
  if (!currentDraftId) return;
  const token = document.getElementById('send-token-select').value;
  const btn = document.getElementById('send-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    const res = await fetch('/api/confirm/' + currentDraftId, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
    });
    const data = await res.json();
    const resultEl = document.getElementById('send-result');
    resultEl.classList.remove('hidden');
    if (res.ok) {
      resultEl.className = 'send-result ok';
      resultEl.textContent = '✓ Queued as message #' + data.messageId;
      appendEvent('Message queued: #' + data.messageId, 'ok');
      // reset form
      document.getElementById('send-to').value = '';
      document.getElementById('send-body').value = '';
      document.getElementById('send-to-parsed').textContent = '';
      document.getElementById('send-body-count').textContent = '';
      setTimeout(() => {
        document.getElementById('send-preview-card').classList.add('hidden');
        resultEl.classList.add('hidden');
      }, 4000);
    } else {
      resultEl.className = 'send-result err';
      resultEl.textContent = '✗ ' + (data.error || 'Unknown error');
    }
    currentDraftId = null;
  } catch (e) {
    alert('Confirm failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '✓ Confirm & Send';
  }
}

async function cancelDraft() {
  if (!currentDraftId) { document.getElementById('send-preview-card').classList.add('hidden'); return; }
  const token = document.getElementById('send-token-select').value;
  try {
    await fetch('/api/drafts/' + currentDraftId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token },
    });
    appendEvent('Draft cancelled: ' + currentDraftId);
  } catch (_) {}
  currentDraftId = null;
  document.getElementById('send-preview-card').classList.add('hidden');
}

document.getElementById('send-to').addEventListener('input', updateToPreview);
document.getElementById('send-body').addEventListener('input', updateBodyCount);
document.getElementById('send-token-refresh').addEventListener('click', loadSendTokens);
document.getElementById('send-draft-btn').addEventListener('click', createDraft);
document.getElementById('send-confirm-btn').addEventListener('click', confirmDraft);
document.getElementById('send-cancel-btn').addEventListener('click', cancelDraft);

// ---------- search ----------
let srchPage = 1;
const srchLimit = 50;
let srchToken = null;

async function loadSearchToken() {
  try {
    const res = await fetch('/api/tokens');
    const data = await res.json();
    const active = (data.tokens || []).filter(t => t.active);
    srchToken = active.length ? active[0].token : null;
  } catch (_) {}
}

function srchParams() {
  const q        = document.getElementById('srch-q').value.trim();
  const phone    = document.getElementById('srch-phone').value.trim();
  const chat     = document.getElementById('srch-chat').value.trim();
  const dir      = document.getElementById('srch-dir').value;
  const sinceVal = document.getElementById('srch-since').value;
  const untilVal = document.getElementById('srch-until').value;

  const p = new URLSearchParams();
  if (q)       p.set('q', q);
  if (phone)   p.set('phone', phone);
  if (chat)    p.set('chat_name', chat);
  if (dir)     p.set('from_me', dir);
  if (sinceVal) p.set('since', Math.floor(new Date(sinceVal).getTime() / 1000));
  if (untilVal) p.set('until', Math.floor(new Date(untilVal + 'T23:59:59').getTime() / 1000));
  p.set('limit', srchLimit);
  p.set('offset', (srchPage - 1) * srchLimit);
  p.set('order', 'desc');
  return p;
}

async function runSearch() {
  if (!srchToken) await loadSearchToken();
  if (!srchToken) { alert('No active token found — create one in the Tokens tab.'); return; }

  const hs = srchHashStr();
  history.replaceState(null, '', '#search' + (hs ? '?' + hs : ''));

  const meta = document.getElementById('srch-meta');
  meta.textContent = 'Searching…';

  try {
    const res = await fetch('/api/db/messages?' + srchParams(), {
      headers: { 'Authorization': 'Bearer ' + srchToken },
    });
    if (res.status === 503) {
      meta.textContent = 'DB not ready — pair the device first.';
      return;
    }
    const data = await res.json();
    const card = document.getElementById('srch-results-card');
    const body = document.getElementById('srch-body');
    body.innerHTML = '';

    if (!data.rows || !data.rows.length) {
      meta.textContent = 'No results.';
      card.style.display = 'none';
      return;
    }

    card.style.display = '';
    for (const m of data.rows) {
      const tr = document.createElement('tr');
      const ts = m.ts ? new Date(m.ts * 1000).toLocaleString() : '—';
      const dir = m.from_me ? '<span class="badge blue">out</span>' : '<span class="badge">in</span>';
      tr.innerHTML = `
        <td class="mono nowrap">${escapeHtml(ts)}</td>
        <td>${escapeHtml(m.chat_name || m.chat_jid || '—')}</td>
        <td>${escapeHtml(m.sender_name || m.sender_phone || m.sender_jid || '—')}</td>
        <td>${dir}</td>
        <td class="body-cell" title="${escapeHtml(m.text || '')}">${escapeHtml(truncate(m.text || m.media_type || '', 120))}</td>
      `;
      body.appendChild(tr);
    }

    const total = data.total || 0;
    const shown = ((srchPage - 1) * srchLimit) + data.rows.length;
    meta.textContent = `${total} total`;
    document.getElementById('srch-page-meta').textContent =
      `${shown} of ${total} · page ${srchPage}`;
    document.getElementById('srch-page-num').textContent = String(srchPage);
  } catch (e) {
    meta.textContent = 'Error: ' + e.message;
  }
}

document.getElementById('srch-btn').addEventListener('click', () => {
  srchPage = 1;
  runSearch();
});
document.getElementById('srch-clear').addEventListener('click', () => {
  ['srch-q','srch-phone','srch-chat','srch-since','srch-until'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('srch-dir').value = '';
  document.getElementById('srch-meta').textContent = '';
  document.getElementById('srch-results-card').style.display = 'none';
  srchPage = 1;
});
document.getElementById('srch-prev').addEventListener('click', () => {
  if (srchPage > 1) { srchPage--; runSearch(); }
});
document.getElementById('srch-next').addEventListener('click', () => {
  srchPage++; runSearch();
});
document.getElementById('srch-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { srchPage = 1; runSearch(); }
});

// ---------- util ----------
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- schedule tab ----------

let schedTokens = [];
let schedPage = 1;
const schedLimit = 25;
let schedStatus = '';
let schedSelectedContact = null; // { jid, name, phone, kind }
let schedFile = null;
let schedSortBy  = 'send_at';
let schedSortDir = 'asc';

async function loadSchedTokens() {
  try {
    const res = await fetch('/api/tokens');
    const data = await res.json();
    schedTokens = (data.tokens || []).filter(t => t.active && !t.readonly);
    const sel = document.getElementById('sched-token-select');
    sel.innerHTML = '';
    if (!schedTokens.length) {
      sel.innerHTML = '<option value="">No write tokens — create one in Tokens tab</option>';
      return;
    }
    for (const t of schedTokens) {
      const opt = document.createElement('option');
      opt.value = t.token;
      opt.textContent = t.name + '  (' + maskToken(t.token) + ')';
      sel.appendChild(opt);
    }
  } catch (e) {
    console.error('loadSchedTokens', e);
  }
}

function getSchedToken() {
  return document.getElementById('sched-token-select').value || null;
}

// Contact autocomplete
let contactDebounce = null;

function bindContactSearch() {
  const input = document.getElementById('sched-to-input');
  const dropdown = document.getElementById('sched-contact-dropdown');
  const hint = document.getElementById('sched-to-hint');

  input.addEventListener('input', () => {
    schedSelectedContact = null;
    hint.textContent = '';
    clearTimeout(contactDebounce);
    const q = input.value.trim();
    if (q.length < 2) { dropdown.classList.add('hidden'); return; }
    contactDebounce = setTimeout(() => searchContacts(q), 300);
  });

  input.addEventListener('blur', () => {
    // delay so click on dropdown option fires first
    setTimeout(() => {
      if (!schedSelectedContact) {
        // allow raw phone entry
        const raw = input.value.trim();
        if (raw) {
          schedSelectedContact = { jid: parsePhone(raw), name: raw, phone: parsePhone(raw), kind: 'raw' };
          hint.textContent = '→ ' + schedSelectedContact.jid;
        }
      }
      dropdown.classList.add('hidden');
    }, 200);
  });

  document.addEventListener('click', (e) => {
    if (!document.getElementById('sched-to-input').contains(e.target) &&
        !dropdown.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  });
}

async function searchContacts(q) {
  const token = getSchedToken();
  if (!token) return;
  const dropdown = document.getElementById('sched-contact-dropdown');
  try {
    const res = await fetch('/api/contacts/search?q=' + encodeURIComponent(q) + '&limit=15', {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!res.ok) { dropdown.classList.add('hidden'); return; }
    const data = await res.json();
    renderContactDropdown(data.results || []);
  } catch (_) { dropdown.classList.add('hidden'); }
}

function renderContactDropdown(results) {
  const dropdown = document.getElementById('sched-contact-dropdown');
  dropdown.innerHTML = '';
  if (!results.length) { dropdown.classList.add('hidden'); return; }
  for (const r of results) {
    const div = document.createElement('div');
    div.className = 'contact-option';
    const icon = r.kind === 'group' ? '👥' : '👤';
    const sub = r.phone ? r.phone : r.jid.split('@')[0];
    div.innerHTML = `<span class="contact-icon">${icon}</span>
      <span class="contact-name">${escapeHtml(r.name)}</span>
      <span class="contact-phone">${escapeHtml(sub)}</span>`;
    div.addEventListener('mousedown', (e) => {
      e.preventDefault();
      selectContact(r);
    });
    dropdown.appendChild(div);
  }
  dropdown.classList.remove('hidden');
}

function selectContact(r) {
  schedSelectedContact = r;
  document.getElementById('sched-to-input').value = r.name + (r.phone ? ' · ' + r.phone : '');
  document.getElementById('sched-to-hint').textContent = '→ ' + (r.phone || r.jid);
  document.getElementById('sched-contact-dropdown').classList.add('hidden');
}

// Media upload / drag-drop
function bindMediaUpload() {
  const zone = document.getElementById('sched-drop-zone');
  const fileInput = document.getElementById('sched-file-input');
  const preview = document.getElementById('sched-file-preview');
  const captionWrap = document.getElementById('sched-caption-wrap');

  zone.addEventListener('click', () => fileInput.click());

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) setMediaFile(f);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) setMediaFile(fileInput.files[0]);
  });

  function setMediaFile(f) {
    schedFile = f;
    const label = document.getElementById('sched-drop-label');
    label.textContent = '';
    preview.classList.remove('hidden');
    captionWrap.classList.remove('hidden');

    if (f.type.startsWith('image/')) {
      const url = URL.createObjectURL(f);
      preview.innerHTML = `<img src="${url}" class="sched-preview-img" /><span>${escapeHtml(f.name)}</span>
        <button class="sched-remove-file danger" type="button">✕</button>`;
    } else {
      const icon = f.type.startsWith('video/') ? '🎬' : f.type.startsWith('audio/') ? '🎵' : '📄';
      preview.innerHTML = `<span class="sched-file-icon">${icon}</span><span>${escapeHtml(f.name)}</span>
        <span class="muted" style="font-size:12px">${(f.size / 1024).toFixed(0)} KB</span>
        <button class="sched-remove-file danger" type="button">✕</button>`;
    }

    preview.querySelector('.sched-remove-file').addEventListener('click', (e) => {
      e.stopPropagation();
      clearMediaFile();
    });
  }

  function clearMediaFile() {
    schedFile = null;
    fileInput.value = '';
    preview.innerHTML = '';
    preview.classList.add('hidden');
    captionWrap.classList.add('hidden');
    document.getElementById('sched-drop-label').textContent = '📎 Click or drag & drop a file';
  }
}

// Recurrence toggle
function bindRecurrence() {
  const sel = document.getElementById('sched-recurrence');
  const cronInput = document.getElementById('sched-cron');
  sel.addEventListener('change', () => {
    cronInput.classList.toggle('hidden', sel.value !== 'custom');
  });
}

// Schedule form submit
async function submitSchedule() {
  const token = getSchedToken();
  if (!token) { alert('Select a token first.'); return; }

  const dateVal = document.getElementById('sched-date').value;
  const timeVal = document.getElementById('sched-time').value;
  if (!dateVal || !timeVal) { alert('Select send date and time.'); return; }
  const sendAt = new Date(dateVal + 'T' + timeVal).getTime();
  if (!sendAt || sendAt <= Date.now()) { alert('Send time must be in the future.'); return; }

  if (!schedSelectedContact) { alert('Select a contact or enter a phone number.'); return; }
  const to = schedSelectedContact.phone || schedSelectedContact.jid;
  const toLabel = schedSelectedContact.name || '';

  const body = document.getElementById('sched-msg').value.trim();
  if (!body && !schedFile) { alert('Enter a message or attach media.'); return; }

  let recurrence = document.getElementById('sched-recurrence').value;
  if (recurrence === 'custom') {
    recurrence = document.getElementById('sched-cron').value.trim();
    if (!recurrence) { alert('Enter a cron expression for custom repeat.'); return; }
  }

  const btn = document.getElementById('sched-submit-btn');
  btn.disabled = true;
  btn.textContent = 'Scheduling…';
  const resultEl = document.getElementById('sched-result');
  resultEl.className = 'send-result hidden';

  try {
    const fd = new FormData();
    fd.append('to', to);
    fd.append('toLabel', toLabel);
    fd.append('sendAt', String(sendAt));
    if (body) fd.append('body', body);
    if (recurrence) fd.append('recurrence', recurrence);
    if (schedFile) {
      fd.append('media', schedFile);
      const caption = document.getElementById('sched-caption').value.trim();
      if (caption) fd.append('mediaCaption', caption);
    }

    const res = await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body: fd,
    });
    const data = await res.json();
    if (!res.ok) {
      resultEl.className = 'send-result err';
      resultEl.textContent = '✗ ' + (data.error || res.status);
      resultEl.classList.remove('hidden');
      return;
    }
    resultEl.className = 'send-result ok';
    resultEl.textContent = '✓ Scheduled as #' + data.id;
    resultEl.classList.remove('hidden');
    // reset form
    document.getElementById('sched-to-input').value = '';
    document.getElementById('sched-to-hint').textContent = '';
    document.getElementById('sched-msg').value = '';
    document.getElementById('sched-date').value = '';
    document.getElementById('sched-time').value = '';
    document.getElementById('sched-recurrence').value = '';
    document.getElementById('sched-cron').classList.add('hidden');
    document.getElementById('sched-caption').value = '';
    schedSelectedContact = null;
    schedFile = null;
    document.getElementById('sched-file-preview').innerHTML = '';
    document.getElementById('sched-file-preview').classList.add('hidden');
    document.getElementById('sched-caption-wrap').classList.add('hidden');
    document.getElementById('sched-drop-label').textContent = '📎 Click or drag & drop a file';
    document.getElementById('sched-file-input').value = '';
    setTimeout(() => { resultEl.classList.add('hidden'); activateInnerTab('queue'); }, 1500);
    schedPage = 1;
  } catch (e) {
    resultEl.className = 'send-result err';
    resultEl.textContent = '✗ ' + e.message;
    resultEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Schedule';
  }
}

// Schedule queue
function schedStatusBadge(status) {
  const map = {
    scheduled: 'blue',
    disabled:  '',
    fired:     'green',
    failed:    'red',
  };
  return `<span class="badge ${map[status] || ''}">${status}</span>`;
}

function fmtRecurrence(r) {
  if (!r) return 'Once';
  const map = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
  return map[r] || `<code style="font-size:11px">${escapeHtml(r)}</code>`;
}

async function loadScheduled() {
  const token = getSchedToken();
  if (!token) return;
  const statusQ = schedStatus ? `&status=${schedStatus}` : '';
  try {
    const res = await fetch(`/api/schedule?page=${schedPage}&limit=${schedLimit}${statusQ}`, {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!res.ok) return;
    const data = await res.json();
    renderScheduled(data);
  } catch (_) {}
}

function sortSchedules(rows) {
  return [...rows].sort((a, b) => {
    let av, bv;
    if (schedSortBy === 'send_at') {
      av = a.send_at || 0; bv = b.send_at || 0;
    } else if (schedSortBy === 'status') {
      av = a.status || ''; bv = b.status || '';
    } else if (schedSortBy === 'to') {
      av = (a.to_label || a.to_number || '').toLowerCase();
      bv = (b.to_label || b.to_number || '').toLowerCase();
    } else {
      av = a.id; bv = b.id;
    }
    if (av < bv) return schedSortDir === 'asc' ? -1 : 1;
    if (av > bv) return schedSortDir === 'asc' ?  1 : -1;
    return 0;
  });
}

function updateSortHeaders() {
  document.querySelectorAll('#sched-inner-queue .sort-col').forEach(th => {
    const isActive = th.dataset.sort === schedSortBy;
    th.classList.toggle('active-sort', isActive);
    const arrow = isActive ? (schedSortDir === 'asc' ? ' ↑' : ' ↓') : '';
    th.textContent = th.dataset.sort === 'id'      ? '#'
                   : th.dataset.sort === 'to'      ? 'To'
                   : th.dataset.sort === 'send_at' ? 'Next send'
                   : th.dataset.sort === 'status'  ? 'Status'
                   : th.dataset.sort;
    th.textContent += arrow;
  });
}

function renderScheduled(data) {
  updateSortHeaders();
  const body = document.getElementById('sched-queue-body');
  body.innerHTML = '';
  const sorted = sortSchedules(data.schedules || []);
  for (const s of sorted) {
    const displayTo = escapeHtml(s.to_label || s.to_number);
    const phoneHint = s.to_label ? `<span class="muted" style="font-size:11px">${escapeHtml(s.to_number)}</span>` : '';
    const msgPreview = s.media_path
      ? `📎 ${escapeHtml(s.media_filename || 'file')}${s.body ? ' · ' + escapeHtml(truncate(s.body, 30)) : ''}`
      : escapeHtml(truncate(s.body || '', 60));
    const nextSend = s.status === 'fired' ? '—' : fmtDate(s.send_at);
    const canAct = s.status !== 'fired';
    const disableBtn = s.status === 'scheduled'
      ? `<button class="sched-disable-btn secondary" data-id="${s.id}" title="Disable — pauses this schedule">Pause</button>`
      : '';
    const enableBtn = s.status === 'disabled'
      ? `<button class="sched-enable-btn" data-id="${s.id}" title="Re-enable this schedule">Enable</button>`
      : '';
    const deleteBtn = canAct
      ? `<button class="sched-delete-btn danger" data-id="${s.id}" title="Delete permanently">✕</button>`
      : '';

    const tr = document.createElement('tr');
    if (s.status === 'disabled') tr.style.opacity = '0.6';
    tr.innerHTML = `
      <td class="mono">${s.id}</td>
      <td>${displayTo}${phoneHint ? '<br>' + phoneHint : ''}</td>
      <td class="body-cell" title="${escapeHtml(s.body || '')}">${msgPreview}</td>
      <td class="nowrap">${nextSend}</td>
      <td>${fmtRecurrence(s.recurrence)}</td>
      <td>${schedStatusBadge(s.status)}</td>
      <td class="row" style="gap:4px;flex-wrap:nowrap">${disableBtn}${enableBtn}${deleteBtn}</td>
    `;
    body.appendChild(tr);
  }

  body.querySelectorAll('.sched-disable-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const token = getSchedToken();
      await fetch('/api/schedule/' + btn.dataset.id + '/disable', {
        method: 'PATCH', headers: { 'Authorization': 'Bearer ' + token },
      });
      loadScheduled();
    });
  });
  body.querySelectorAll('.sched-enable-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const token = getSchedToken();
      await fetch('/api/schedule/' + btn.dataset.id + '/enable', {
        method: 'PATCH', headers: { 'Authorization': 'Bearer ' + token },
      });
      loadScheduled();
    });
  });
  body.querySelectorAll('.sched-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Delete scheduled message #${btn.dataset.id}?`)) return;
      const token = getSchedToken();
      const r = await fetch('/api/schedule/' + btn.dataset.id, {
        method: 'DELETE', headers: { 'Authorization': 'Bearer ' + token },
      });
      if (!r.ok) { const d = await r.json(); alert('Error: ' + (d.error || r.status)); return; }
      loadScheduled();
    });
  });

  const total = data.total || 0;
  document.getElementById('sched-meta').textContent = `${total} total · page ${schedPage}`;
  document.getElementById('sched-page-num').textContent = String(schedPage);
}

// Inner tab switching for Schedule panel
function activateInnerTab(name) {
  document.querySelectorAll('#tab-schedule .inner-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.inner === name);
  });
  document.querySelectorAll('#tab-schedule .inner-panel').forEach(p => {
    p.classList.toggle('active', p.id === 'sched-inner-' + name);
  });
  if (name === 'queue') loadScheduled();
}

document.querySelectorAll('#tab-schedule .inner-tab').forEach(t => {
  t.addEventListener('click', () => activateInnerTab(t.dataset.inner));
});

// Wire up schedule tab events
document.getElementById('sched-token-refresh').addEventListener('click', loadSchedTokens);
document.getElementById('sched-submit-btn').addEventListener('click', submitSchedule);
document.getElementById('sched-refresh-btn').addEventListener('click', () => { schedPage = 1; loadScheduled(); });
document.getElementById('sched-prev').addEventListener('click', () => { if (schedPage > 1) { schedPage--; loadScheduled(); } });
document.getElementById('sched-next').addEventListener('click', () => { schedPage++; loadScheduled(); });

document.querySelector('#sched-inner-queue thead').addEventListener('click', (e) => {
  const th = e.target.closest('.sort-col');
  if (!th) return;
  const col = th.dataset.sort;
  if (col === schedSortBy) {
    schedSortDir = schedSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    schedSortBy = col;
    schedSortDir = col === 'send_at' ? 'asc' : 'asc';
  }
  // re-render with current data (re-fetch to keep it simple)
  loadScheduled();
});

document.getElementById('sched-filter-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  document.querySelectorAll('#sched-filter-chips .chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  schedStatus = chip.dataset.status;
  schedPage = 1;
  loadScheduled();
});

// ---------- docs host injection ----------
// Replace __HOST__ placeholders in the API docs with the actual origin
// so the examples work regardless of what hostname/proxy is in front.
function injectDocsHost() {
  const host = window.location.origin || 'https://<host>';
  document.querySelectorAll('#tab-docs .doc-code').forEach((el) => {
    el.textContent = el.textContent.replace(/__HOST__/g, host);
  });
}

// ---------- theme ----------
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀' : '🌙';
  localStorage.setItem('wa-theme', theme);
}

document.getElementById('theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// ---------- boot ----------
bindContactSearch();
bindMediaUpload();
bindRecurrence();
applyTheme(localStorage.getItem('wa-theme') || 'dark');
initServiceInfo();
injectDocsHost();
refreshStatus();
// QR is NOT fetched on page load — each fetch starts a pairing session with
// WhatsApp. User must click "Refresh QR" to fetch one only when actually pairing.
startSSE();
restoreFromHash();
