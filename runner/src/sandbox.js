'use strict';
// One sandbox container and the conversation with the kernel inside it.
const crypto = require('crypto');
const { nonceLine, cellLine, fileLine, DockerDemuxer, KernelReader } = require('./protocol');

class Sandbox {
  constructor(gate, profile) {
    this.gate = gate;
    this.profile = profile; // 'jshell' | 'check'
    this.id = null;
    this.nonce = crypto.randomBytes(16).toString('hex');
    this.socket = null;
    this.messages = [];
    this.waiters = [];
    this.closed = false;
    this.destroyed = false;
    this.stderrTail = '';
    this.createdAt = Date.now();
    this.ready = false;
  }

  /** Creates, attaches and starts the container; for jshell, waits for the kernel's "ready". */
  async boot({ readyTimeoutMs = 20000 } = {}) {
    this.id = await this.gate.create(this.profile);
    try {
      // Attach before start so no output is missed
      this.socket = await this.gate.attach(this.id);
      const reader = new KernelReader(this.nonce, (m) => this.deliver(m));
      const demux = new DockerDemuxer(
        (chunk) => reader.push(chunk),
        (chunk) => { this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4096); },
      );
      this.socket.on('data', (c) => demux.push(c));
      this.socket.on('close', () => this.markClosed());
      this.socket.on('end', () => this.markClosed());
      this.socket.on('error', () => this.markClosed());
      await this.gate.start(this.id);
      this.write(nonceLine(this.nonce));
      if (this.profile === 'jshell') {
        const m = await this.next(readyTimeoutMs);
        if (!m || m.type !== 'ready') throw new Error(`kernel did not start (${m ? m.type || 'closed' : 'timeout'})`);
      }
      this.ready = true;
      return this;
    } catch (err) {
      await this.destroy();
      throw err;
    }
  }

  write(text) {
    if (this.closed || !this.socket) return false;
    return this.socket.write(text);
  }

  deliver(message) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(message);
    else this.messages.push(message);
  }

  markClosed() {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ type: 'closed' });
  }

  /** Next kernel message, or {type:'closed'} when the container exits, or null on timeout. */
  next(timeoutMs) {
    if (this.messages.length) return Promise.resolve(this.messages.shift());
    if (this.closed) return Promise.resolve({ type: 'closed' });
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const i = this.waiters.indexOf(waiter);
        if (i !== -1) this.waiters.splice(i, 1);
        resolve(null);
      }, Math.max(1, timeoutMs));
      const waiter = (m) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(m);
      };
      this.waiters.push(waiter);
    });
  }

  /** Evaluates one cell. Resolves with the kernel's cell message, {type:'closed'} or null (timeout). */
  async cell(id, source, timeoutMs, input = '') {
    this.write(cellLine(id, source, input));
    return this.next(timeoutMs);
  }

  sendFile(kind, path, content) { this.write(fileLine(kind, path, content)); }
  end() { this.write('END\n'); }

  /** Why the container stopped: {oomKilled, exitCode}. */
  async exitState() {
    try {
      // Give Docker a moment to record the exit
      for (let i = 0; i < 10; i++) {
        const s = await this.gate.inspect(this.id);
        if (!s.running) return { oomKilled: s.oomKilled, exitCode: s.exitCode };
        await new Promise((r) => setTimeout(r, 100));
      }
    } catch { /* container already gone */ }
    return { oomKilled: false, exitCode: null };
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.markClosed();
    if (this.socket) this.socket.destroy();
    if (this.id) {
      try { await this.gate.remove(this.id); } catch (err) { console.error('[runner] could not remove sandbox:', err.message); }
    }
  }
}

module.exports = { Sandbox };
