const { EventEmitter } = require('events');
const db = require('./db');
const wacli = require('./wacli');
const sync = require('./sync');

const TICK_MS = 10_000;
const BATCH_SIZE = 5;
const BASE_BACKOFF_MS = 30_000;

class MessageQueue extends EventEmitter {
  constructor() {
    super();
    this.timer = null;
    this.running = false;
    this.processing = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    db.resetSendingOnBoot();
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.processing) return;
    this.processing = true;
    try {
      const due = db.pickDueMessages(Date.now(), BATCH_SIZE);
      if (!due.length) return;

      // wacli uses an exclusive store lock — sync holds it while running.
      // Await sync.stop() so the process fully exits and releases the lock before sending.
      await sync.stop();

      try {
        for (const msg of due) {
          await this.processMessage(msg);
        }
      } finally {
        sync.start();
      }
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.processing = false;
    }
  }

  async processMessage(msg) {
    db.markSending(msg.id);
    this.emit('message:sending', { id: msg.id });

    const result = msg.media_path
      ? await wacli.sendFile(msg.to_number, msg.media_path, {
          caption:  msg.media_caption  || undefined,
          filename: msg.media_filename || undefined,
          mime:     msg.media_mime     || undefined,
        })
      : await wacli.sendMessage(msg.to_number, msg.body);

    if (result.ok) {
      db.markSent(msg.id);
      this.emit('message:sent', { id: msg.id });
      return;
    }

    const retries = msg.retries + 1;
    const error = result.error || 'unknown error';
    if (retries < msg.max_retries) {
      const backoff = BASE_BACKOFF_MS * Math.pow(2, retries - 1);
      const nextRetryAt = Date.now() + backoff;
      db.markRetry(msg.id, nextRetryAt, error);
      this.emit('message:retry', { id: msg.id, retries, nextRetryAt, error });
    } else {
      db.markFailed(msg.id, error);
      this.emit('message:failed', { id: msg.id, error });
    }
  }
}

module.exports = new MessageQueue();
