const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const db = require('./db');
const wacli = require('./wacli');
const queue = require('./queue');
const scheduler = require('./scheduler');
const sync = require('./sync');
const incoming = require('./incoming');
const wdb = require('./wacli-db');
const media = require('./media');

const PORT            = parseInt(process.env.PORT || '8792', 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '20000', 10);
const SERVICE_LABEL   = process.env.SERVICE_LABEL || "Agent's Line";
const ADMIN_SECRET    = process.env.ADMIN_SECRET  || '';

const SCHEDULED_MEDIA_DIR = process.env.SCHEDULED_MEDIA_DIR || '/data/scheduled-media';
fs.mkdirSync(SCHEDULED_MEDIA_DIR, { recursive: true });

const schedUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, SCHEDULED_MEDIA_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '';
      cb(null, `sched-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 64 * 1024 * 1024 },
});

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- SSE clients ----------
const sseClients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (_) {}
  }
}
function logEvent(label, extra = '') {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${label}${extra ? ' ' + extra : ''}`);
}

// ---------- admin middleware ----------
function getEffectiveAdminSecret() {
  return db.getSetting('admin_secret') || ADMIN_SECRET;
}

function requireAdmin(req, res, next) {
  const secret = req.header('x-admin-secret') || '';
  const effective = getEffectiveAdminSecret();
  if (!effective || secret !== effective) {
    return res.status(403).json({ error: 'admin secret required' });
  }
  next();
}

// ---------- helpers ----------
function dbGuard(_req, res, next) {
  if (!wdb.ready()) return res.status(503).json({ error: 'wacli local DB not yet present — pair via QR first' });
  next();
}

function handleErr(res, err) {
  logEvent('error', err.message);
  res.status(500).json({ error: err.message });
}

// ---------- auth middleware ----------
function requireToken(req, res, next) {
  const header = req.header('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : null;
  if (!token) {
    return res.status(401).json({ error: 'missing bearer token' });
  }
  const row = db.findActiveToken(token);
  if (!row) {
    return res.status(401).json({ error: 'invalid token' });
  }
  req.tokenId = row.id;
  req.tokenName = row.name;
  req.tokenReadonly = !!row.readonly;
  next();
}

function requireWriteToken(req, res, next) {
  requireToken(req, res, () => {
    if (req.tokenReadonly) {
      return res.status(403).json({ error: 'token is read-only — send/draft not permitted' });
    }
    next();
  });
}

// ---------- routes ----------

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/info', (_req, res) => {
  res.json({ label: SERVICE_LABEL, color: db.getSetting('banner_color') || null });
});

app.get('/api/settings', requireAdmin, (_req, res) => {
  res.json({
    color: db.getSetting('banner_color') || null,
    hasCustomSecret: !!db.getSetting('admin_secret'),
  });
});

app.patch('/api/settings', requireAdmin, (req, res) => {
  const { color, newSecret } = req.body || {};
  if (color !== undefined) {
    db.setSetting('banner_color', color || null);
  }
  if (newSecret !== undefined) {
    const s = String(newSecret).trim();
    if (!s) return res.status(400).json({ error: 'new secret cannot be empty' });
    db.setSetting('admin_secret', s);
  }
  res.json({ ok: true });
});

app.get('/api/capabilities', (_req, res) => {
  res.json({ send: true, receive: true });
});

app.get('/api/status', async (_req, res) => {
  const s = await wacli.checkStatus();
  res.json({ connected: !!s.authenticated, phone: s.phone || null });
});

app.get('/api/qr', async (_req, res) => {
  try {
    const qr = await wacli.getQR();
    res.json({ qr: qr || null });
  } catch (err) {
    res.status(500).json({ qr: null, error: err.message });
  }
});

// SSE stream for connection state changes
app.get('/api/events', requireToken, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(': connected\n\n');
  sseClients.add(res);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 25_000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

// Tokens — admin (no auth for now per spec)
app.get('/api/tokens', (_req, res) => {
  res.json({ tokens: db.listTokens() });
});

app.post('/api/tokens', requireAdmin, (req, res) => {
  const name = (req.body && req.body.name ? String(req.body.name) : '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const readonly = !!(req.body && req.body.readonly);
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(24).toString('base64url');
  db.createToken({ id, name, token, readonly });
  res.status(201).json({ id, name, token, readonly });
});

app.delete('/api/tokens/:id', requireAdmin, (req, res) => {
  db.deactivateToken(req.params.id);
  res.json({ ok: true });
});

// Send (queue) message
app.post('/api/send', requireWriteToken, (req, res) => {
  const to = (req.body && req.body.to ? String(req.body.to) : '').trim();
  const body = (req.body && req.body.body ? String(req.body.body) : '');
  if (!to) return res.status(400).json({ error: 'to required' });
  if (!body) return res.status(400).json({ error: 'body required' });
  const id = db.enqueueMessage({ to, body, tokenId: req.tokenId });
  res.status(202).json({ id, status: 'queued' });
});

// ---------- draft (failsafe) flow ----------

// Extract content between ===SEND=== / ===END=== if present, else use raw body.
function extractEnvelope(text) {
  const m = text.match(/={3}SEND={3}([\s\S]*?)={3}END={3}/);
  return m ? m[1].trim() : text.trim();
}

// Create draft — never touches wacli, never touches the queue.
app.post('/api/draft', requireWriteToken, (req, res) => {
  const to = (req.body && req.body.to ? String(req.body.to) : '').trim();
  const rawBody = (req.body && req.body.body ? String(req.body.body) : '');
  if (!to) return res.status(400).json({ error: 'to required' });
  if (!rawBody) return res.status(400).json({ error: 'body required' });
  const body = extractEnvelope(rawBody);
  if (!body) return res.status(400).json({ error: 'body empty after envelope extraction' });
  const id = crypto.randomUUID();
  const draft = db.createDraft({ id, to, body, tokenId: req.tokenId });
  logEvent('draft created', `id=${id} to=${to}`);
  res.status(201).json({ id: draft.id, to: draft.to_number, body: draft.body, status: draft.status, createdAt: draft.created_at });
});

// List drafts
app.get('/api/drafts', requireToken, (req, res) => {
  const status = req.query.status ? String(req.query.status) : 'pending';
  const drafts = db.listDrafts({ status });
  res.json({ drafts: drafts.map(d => ({ id: d.id, to: d.to_number, body: d.body, status: d.status, createdAt: d.created_at })) });
});

// Confirm draft — this is the only gate into the queue
app.post('/api/confirm/:id', requireWriteToken, (req, res) => {
  const draft = db.getDraft(req.params.id);
  if (!draft) return res.status(404).json({ error: 'draft not found' });
  if (draft.status !== 'pending') return res.status(409).json({ error: `draft already ${draft.status}` });
  const messageId = db.enqueueMessage({ to: draft.to_number, body: draft.body, tokenId: req.tokenId });
  db.confirmDraft(draft.id, messageId);
  logEvent('draft confirmed', `id=${draft.id} message_id=${messageId}`);
  res.json({ draftId: draft.id, messageId, status: 'queued' });
});

// Cancel draft
app.delete('/api/drafts/:id', requireToken, (req, res) => {
  const ok = db.cancelDraft(req.params.id);
  if (!ok) return res.status(404).json({ error: 'draft not found or already actioned' });
  logEvent('draft cancelled', `id=${req.params.id}`);
  res.json({ ok: true });
});

// ---------- incoming DB read endpoints ----------

app.get('/api/db/lid-map', requireToken, (_req, res) => {
  try { res.json(wdb.getLidMap()); } catch (err) { handleErr(res, err); }
});

app.get('/api/db/stats', requireToken, dbGuard, (_req, res) => {
  try { res.json(wdb.stats()); } catch (err) { handleErr(res, err); }
});

app.get('/api/db/groups', requireToken, dbGuard, (req, res) => {
  try { res.json({ groups: wdb.listGroups({ q: req.query.q, limit: req.query.limit }) }); }
  catch (err) { handleErr(res, err); }
});

app.get('/api/db/groups/:jid/participants', requireToken, dbGuard, (req, res) => {
  try { res.json({ participants: wdb.listGroupParticipants(decodeURIComponent(req.params.jid)) }); }
  catch (err) { handleErr(res, err); }
});

app.get('/api/db/chats', requireToken, dbGuard, (req, res) => {
  try {
    res.json({ chats: wdb.listChats({ q: req.query.q, kind: req.query.kind, limit: req.query.limit }) });
  } catch (err) { handleErr(res, err); }
});

app.get('/api/db/contacts', requireToken, dbGuard, (req, res) => {
  try {
    res.json({ contacts: wdb.searchContacts({ q: req.query.q, phone: req.query.phone, limit: req.query.limit }) });
  } catch (err) { handleErr(res, err); }
});

app.get('/api/db/messages', requireToken, dbGuard, (req, res) => {
  try {
    const result = wdb.searchMessages({
      chat:           req.query.chat,
      chat_name_q:    req.query.chat_name,
      sender:         req.query.sender,
      sender_name_q:  req.query.sender_name,
      contact_name_q: req.query.contact_name,
      phone:          req.query.phone,
      q:              req.query.q,
      from_me:        req.query.from_me,
      kind:           req.query.kind,
      since:          req.query.since,
      until:          req.query.until,
      limit:          req.query.limit,
      offset:         req.query.offset,
      order:          req.query.order,
    });
    const readSet = db.getReadSet(result.rows.map(r => r.id));
    result.rows = result.rows.map(r => ({ ...r, is_read: readSet.has(r.id) }));
    res.json(result);
  } catch (err) { handleErr(res, err); }
});

app.patch('/api/db/messages/:id/read', requireToken, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const read = !req.body || req.body.read !== false;
  if (read) db.markRead(id); else db.markUnread(id);
  res.json({ ok: true, id, is_read: read });
});

// Chat viewer page
app.get('/chat', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

// Media proxy — download + decrypt from WhatsApp CDN, cache to disk
// No auth required: rowids are opaque and this is a self-hosted admin tool.
app.get('/api/media/:msgId', async (req, res) => {
  if (!wdb.ready()) return res.status(503).json({ error: 'wacli DB not ready' });
  const id = parseInt(req.params.msgId, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const msg = wdb.getMessageById(id);
  if (!msg) return res.status(404).json({ error: 'not found' });
  if (!msg.media_key || !msg.direct_path) return res.status(404).json({ error: 'no media' });
  try {
    const { data, mimeType } = await media.fetchMedia(msg);
    res.set('Content-Type', mimeType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(data);
  } catch (err) {
    handleErr(res, err);
  }
});

// ---------- contact search (autocomplete for schedule UI) ----------

app.get('/api/contacts/search', requireToken, dbGuard, (req, res) => {
  try {
    const q = req.query.q ? String(req.query.q) : '';
    const limit = Math.min(30, Math.max(1, parseInt(req.query.limit || '20', 10) || 20));
    const contacts = wdb.searchContacts({ q, limit });
    const chats = wdb.listChats({ q, limit });
    const results = [];
    const seen = new Set();
    for (const c of contacts) {
      seen.add(c.jid);
      const name = c.full_name || c.push_name || c.first_name || c.business_name || '';
      const phone = c.phone || (c.jid.includes('@s.whatsapp.net') ? c.jid.split('@')[0] : '');
      results.push({ jid: c.jid, name: name || phone, phone, kind: 'contact' });
    }
    for (const ch of chats) {
      if (!seen.has(ch.jid)) {
        results.push({ jid: ch.jid, name: ch.name || ch.jid, phone: '', kind: ch.kind });
      }
    }
    res.json({ results: results.slice(0, limit) });
  } catch (err) { handleErr(res, err); }
});

// ---------- scheduled messages ----------

app.post('/api/schedule', requireWriteToken, schedUpload.single('media'), (req, res) => {
  const body = req.body || {};
  const to = (body.to || '').trim();
  const toLabel = (body.toLabel || '').trim() || null;
  const msgBody = (body.body || '').trim() || null;
  const sendAt = parseInt(body.sendAt, 10);
  const recurrence = (body.recurrence || '').trim() || null;
  const mediaCaption = (body.mediaCaption || '').trim() || null;

  if (!to) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(400).json({ error: 'to required' });
  }
  if (!sendAt || sendAt <= Date.now()) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(400).json({ error: 'sendAt must be a future Unix ms timestamp' });
  }
  if (!msgBody && !req.file) {
    return res.status(400).json({ error: 'body or media required' });
  }

  const id = db.createScheduled({
    toNumber:      to,
    toLabel,
    body:          msgBody,
    mediaPath:     req.file ? req.file.path : null,
    mediaCaption,
    mediaFilename: req.file ? req.file.originalname : null,
    mediaMime:     req.file ? req.file.mimetype : null,
    sendAt,
    recurrence,
    tokenId:       req.tokenId,
  });
  logEvent('scheduled created', `id=${id} to=${to} sendAt=${new Date(sendAt).toISOString()} recurrence=${recurrence || 'once'}`);
  res.status(201).json({ id, status: 'scheduled' });
});

app.get('/api/schedule', requireToken, (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const page   = Math.max(1, parseInt(req.query.page  || '1',  10) || 1);
  const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit || '25', 10) || 25));
  res.json(db.listScheduled({ status, page, limit }));
});

app.get('/api/schedule/:id', requireToken, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const row = db.getScheduled(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

app.patch('/api/schedule/:id/disable', requireWriteToken, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const ok = db.disableScheduled(id);
  if (!ok) return res.status(404).json({ error: 'not found or not in scheduled state' });
  logEvent('scheduled disabled', `id=${id}`);
  res.json({ ok: true });
});

app.patch('/api/schedule/:id/enable', requireWriteToken, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const ok = db.enableScheduled(id);
  if (!ok) return res.status(404).json({ error: 'not found or not in disabled state' });
  logEvent('scheduled enabled', `id=${id}`);
  res.json({ ok: true });
});

app.delete('/api/schedule/:id', requireWriteToken, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const row = db.getScheduled(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const ok = db.deleteScheduled(id);
  if (!ok) return res.status(409).json({ error: 'cannot delete a fired message' });
  if (row.media_path) try { fs.unlinkSync(row.media_path); } catch (_) {}
  logEvent('scheduled deleted', `id=${id}`);
  res.json({ ok: true });
});

// ---------- queue messages list ----------

// Delete a pending or failed message from the queue
app.delete('/api/messages/:id', requireToken, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const ok = db.deleteMessage(id);
  if (!ok) return res.status(404).json({ error: 'not found or not deletable (only pending/failed can be deleted)' });
  logEvent('message deleted', `id=${id}`);
  res.json({ ok: true });
});

// Messages list
app.get('/api/messages', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '25', 10) || 25));
  const status = req.query.status ? String(req.query.status) : null;
  const result = db.listMessages({ page, limit, status });
  res.json(result);
});

// Default to index.html (already served by express.static)

// ---------- start queue + connection poller ----------

queue.on('message:sent', ({ id }) => {
  logEvent('message sent', `id=${id}`);
  broadcast('message_update', { id, status: 'sent' });
});
queue.on('message:retry', ({ id, retries, error }) => {
  logEvent('message retry', `id=${id} retries=${retries} err=${error}`);
  broadcast('message_update', { id, status: 'pending', retries, error });
});
queue.on('message:failed', ({ id, error }) => {
  logEvent('message failed', `id=${id} err=${error}`);
  broadcast('message_update', { id, status: 'failed', error });
});
queue.on('error', (err) => logEvent('queue error', err.message));

queue.start();
scheduler.start();
sync.start();
incoming.start();

// Refresh contacts from the whatsmeow session store on startup and every hour.
// Runs independently of sync so names populate even when sync is reconnecting.
(async function scheduleContactsRefresh() {
  const run = async () => { try { await wacli.refreshContacts(); } catch (_) {} };
  await run();
  setInterval(run, 60 * 60 * 1000);
})();

sync.on('synced', () => {
  broadcast('sync_update', { status: sync.status() });
  incoming.check();
});
sync.on('connected', () => {
  logEvent('sync started', `pid=${sync.status().pid}`);
  broadcast('sync_update', { status: sync.status() });
});
sync.on('reconnecting', ({ in: delay, restarts }) => {
  logEvent('sync reconnecting', `in=${delay}ms restarts=${restarts}`);
  broadcast('sync_update', { status: sync.status() });
});
sync.on('error', (err) => {
  logEvent('sync error', err.message);
  broadcast('sync_update', { status: sync.status() });
});

incoming.on('message', (msg) => {
  logEvent('incoming message', `chat=${msg.chat_jid} sender=${msg.sender_jid}`);
  broadcast('incoming_message', msg);
});

let lastConnState = null;
wacli.pollConnection(POLL_INTERVAL_MS, {
  onStatus: (s) => {
    const conn = !!s.authenticated;
    if (conn !== lastConnState) {
      lastConnState = conn;
      broadcast('status', { connected: conn, phone: s.phone || null });
    }
  },
  onDisconnect: (s) => {
    logEvent('CONNECTION LOST', s.error ? `(${s.error})` : '');
    broadcast('connection_lost', { phone: s.phone || null, at: Date.now() });
  },
  onReconnect: (s) => {
    logEvent('CONNECTION RESTORED', s.phone ? `phone=${s.phone}` : '');
    broadcast('connection_restored', { phone: s.phone || null, at: Date.now() });
  },
});

const server = app.listen(PORT, () => {
  logEvent('wa-bot-service listening', `port=${PORT}`);
});

function shutdown() {
  logEvent('shutting down');
  queue.stop();
  scheduler.stop();
  sync.stop();
  incoming.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
