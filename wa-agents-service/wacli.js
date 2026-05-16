const { spawn } = require('child_process');

const WACLI_BIN = process.env.WACLI_BIN || 'wacli';
// Set WACLI_STORE_DIR (or WACLI_STORE) to override ~/.wacli.
// In Docker this points to /data/wacli so everything lives in the data volume.
const WACLI_STORE = process.env.WACLI_STORE_DIR || process.env.WACLI_STORE || null;

const STATUS_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 60_000;
const QR_TIMEOUT_MS = 30_000;

function storeArgs() {
  return WACLI_STORE ? ['--store', WACLI_STORE] : [];
}

function runWacli(args, { timeoutMs = STATUS_TIMEOUT_MS } = {}) {
  const fullArgs = [...storeArgs(), ...args];
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(WACLI_BIN, fullArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve({ ok: false, code: null, stdout, stderr: stderr || `timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

async function checkStatus() {
  const res = await runWacli(['auth', 'status', '--json']);
  if (!res.ok) {
    return { authenticated: false, phone: null, error: res.stderr || `exit ${res.code}` };
  }
  try {
    const parsed = JSON.parse(res.stdout);
    const data = parsed.data || {};
    return {
      authenticated: !!data.authenticated,
      phone: data.phone || data.jid || null,
    };
  } catch (e) {
    return { authenticated: false, phone: null, error: 'parse error: ' + e.message };
  }
}

// ----- QR session manager -----
// To minimize pairing attempts to WhatsApp (which can trigger anti-abuse bans),
// we keep ONE long-lived `wacli auth` process alive and cache its latest QR.
// Repeated /api/qr calls reuse the cached QR or the same process — they do NOT
// open new pairing sessions to WhatsApp.
const QR_CACHE_TTL_MS = 25_000;       // WA QRs rotate ~20s; cache slightly longer
const QR_PROCESS_IDLE_S = 90;         // how long wacli auth stays alive idle
const QR_WAIT_TIMEOUT_MS = 8_000;     // max wait for fresh QR when none cached

let qrProc = null;
let qrBuffer = '';
let qrLast = null;
let qrLastAt = 0;

function killQrProc() {
  if (qrProc) {
    try { qrProc.kill('SIGTERM'); } catch (_) {}
    qrProc = null;
  }
  qrBuffer = '';
}

function clearQrSession() {
  killQrProc();
  qrLast = null;
  qrLastAt = 0;
}

function startQrProc() {
  if (qrProc) return;
  qrBuffer = '';
  const storeFlag = WACLI_STORE ? `--store ${WACLI_STORE} ` : '';
  const cmd = `${WACLI_BIN} ${storeFlag}auth --idle-exit ${QR_PROCESS_IDLE_S}s`;
  const child = spawn('script', ['-q', '-c', cmd, '/dev/null'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  qrProc = child;

  const onData = (d) => {
    qrBuffer += d.toString();
    if (qrBuffer.length > 32_768) qrBuffer = qrBuffer.slice(-32_768);
    const qr = extractQR(qrBuffer);
    if (qr && qr.split('\n').length >= 20) {
      qrLast = qr;
      qrLastAt = Date.now();
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', () => { if (qrProc === child) qrProc = null; });
  child.on('exit', () => { if (qrProc === child) { qrProc = null; qrBuffer = ''; } });
}

/**
 * Returns a unicode-art QR for pairing, or null if already authenticated.
 * Reuses a single long-lived wacli auth process — does NOT spawn a new pairing
 * session for every call. QR is cached for 25s (WA rotates them every ~20s).
 */
async function getQR() {
  const status = await checkStatus();
  if (status.authenticated) {
    clearQrSession();
    return null;
  }

  // Return cached QR if recent
  if (qrLast && Date.now() - qrLastAt < QR_CACHE_TTL_MS) {
    return qrLast;
  }

  // Start the singleton process if not running
  if (!qrProc) startQrProc();

  // Wait briefly for the buffer to yield a fresh QR
  const waitStart = Date.now();
  while (Date.now() - waitStart < QR_WAIT_TIMEOUT_MS) {
    if (qrLast && Date.now() - qrLastAt < QR_CACHE_TTL_MS) return qrLast;
    await new Promise((r) => setTimeout(r, 250));
  }
  return qrLast || null;
}

/**
 * Extracts the QR unicode-art block from wacli output.
 * Strips ANSI escape codes and CR (added by script(1)), then finds the
 * largest contiguous run of lines consisting only of block-element characters.
 */
function extractQR(text) {
  if (!text) return null;
  // Strip ANSI sequences and carriage returns
  const clean = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
  const lines = clean.split('\n');
  // Unicode block elements U+2580-U+259F plus FULL BLOCK and space
  const blockLine = /^[▀-▟█ ]+$/;
  let best = [];
  let cur = [];
  for (const line of lines) {
    if (line.length > 8 && blockLine.test(line)) {
      cur.push(line);
    } else {
      if (cur.length > best.length) best = cur;
      cur = [];
    }
  }
  if (cur.length > best.length) best = cur;
  if (best.length < 6) return null;
  return best.join('\n');
}

async function sendFile(to, filePath, { caption, filename, mime } = {}) {
  const args = ['send', 'file', '--to', String(to), '--file', filePath, '--json'];
  if (caption)  args.push('--caption',  String(caption));
  if (filename) args.push('--filename', String(filename));
  if (mime)     args.push('--mime',     String(mime));
  const res = await runWacli(args, { timeoutMs: 120_000 });
  const parsed = tryParseJSON(res.stdout);
  if (parsed && typeof parsed === 'object') {
    if (parsed.success === false) {
      const errMsg = typeof parsed.error === 'string'
        ? parsed.error
        : (parsed.error && parsed.error.message) || JSON.stringify(parsed.error || {});
      return { ok: false, error: errMsg };
    }
    if (parsed.success === true || res.ok) return { ok: true, data: parsed.data || null };
  }
  if (!res.ok) return { ok: false, error: (res.stderr || res.stdout || `exit ${res.code}`).trim() };
  return { ok: true, data: null };
}

async function sendMessage(to, body) {
  const res = await runWacli(
    ['send', 'text', '--to', String(to), '--message', String(body), '--json'],
    { timeoutMs: SEND_TIMEOUT_MS }
  );
  const parsed = tryParseJSON(res.stdout);
  if (parsed && typeof parsed === 'object') {
    if (parsed.success === false) {
      const errMsg = typeof parsed.error === 'string'
        ? parsed.error
        : (parsed.error && parsed.error.message) || JSON.stringify(parsed.error || {});
      return { ok: false, error: errMsg };
    }
    if (parsed.success === true || res.ok) {
      return { ok: true, data: parsed.data || null };
    }
  }
  if (!res.ok) {
    return { ok: false, error: (res.stderr || res.stdout || `exit ${res.code}`).trim() };
  }
  return { ok: true, data: null };
}

function tryParseJSON(s) {
  try { return JSON.parse(s); } catch (_) { return null; }
}

function pollConnection(intervalMs, { onDisconnect, onReconnect, onStatus } = {}) {
  let lastConnected = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    const s = await checkStatus();
    if (typeof onStatus === 'function') onStatus(s);
    if (lastConnected === null) {
      lastConnected = s.authenticated;
      // Kill any orphaned QR session on startup if already authenticated
      if (s.authenticated) clearQrSession();
    } else if (lastConnected && !s.authenticated) {
      lastConnected = false;
      if (typeof onDisconnect === 'function') onDisconnect(s);
    } else if (!lastConnected && s.authenticated) {
      lastConnected = true;
      // Pairing succeeded — tear down the QR process so no further QRs are issued
      clearQrSession();
      if (typeof onReconnect === 'function') onReconnect(s);
    }
  };

  tick();
  const handle = setInterval(tick, intervalMs);
  return () => { stopped = true; clearInterval(handle); };
}

async function refreshContacts() {
  return runWacli(['contacts', 'refresh', '--json'], { timeoutMs: 30_000 });
}

module.exports = { checkStatus, getQR, sendMessage, sendFile, pollConnection, clearQrSession, refreshContacts, WACLI_BIN, storeArgs };
