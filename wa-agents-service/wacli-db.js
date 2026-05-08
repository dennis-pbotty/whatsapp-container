// Read-only access to wacli's local SQLite. wacli writes via WAL, so concurrent
// readers don't block. We open with `readonly: true` so we cannot accidentally
// write or migrate the schema.

const fs = require('fs');
const Database = require('better-sqlite3');
const { normalizePhone } = require('./phone');

const WACLI_DB     = process.env.WACLI_DB     || '/data/wacli/wacli.db';
const SESSION_DB   = process.env.WACLI_SESSION_DB || '/data/wacli/session.db';

let _db = null;
function db() {
  if (_db && fs.existsSync(WACLI_DB)) return _db;
  // (re)open lazily so first calls before pairing don't crash the service
  _db = new Database(WACLI_DB, { readonly: true, fileMustExist: true });
  _db.pragma('query_only = ON');
  return _db;
}

let _sessionDb = null;
function sessionDb() {
  if (_sessionDb) return _sessionDb;
  if (!fs.existsSync(SESSION_DB)) return null;
  _sessionDb = new Database(SESSION_DB, { readonly: true, fileMustExist: true });
  _sessionDb.pragma('query_only = ON');
  return _sessionDb;
}

// Returns { "12345678901234@lid": "972501234567@s.whatsapp.net", ... }
function getLidMap() {
  const sdb = sessionDb();
  if (!sdb) return {};
  try {
    const rows = sdb.prepare('SELECT lid, pn FROM whatsmeow_lid_map').all();
    const map = {};
    for (const r of rows) map[`${r.lid}@lid`] = `${r.pn}@s.whatsapp.net`;
    return map;
  } catch (_) { return {}; }
}

function ready() {
  return fs.existsSync(WACLI_DB);
}

// ---------- helpers ----------

const intOr = (v, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
};

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}

// Resolve a phone-or-jid input to a list of candidate JIDs we should match
// against either chat_jid (for DMs) or sender_jid (for any kind of sender).
// Returns an empty array if nothing resolved (so the caller can short-circuit).
function jidsForPhoneOrJid(input) {
  if (!input) return [];
  const s = String(input).trim();
  if (!s) return [];
  // already a JID?
  if (s.endsWith('@s.whatsapp.net') || s.endsWith('@lid') || s.endsWith('@g.us')) {
    return [s];
  }
  const digits = normalizePhone(s);
  if (!digits) return [];
  const out = [`${digits}@s.whatsapp.net`];
  // also pull any @lid contacts whose stored "phone" matches (rare with current
  // WhatsApp privacy, but cheap to look up):
  try {
    const rows = db()
      .prepare(`SELECT jid FROM contacts WHERE phone = ? AND jid LIKE '%@lid'`)
      .all(digits);
    for (const r of rows) out.push(r.jid);
  } catch (_) {}
  return out;
}

// Resolve a name substring to a list of JIDs whose contact name OR pushName
// contains it. Used by sender_name / contact_name query params.
function jidsForName(query) {
  if (!query) return [];
  const q = `%${query}%`;
  const rows = db()
    .prepare(
      `SELECT jid FROM contacts
       WHERE (push_name LIKE @q OR full_name LIKE @q OR first_name LIKE @q OR business_name LIKE @q)
       LIMIT 5000`
    )
    .all({ q });
  return rows.map(r => r.jid);
}

// Resolve a group-name substring to a list of group JIDs.
function jidsForGroupName(query) {
  if (!query) return [];
  const q = `%${query}%`;
  const rows = db()
    .prepare(
      `SELECT jid FROM groups WHERE name LIKE @q
       UNION
       SELECT jid FROM chats WHERE kind = 'group' AND name LIKE @q
       LIMIT 5000`
    )
    .all({ q });
  return Array.from(new Set(rows.map(r => r.jid)));
}

// ---------- public API ----------

function stats() {
  const d = db();
  const one = (sql) => d.prepare(sql).get().n;
  return {
    messages:           one(`SELECT COUNT(*) AS n FROM messages`),
    chats:              one(`SELECT COUNT(*) AS n FROM chats`),
    groups:             one(`SELECT COUNT(*) AS n FROM groups`),
    contacts:           one(`SELECT COUNT(*) AS n FROM contacts`),
    group_participants: one(`SELECT COUNT(*) AS n FROM group_participants`),
    phone_contacts:     one(`SELECT COUNT(*) AS n FROM contacts WHERE jid LIKE '%@s.whatsapp.net'`),
    lid_contacts:       one(`SELECT COUNT(*) AS n FROM contacts WHERE jid LIKE '%@lid'`),
    oldest_msg_ts:      d.prepare(`SELECT MIN(ts) AS t FROM messages`).get().t,
    newest_msg_ts:      d.prepare(`SELECT MAX(ts) AS t FROM messages`).get().t,
  };
}

function listGroups({ q, limit = 200 }) {
  const lim = clamp(intOr(limit, 200), 1, 1000);
  const where = [];
  const params = { lim };
  if (q) { where.push(`(g.name LIKE @q OR g.jid LIKE @q)`); params.q = `%${q}%`; }
  const wsql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db()
    .prepare(
      `SELECT g.jid, g.name, g.owner_jid AS owner_jid,
              c.last_message_ts,
              (SELECT COUNT(*) FROM messages m WHERE m.chat_jid = g.jid) AS msgs,
              (SELECT COUNT(*) FROM group_participants p WHERE p.group_jid = g.jid) AS participants
       FROM groups g
       LEFT JOIN chats c ON c.jid = g.jid
       ${wsql}
       ORDER BY c.last_message_ts DESC NULLS LAST
       LIMIT @lim`
    )
    .all(params);
}

function listGroupParticipants(groupJid) {
  return db()
    .prepare(
      `SELECT p.user_jid, p.role,
              c.phone, c.push_name, c.full_name, c.business_name
       FROM group_participants p
       LEFT JOIN contacts c ON c.jid = p.user_jid
       WHERE p.group_jid = @jid
       ORDER BY (c.full_name IS NULL), c.full_name, p.user_jid`
    )
    .all({ jid: groupJid });
}

function searchContacts({ q, phone, limit = 100 }) {
  const lim = clamp(intOr(limit, 100), 1, 1000);
  const where = [];
  const params = { lim };
  if (q)     { where.push(`(push_name LIKE @q OR full_name LIKE @q OR first_name LIKE @q OR business_name LIKE @q OR jid LIKE @q)`); params.q = `%${q}%`; }
  if (phone) {
    const digits = normalizePhone(phone);
    if (digits) { where.push(`(phone = @ph OR jid = @phJid)`); params.ph = digits; params.phJid = `${digits}@s.whatsapp.net`; }
  }
  const wsql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db()
    .prepare(
      `SELECT jid, phone, push_name, full_name, first_name, business_name, updated_at
       FROM contacts
       ${wsql}
       ORDER BY (full_name IS NULL OR full_name=''), full_name, push_name, jid
       LIMIT @lim`
    )
    .all(params);
}

function listChats({ q, kind, limit = 200 }) {
  const lim = clamp(intOr(limit, 200), 1, 1000);
  const where = [];
  const params = { lim };
  if (q)    { where.push(`(c.name LIKE @q OR c.jid LIKE @q OR co.full_name LIKE @q OR co.push_name LIKE @q)`); params.q = `%${q}%`; }
  if (kind) { where.push(`c.kind = @kind`); params.kind = kind; }
  const wsql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db()
    .prepare(
      `SELECT c.jid, c.kind,
              CASE
                WHEN c.kind = 'dm' THEN COALESCE(co.full_name, co.push_name, co.first_name, co.business_name, c.name)
                ELSE COALESCE(g.name, c.name)
              END AS name,
              c.last_message_ts,
              (SELECT COUNT(*) FROM messages m WHERE m.chat_jid = c.jid) AS msgs
       FROM chats c
       LEFT JOIN groups   g  ON g.jid  = c.jid
       LEFT JOIN contacts co ON co.jid = c.jid
       ${wsql}
       ORDER BY c.last_message_ts DESC NULLS LAST
       LIMIT @lim`
    )
    .all(params);
}

// ---------- THE big one: search messages with rich filters ----------

function searchMessages(opts = {}) {
  const {
    chat,                   // exact chat JID
    chat_name_q,            // substring on chat name (e.g. group name)
    sender,                 // exact sender JID
    sender_name_q,          // substring on sender_name OR contact name
    contact_name_q,         // substring on contact name (push_name/full_name/etc.)
    phone,                  // phone (any format) — matches DMs OR group senders
    q,                      // FTS5 content query
    from_me,                // 'true' | 'false' | undefined
    kind,                   // 'dm' | 'group' | undefined (matches chats.kind)
    since,                  // unix seconds
    until,                  // unix seconds
    limit = 100,
    offset = 0,
    order  = 'desc',
  } = opts;

  const where  = [];
  const params = {};
  const fromExtra = [];

  if (chat)          { where.push(`m.chat_jid = @chat`);                                      params.chat = chat; }
  if (sender)        { where.push(`m.sender_jid = @sender`);                                  params.sender = sender; }
  if (from_me === 'true')  where.push(`m.from_me = 1`);
  if (from_me === 'false') where.push(`m.from_me = 0`);
  if (since !== undefined) { where.push(`m.ts >= @since`); params.since = intOr(since, 0); }
  if (until !== undefined) { where.push(`m.ts <= @until`); params.until = intOr(until, 0); }

  if (kind)          { where.push(`ch.kind = @kind`);                                         params.kind = kind; }
  if (chat_name_q)   { where.push(`(ch.name LIKE @chatNameQ OR g.name LIKE @chatNameQ)`);     params.chatNameQ = `%${chat_name_q}%`; }
  if (sender_name_q) { where.push(`(m.sender_name LIKE @snq OR co.push_name LIKE @snq OR co.full_name LIKE @snq)`); params.snq = `%${sender_name_q}%`; }

  // contact_name_q: resolve to a set of JIDs, then constrain sender_jid OR chat_jid
  if (contact_name_q) {
    const jids = jidsForName(contact_name_q);
    if (!jids.length) return { total: 0, limit: 0, offset: 0, rows: [], filter_resolution: { contact_name_q: 'no contacts matched' } };
    const placeholders = jids.map((_, i) => `@cn${i}`).join(',');
    jids.forEach((j, i) => (params[`cn${i}`] = j));
    where.push(`(m.sender_jid IN (${placeholders}) OR m.chat_jid IN (${placeholders}))`);
  }

  // phone: resolve to JIDs and constrain sender_jid OR chat_jid
  if (phone) {
    const jids = jidsForPhoneOrJid(phone);
    if (!jids.length) return { total: 0, limit: 0, offset: 0, rows: [], filter_resolution: { phone: 'could not resolve to a JID' } };
    const placeholders = jids.map((_, i) => `@ph${i}`).join(',');
    jids.forEach((j, i) => (params[`ph${i}`] = j));
    where.push(`(m.sender_jid IN (${placeholders}) OR m.chat_jid IN (${placeholders}))`);
  }

  // FTS5 query — join messages_fts on rowid
  let ftsJoin = '';
  if (q) {
    ftsJoin = `JOIN messages_fts fts ON fts.rowid = m.rowid AND messages_fts MATCH @ftsq`;
    params.ftsq = q;
  }

  const ord    = order === 'asc' ? 'ASC' : 'DESC';
  const lim    = clamp(intOr(limit, 100), 1, 500);
  const off    = clamp(intOr(offset, 0), 0, 1_000_000);
  params._lim  = lim;
  params._off  = off;

  const wsql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const baseSql = `
    FROM messages m
    LEFT JOIN chats    ch      ON ch.jid     = m.chat_jid
    LEFT JOIN groups   g       ON g.jid      = m.chat_jid
    LEFT JOIN contacts co      ON co.jid     = m.sender_jid
    LEFT JOIN contacts co_chat ON co_chat.jid = m.chat_jid
    ${ftsJoin}
    ${wsql}
  `;

  const total = db().prepare(`SELECT COUNT(*) AS n ${baseSql}`).get(params).n;
  const rows  = db()
    .prepare(
      `SELECT
         m.rowid AS id,
         m.msg_id, m.chat_jid, ch.kind AS chat_kind,
         CASE
           WHEN ch.kind = 'dm' THEN COALESCE(co_chat.full_name, co_chat.push_name, co_chat.first_name, co_chat.business_name, ch.name)
           ELSE COALESCE(g.name, ch.name)
         END AS chat_name,
         m.sender_jid,
         COALESCE(NULLIF(m.sender_name,''), co.full_name, co.push_name, co.first_name) AS sender_name,
         co.phone AS sender_phone,
         m.from_me, m.ts, m.text, m.display_text,
         m.media_type, m.media_caption, m.filename, m.mime_type
       ${baseSql}
       ORDER BY m.ts ${ord}, m.rowid ${ord}
       LIMIT @_lim OFFSET @_off`
    )
    .all(params);

  return { total, limit: lim, offset: off, rows };
}

function getMessageById(rowid) {
  return db()
    .prepare(
      `SELECT rowid, msg_id, chat_jid, media_type, mime_type, filename,
              direct_path, media_key
       FROM messages WHERE rowid = ?`
    )
    .get(rowid);
}

function maxMessageRowid() {
  const row = db().prepare('SELECT MAX(rowid) AS n FROM messages').get();
  return row && row.n != null ? row.n : 0;
}

function getIncomingAfterRowid(rowid, limit = 50) {
  return db()
    .prepare(
      `SELECT m.rowid AS id, m.msg_id, m.chat_jid, ch.kind AS chat_kind,
              COALESCE(g.name, ch.name) AS chat_name,
              m.sender_jid,
              COALESCE(NULLIF(m.sender_name,''), co.full_name, co.push_name, co.first_name) AS sender_name,
              co.phone AS sender_phone,
              m.ts, m.text, m.display_text, m.media_type, m.media_caption
       FROM messages m
       LEFT JOIN chats    ch ON ch.jid = m.chat_jid
       LEFT JOIN groups   g  ON g.jid  = m.chat_jid
       LEFT JOIN contacts co ON co.jid = m.sender_jid
       WHERE m.rowid > @rowid AND m.from_me = 0
       ORDER BY m.rowid ASC
       LIMIT @limit`
    )
    .all({ rowid, limit });
}

module.exports = {
  ready,
  getLidMap,
  stats,
  listGroups,
  listGroupParticipants,
  searchContacts,
  listChats,
  searchMessages,
  getMessageById,
  maxMessageRowid,
  getIncomingAfterRowid,
  // exposed for tests / debugging:
  jidsForPhoneOrJid,
  jidsForName,
  jidsForGroupName,
};
