const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const { WACLI_BIN, storeArgs } = require('./wacli');

const RESTART_DELAY_MS = 10_000;
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
    if (this.child) {
      try { this.child.kill('SIGTERM'); } catch (_) {}
      this.child = null;
    }
  }

  _spawn() {
    const args = [...storeArgs(), 'sync', '--follow', '--refresh-contacts'];
    let child;
    try {
      child = spawn(WACLI_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this.emit('error', err);
      this._scheduleRestart();
      return;
    }
    this.child = child;
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
      this.child = null;
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
    this.emit('reconnecting', { in: RESTART_DELAY_MS, restarts: this.restarts });
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (!this.stopped) this._spawn();
    }, RESTART_DELAY_MS);
  }
}

module.exports = new SyncManager();
