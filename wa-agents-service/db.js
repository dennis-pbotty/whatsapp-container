const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'wa-bot.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    name TEXT,
    token TEXT UNIQUE,
    created_at INTEGER,
    active INTEGER DEFAULT 1,
    readonly INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS scheduled_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    to_number TEXT NOT NULL,
    to_label TEXT,
    body TEXT,
    media_path TEXT,
    media_caption TEXT,
    media_filename TEXT,
    media_mime TEXT,
    send_at INTEGER NOT NULL,
    recurrence TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled',
    token_id TEXT,
    created_at INTEGER NOT NULL,
    last_fired_at INTEGER,
    last_error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sched_status  ON scheduled_messages(status);
  CREATE INDEX IF NOT EXISTS idx_sched_send_at ON scheduled_messages(send_at);

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    to_number TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    retries INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    next_retry_at INTEGER,
    created_at INTEGER,
    sent_at INTEGER,
    error TEXT,
    token_id TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
  CREATE INDEX IF NOT EXISTS idx_messages_next_retry ON messages(next_retry_at);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

  CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    to_number TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at INTEGER,
    confirmed_at INTEGER,
    message_id INTEGER,
    token_id TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);

  CREATE TABLE IF NOT EXISTS message_reads (
    wacli_rowid INTEGER PRIMARY KEY,
    marked_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// migrations
try { db.exec('ALTER TABLE tokens ADD COLUMN readonly INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE messages ADD COLUMN media_path TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE messages ADD COLUMN media_caption TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE messages ADD COLUMN media_filename TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE messages ADD COLUMN media_mime TEXT'); } catch (_) {}

const stmts = {
  insertToken: db.prepare(
    'INSERT INTO tokens (id, name, token, created_at, active, readonly) VALUES (?, ?, ?, ?, 1, ?)'
  ),
  listTokens: db.prepare('SELECT id, name, token, created_at, active, readonly FROM tokens ORDER BY created_at DESC'),
  findActiveToken: db.prepare('SELECT id, name, readonly FROM tokens WHERE token = ? AND active = 1'),
  deactivateToken: db.prepare('UPDATE tokens SET active = 0 WHERE id = ?'),

  insertMessage: db.prepare(
    `INSERT INTO messages (to_number, body, status, max_retries, next_retry_at, created_at, token_id, media_path, media_caption, media_filename, media_mime)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  pickDueMessages: db.prepare(
    `SELECT * FROM messages
     WHERE status = 'pending'
       AND (next_retry_at IS NULL OR next_retry_at <= ?)
     ORDER BY id ASC
     LIMIT ?`
  ),
  markSending: db.prepare("UPDATE messages SET status = 'sending' WHERE id = ?"),
  markSent: db.prepare("UPDATE messages SET status = 'sent', sent_at = ?, error = NULL WHERE id = ?"),
  markFailed: db.prepare("UPDATE messages SET status = 'failed', error = ? WHERE id = ?"),
  markRetry: db.prepare(
    "UPDATE messages SET status = 'pending', retries = retries + 1, next_retry_at = ?, error = ? WHERE id = ?"
  ),
  countMessages: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE (? IS NULL OR status = ?)'),
  listMessages: db.prepare(
    `SELECT * FROM messages
     WHERE (? IS NULL OR status = ?)
     ORDER BY id DESC
     LIMIT ? OFFSET ?`
  ),
  getMessage: db.prepare('SELECT * FROM messages WHERE id = ?'),
  deleteMessage: db.prepare(
    "DELETE FROM messages WHERE id = ? AND status IN ('pending', 'failed')"
  ),
  resetSendingOnBoot: db.prepare(
    "UPDATE messages SET status = 'pending' WHERE status = 'sending'"
  ),

  insertDraft: db.prepare(
    `INSERT INTO drafts (id, to_number, body, status, created_at, token_id)
     VALUES (?, ?, ?, 'pending', ?, ?)`
  ),
  listDrafts: db.prepare(
    `SELECT * FROM drafts WHERE (? IS NULL OR status = ?) ORDER BY created_at DESC LIMIT ?`
  ),
  getDraft: db.prepare('SELECT * FROM drafts WHERE id = ?'),
  confirmDraft: db.prepare(
    `UPDATE drafts SET status = 'confirmed', confirmed_at = ?, message_id = ? WHERE id = ? AND status = 'pending'`
  ),
  cancelDraft: db.prepare(
    `UPDATE drafts SET status = 'cancelled' WHERE id = ? AND status = 'pending'`
  ),

  markRead:   db.prepare('INSERT OR REPLACE INTO message_reads (wacli_rowid, marked_at) VALUES (?, ?)'),
  markUnread: db.prepare('DELETE FROM message_reads WHERE wacli_rowid = ?'),
};

function createToken({ id, name, token, readonly = false }) {
  stmts.insertToken.run(id, name, token, Date.now(), readonly ? 1 : 0);
  return { id, name, token, readonly: !!readonly };
}

function listTokens() {
  return stmts.listTokens.all();
}

function findActiveToken(token) {
  return stmts.findActiveToken.get(token);
}

function deactivateToken(id) {
  return stmts.deactivateToken.run(id);
}

function enqueueMessage({ to, body, tokenId, maxRetries = 3, mediaPath, mediaCaption, mediaFilename, mediaMime } = {}) {
  const info = stmts.insertMessage.run(
    to, body || '', maxRetries, Date.now(), Date.now(), tokenId || null,
    mediaPath || null, mediaCaption || null, mediaFilename || null, mediaMime || null
  );
  return info.lastInsertRowid;
}

function pickDueMessages(now, limit = 10) {
  return stmts.pickDueMessages.all(now, limit);
}

function markSending(id) {
  stmts.markSending.run(id);
}
function markSent(id) {
  stmts.markSent.run(Date.now(), id);
}
function markFailed(id, error) {
  stmts.markFailed.run(error || '', id);
}
function markRetry(id, nextRetryAt, error) {
  stmts.markRetry.run(nextRetryAt, error || '', id);
}

function listMessages({ page = 1, limit = 25, status = null }) {
  const offset = (Math.max(1, page) - 1) * limit;
  const total = stmts.countMessages.get(status, status).n;
  const rows = stmts.listMessages.all(status, status, limit, offset);
  return { total, page, limit, messages: rows };
}

function getMessage(id) {
  return stmts.getMessage.get(id);
}

function deleteMessage(id) {
  const info = stmts.deleteMessage.run(id);
  return info.changes > 0;
}

function resetSendingOnBoot() {
  stmts.resetSendingOnBoot.run();
}

function createDraft({ id, to, body, tokenId }) {
  stmts.insertDraft.run(id, to, body, Date.now(), tokenId || null);
  return stmts.getDraft.get(id);
}

function listDrafts({ status = 'pending', limit = 50 } = {}) {
  return stmts.listDrafts.all(status, status, limit);
}

function getDraft(id) {
  return stmts.getDraft.get(id);
}

function confirmDraft(id, messageId) {
  const info = stmts.confirmDraft.run(Date.now(), messageId, id);
  return info.changes > 0;
}

function cancelDraft(id) {
  const info = stmts.cancelDraft.run(id);
  return info.changes > 0;
}

function markRead(wacliRowid) {
  stmts.markRead.run(wacliRowid, Date.now());
}

function markUnread(wacliRowid) {
  stmts.markUnread.run(wacliRowid);
}

// Returns a Set of wacli rowids that have been marked read, filtered to the given ids.
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  if (value === null || value === undefined) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  } else {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }
}

function getReadSet(wacliRowids) {
  if (!wacliRowids.length) return new Set();
  const placeholders = wacliRowids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT wacli_rowid FROM message_reads WHERE wacli_rowid IN (${placeholders})`
  ).all(...wacliRowids);
  return new Set(rows.map(r => r.wacli_rowid));
}

// ---------- scheduled messages ----------

function createScheduled({ toNumber, toLabel, body, mediaPath, mediaCaption, mediaFilename, mediaMime, sendAt, recurrence, tokenId }) {
  const info = db.prepare(
    `INSERT INTO scheduled_messages
       (to_number, to_label, body, media_path, media_caption, media_filename, media_mime, send_at, recurrence, token_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(toNumber, toLabel || null, body || null, mediaPath || null, mediaCaption || null, mediaFilename || null, mediaMime || null, sendAt, recurrence || null, tokenId || null, Date.now());
  return info.lastInsertRowid;
}

function listScheduled({ status = null, page = 1, limit = 25 } = {}) {
  const lim = Math.min(200, Math.max(1, limit));
  const off = (Math.max(1, page) - 1) * lim;
  const total = status
    ? db.prepare('SELECT COUNT(*) AS n FROM scheduled_messages WHERE status = ?').get(status).n
    : db.prepare('SELECT COUNT(*) AS n FROM scheduled_messages').get().n;
  const rows = status
    ? db.prepare('SELECT * FROM scheduled_messages WHERE status = ? ORDER BY send_at ASC LIMIT ? OFFSET ?').all(status, lim, off)
    : db.prepare('SELECT * FROM scheduled_messages ORDER BY send_at ASC LIMIT ? OFFSET ?').all(lim, off);
  return { total, page, limit: lim, schedules: rows };
}

function getScheduled(id) {
  return db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id);
}

function disableScheduled(id) {
  return db.prepare("UPDATE scheduled_messages SET status = 'disabled' WHERE id = ? AND status = 'scheduled'").run(id).changes > 0;
}

function enableScheduled(id) {
  return db.prepare("UPDATE scheduled_messages SET status = 'scheduled' WHERE id = ? AND status = 'disabled'").run(id).changes > 0;
}

function deleteScheduled(id) {
  return db.prepare("DELETE FROM scheduled_messages WHERE id = ? AND status != 'fired'").run(id).changes > 0;
}

function pickDueScheduled(now) {
  return db.prepare(
    "SELECT * FROM scheduled_messages WHERE status = 'scheduled' AND send_at <= ? ORDER BY send_at ASC LIMIT 10"
  ).all(now);
}

function fireScheduled(id, nextSendAt, error) {
  if (nextSendAt) {
    db.prepare('UPDATE scheduled_messages SET send_at = ?, last_fired_at = ?, last_error = ? WHERE id = ?')
      .run(nextSendAt, Date.now(), error || null, id);
  } else {
    db.prepare("UPDATE scheduled_messages SET status = 'fired', last_fired_at = ?, last_error = ? WHERE id = ?")
      .run(Date.now(), error || null, id);
  }
}

module.exports = {
  db,
  createToken,
  listTokens,
  findActiveToken,
  deactivateToken,
  enqueueMessage,
  pickDueMessages,
  markSending,
  markSent,
  markFailed,
  markRetry,
  listMessages,
  getMessage,
  resetSendingOnBoot,
  deleteMessage,
  createDraft,
  listDrafts,
  getDraft,
  confirmDraft,
  cancelDraft,
  markRead,
  markUnread,
  getReadSet,
  getSetting,
  setSetting,
  createScheduled,
  listScheduled,
  getScheduled,
  disableScheduled,
  enableScheduled,
  deleteScheduled,
  pickDueScheduled,
  fireScheduled,
};
