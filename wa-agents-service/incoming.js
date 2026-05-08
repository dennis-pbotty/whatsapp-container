const { EventEmitter } = require('events');
const wdb = require('./wacli-db');

const POLL_MS = parseInt(process.env.INCOMING_POLL_MS || '4000', 10);

class IncomingWatcher extends EventEmitter {
  constructor() {
    super();
    this._timer = null;
    this._watermark = null; // last seen rowid; null = not yet initialized
    this._stopped = false;
  }

  start() {
    this._stopped = false;
    this._initWatermark();
    this._timer = setInterval(() => this._poll(), POLL_MS);
  }

  stop() {
    this._stopped = true;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  // Trigger an immediate check without waiting for the next interval tick.
  check() {
    this._poll();
  }

  _initWatermark() {
    if (!wdb.ready()) {
      // DB doesn't exist yet (device not paired) — retry until it appears.
      setTimeout(() => { if (!this._stopped) this._initWatermark(); }, 5_000);
      return;
    }
    try {
      this._watermark = wdb.maxMessageRowid();
    } catch (_) {
      this._watermark = 0;
    }
  }

  _poll() {
    if (this._stopped || this._watermark === null || !wdb.ready()) return;
    try {
      const rows = wdb.getIncomingAfterRowid(this._watermark);
      for (const row of rows) {
        this.emit('message', row);
      }
      if (rows.length > 0) {
        this._watermark = rows[rows.length - 1].id;
      }
    } catch (_) {}
  }
}

module.exports = new IncomingWatcher();
