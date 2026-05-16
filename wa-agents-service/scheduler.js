const db = require('./db');

let cronParser = null;
try { cronParser = require('cron-parser'); } catch (_) {}

const TICK_MS = 60_000;

function nextFireTime(recurrence, fromMs) {
  if (!recurrence) return null;
  if (recurrence === 'daily')   return fromMs + 24 * 60 * 60 * 1000;
  if (recurrence === 'weekly')  return fromMs + 7 * 24 * 60 * 60 * 1000;
  if (recurrence === 'monthly') {
    const d = new Date(fromMs);
    d.setMonth(d.getMonth() + 1);
    return d.getTime();
  }
  if (cronParser) {
    try {
      const interval = cronParser.parseExpression(recurrence, { currentDate: new Date(fromMs) });
      return interval.next().getTime();
    } catch (_) {}
  }
  return null;
}

class Scheduler {
  constructor() {
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    try {
      const due = db.pickDueScheduled(Date.now());
      for (const sched of due) {
        this._enqueue(sched);
      }
    } catch (err) {
      console.error('[scheduler] tick error:', err.message);
    }
  }

  _enqueue(sched) {
    const msgId = db.enqueueMessage({
      to:            sched.to_number,
      body:          sched.body,
      tokenId:       sched.token_id,
      mediaPath:     sched.media_path     || undefined,
      mediaCaption:  sched.media_caption  || undefined,
      mediaFilename: sched.media_filename || undefined,
      mediaMime:     sched.media_mime     || undefined,
    });
    const nextAt = nextFireTime(sched.recurrence, sched.send_at);
    db.fireScheduled(sched.id, nextAt, null);
    console.log(`[${new Date().toISOString()}] scheduler enqueued #${sched.id} → message #${msgId} recurrence=${sched.recurrence || 'once'}`);
  }
}

module.exports = new Scheduler();
