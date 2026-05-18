const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const { WACLI_BIN, storeArgs } = require('./wacli');

const BASE_RESTART_MS  = 10_000;   // first retry after 10s
const MAX_RESTART_MS   = 300_000;  // cap at 5 minutes
// If sync stays alive at least this long, reset the backoff counter.
const STABLE_UPTIME_MS = 60_000;

// Lines containing any of these substrings count as "activity" — used to mark
// the process as alive and emit periodic synced events.
const ACTIVITY_PATTERNS = [
  /sync/i,
  /history/i,
  /message/i,
  /chat/i,
  /contact/i,
  /connected/i,
  /reconnect/i,
];

class SyncManager extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.restarts = 0;
    this.stopped = false;
    this.lastActivity = null;
    this._restartTimer = null;
    this._consecutiveFailures = 0;
    this._spawnedAt = null;
  }

  status() {
    return {
      running: !!this.child,
      restarts: this.restarts,
      pid: this.child ? this.child.pid : null,
      lastActivityAt: this.lastActivity,
    };
  }

  start() {
    if (this.child) return;
    this.stopped = false;
    this._spawn();
  }

  stop() {
    this.stopped = true;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
        resolve();
      }, 5_000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      try { child.kill('SIGTERM'); } catch (_) { clearTimeout(timer); resolve(); }
    });
  }

  _spawn() {
    const args = [...storeArgs(), 'sync', '--follow', '--refresh-contacts', '--refresh-groups'];
    let child;
    try {
      child = spawn(WACLI_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this.emit('error', err);
      this._scheduleRestart();
      return;
    }
    this.child = child;
    this._spawnedAt = Date.now();
    this.emit('connected', { pid: child.pid });

    const onLine = (line) => {
      if (!line) return;
      if (ACTIVITY_PATTERNS.some((re) => re.test(line))) {
        this.lastActivity = Date.now();
        this.emit('synced', { line, at: this.lastActivity });
      }
    };

    const handleStream = (stream) => {
      let buf = '';
      stream.on('data', (d) => {
        buf += d.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          onLine(line);
        }
      });
    };

    handleStream(child.stdout);
    handleStream(child.stderr);

    child.on('error', (err) => {
      this.emit('error', err);
    });

    child.on('close', (code, signal) => {
      const uptime = this._spawnedAt ? Date.now() - this._spawnedAt : 0;
      this.child = null;
      this._spawnedAt = null;
      // Reset backoff if the process was stable for long enough before exiting.
      if (uptime >= STABLE_UPTIME_MS) {
        this._consecutiveFailures = 0;
      }
      this.emit('error', new Error(`sync exited (code=${code} signal=${signal})`));
      if (!this.stopped) {
        this._scheduleRestart();
      }
    });
  }

  _scheduleRestart() {
    if (this.stopped) return;
    if (this._restartTimer) return;
    this.restarts += 1;
    this._consecutiveFailures += 1;
    // Exponential backoff: 10s → 20s → 40s → … capped at 5 min.
    const delay = Math.min(BASE_RESTART_MS * Math.pow(2, this._consecutiveFailures - 1), MAX_RESTART_MS);
    this.emit('reconnecting', { in: delay, restarts: this.restarts });
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (!this.stopped) this._spawn();
    }, delay);
  }
}

module.exports = new SyncManager();
