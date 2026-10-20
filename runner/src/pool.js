'use strict';
// Capacity for sandbox containers.
//
// Every container counts against one ceiling (maxContainers), whatever it is doing: booting,
// waiting warm, running a request, or held by a teacher session. Warm containers are jshell
// kernels already booted, so a notebook run starts in about 100 ms; they are only kept when the
// capacity is free, and a check that needs room takes one down. Requests beyond the ceiling wait
// in a queue (notebook runs before checks) and fail with BusyError after waitMs.

class BusyError extends Error {
  constructor(message) {
    super(message || 'The runner is busy. Try again in a moment.');
    this.code = 'busy';
  }
}

class Pool {
  constructor({ makeSandbox, maxContainers = 4, warmTarget = 2, warmMaxAgeMs = 20 * 60 * 1000, log = console }) {
    this.makeSandbox = makeSandbox;
    this.maxContainers = maxContainers;
    this.warmTarget = Math.min(warmTarget, maxContainers);
    this.warmMaxAgeMs = warmMaxAgeMs;
    this.log = log;
    this.live = 0; // booting + warm + leased
    this.warm = [];
    this.bootingWarm = 0;
    this.queue = [];
    this.seq = 0;
    this.stopped = false;
    this.booting = new Set(); // in-flight boots, awaited on shutdown
    this.leased = new Set(); // handed to a request or session, until released
  }

  track(promise) {
    this.booting.add(promise);
    const done = () => this.booting.delete(promise);
    promise.then(done, done);
    return promise;
  }

  stats() {
    return {
      live: this.live,
      warm: this.warm.length,
      bootingWarm: this.bootingWarm,
      queued: this.queue.length,
      maxContainers: this.maxContainers,
    };
  }

  queuePosition(requestId) {
    if (!requestId) return 0;
    const i = this.ordered().findIndex((q) => q.requestId === requestId);
    return i === -1 ? 0 : i + 1;
  }

  ordered() {
    return [...this.queue].sort((a, b) => a.priority - b.priority || a.seq - b.seq);
  }

  /**
   * Resolves with {sandbox, warm, queuedMs}. profile: 'jshell' | 'check'.
   * priority 0 = interactive (notebook runs, sessions), 1 = background (checks).
   */
  acquire(profile, { priority = 0, requestId = null, waitMs = 20000 } = {}) {
    return new Promise((resolve, reject) => {
      const entry = { profile, priority, requestId, resolve, reject, seq: this.seq++, enqueuedAt: Date.now() };
      entry.timer = setTimeout(() => {
        const i = this.queue.indexOf(entry);
        if (i === -1) return;
        this.queue.splice(i, 1);
        reject(new BusyError());
      }, waitMs);
      this.queue.push(entry);
      this.schedule();
    });
  }

  /** Single use: a sandbox that ran student code is always destroyed. */
  async release(sandbox) {
    this.leased.delete(sandbox);
    try { await sandbox.destroy(); } finally {
      this.live -= 1;
      this.schedule();
    }
  }

  takeWarm() {
    while (this.warm.length) {
      const sb = this.warm.shift();
      if (!sb.closed) return sb;
      // died while waiting (killed by the host, swept): free its place
      this.live -= 1;
      sb.destroy().catch(() => {});
    }
    return null;
  }

  serve(entry, sandbox, warm) {
    clearTimeout(entry.timer);
    this.leased.add(sandbox);
    entry.resolve({ sandbox, warm, queuedMs: Date.now() - entry.enqueuedAt });
  }

  schedule() {
    if (this.stopped) return;
    for (;;) {
      const head = this.ordered()[0];
      if (!head) break;
      if (head.profile === 'jshell') {
        const sb = this.takeWarm();
        if (sb) {
          this.queue.splice(this.queue.indexOf(head), 1);
          this.serve(head, sb, true);
          continue;
        }
      }
      if (this.live < this.maxContainers) {
        this.queue.splice(this.queue.indexOf(head), 1);
        this.live += 1;
        this.bootFor(head);
        continue;
      }
      // Full: a waiting request beats an idle warm container
      if (this.warm.length) {
        const idle = this.warm.shift();
        this.live -= 1;
        idle.destroy().catch(() => {});
        continue;
      }
      break;
    }
    this.refill();
  }

  bootFor(entry) {
    const sb = this.makeSandbox(entry.profile);
    this.track(sb.boot()).then(
      () => this.serve(entry, sb, false),
      (err) => {
        this.live -= 1;
        clearTimeout(entry.timer);
        entry.reject(err);
        this.schedule();
      },
    );
  }

  refill() {
    if (this.stopped || this.queue.length) return;
    while (this.live < this.maxContainers && this.warm.length + this.bootingWarm < this.warmTarget) {
      this.live += 1;
      this.bootingWarm += 1;
      const sb = this.makeSandbox('jshell');
      this.track(sb.boot()).then(
        () => {
          this.bootingWarm -= 1;
          if (this.stopped) { this.live -= 1; sb.destroy().catch(() => {}); return; }
          this.warm.push(sb);
          this.schedule();
        },
        (err) => {
          this.bootingWarm -= 1;
          this.live -= 1;
          this.log.error('[runner] warm sandbox failed to boot:', err.message);
          // do not spin on a broken image: retry on the next request or recycle tick
        },
      );
    }
  }

  /** Replaces warm containers older than warmMaxAgeMs (called on a timer). */
  recycle() {
    const now = Date.now();
    const keep = [];
    for (const sb of this.warm) {
      if (sb.closed || now - sb.createdAt > this.warmMaxAgeMs) {
        this.live -= 1;
        sb.destroy().catch(() => {});
      } else keep.push(sb);
    }
    this.warm = keep;
    this.schedule();
  }

  async shutdown() {
    this.stopped = true;
    for (const q of this.queue.splice(0)) { clearTimeout(q.timer); q.reject(new BusyError('The runner is shutting down.')); }
    // A warm boot finishing after this point destroys its own sandbox (see refill)
    await Promise.allSettled([...this.booting]);
    await Promise.all(this.warm.splice(0).map((sb) => sb.destroy().catch(() => {})));
  }
}

module.exports = { Pool, BusyError };
