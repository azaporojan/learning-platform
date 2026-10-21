'use strict';
// What a run, a check and a teacher session actually do with a sandbox.
const crypto = require('crypto');

const MB = (profileMemory) => `${profileMemory} MB`;

function messages({ timeoutMs, memoryMb }) {
  return {
    timeout: `Stopped after ${Math.round(timeoutMs / 1000)} s. An infinite loop, or waiting for input that never comes?`,
    oom: `Stopped: the code used more than ${MB(memoryMb)} of memory.`,
    crashed: 'The Java process stopped before the cell finished (System.exit, or a crash).',
  };
}

function cellResult(index, m) {
  return {
    index,
    status: m.status === 'ok' ? 'ok' : 'error',
    stdout: m.stdout || '',
    stderr: m.stderr || '',
    value: m.value === undefined ? null : m.value,
    error: m.error || null,
    truncated: Boolean(m.truncated),
    durationMs: m.durationMs || 0,
  };
}

const failedCell = (index, status, message) => ({
  index, status, stdout: '', stderr: '', value: null, error: { kind: status, message, line: null }, truncated: false, durationMs: 0,
});

const notRun = (index) => ({ index, status: 'not_run', stdout: '', stderr: '', value: null, error: null, truncated: false, durationMs: 0 });

/**
 * Evaluates cells in order in one sandbox and stops at the first failing cell. A cell is its source,
 * or {source, input} where input is what System.in reads during that cell.
 * Returns {status, cells[], durationMs}; status is the status of the last evaluated cell.
 */
async function evaluateCells(sandbox, cells, { timeoutMs, memoryMb, startIndex = 0 }) {
  const text = messages({ timeoutMs, memoryMb });
  const started = Date.now();
  const deadline = started + timeoutMs;
  const results = [];
  let status = 'ok';
  for (let i = 0; i < cells.length; i++) {
    const index = startIndex + i;
    const left = deadline - Date.now();
    const { source, input } = typeof cells[i] === 'string' ? { source: cells[i], input: '' } : cells[i];
    const m = left > 0 ? await sandbox.cell(String(index), source, left, input || '') : null;
    if (m === null) {
      status = 'timeout';
      results.push(failedCell(index, 'timeout', text.timeout));
      break;
    }
    if (m.type === 'closed') {
      const exit = await sandbox.exitState();
      status = exit.oomKilled ? 'oom' : 'crashed';
      results.push(failedCell(index, status, exit.oomKilled ? text.oom : text.crashed));
      break;
    }
    const r = cellResult(index, m);
    results.push(r);
    if (r.status === 'error') { status = 'error'; break; }
  }
  for (let i = results.length; i < cells.length; i++) results.push(notRun(startIndex + i));
  return { status, cells: results, durationMs: Date.now() - started };
}

class Executor {
  constructor({ pool, limits }) {
    this.pool = pool;
    this.limits = limits; // {runTimeoutMs, checkTimeoutMs, maxCheckTimeoutMs, queueWaitMs, jshellMemoryMb, checkMemoryMb}
  }

  async runNotebook(cells, { requestId } = {}) {
    const lease = await this.pool.acquire('jshell', { priority: 0, requestId, waitMs: this.limits.queueWaitMs });
    try {
      const r = await evaluateCells(lease.sandbox, cells, { timeoutMs: this.limits.runTimeoutMs, memoryMb: this.limits.jshellMemoryMb });
      return { ...r, warm: lease.warm, queuedMs: lease.queuedMs };
    } finally {
      lease.sandbox.end();
      await this.pool.release(lease.sandbox);
    }
  }

  async runCheck(files, tests, { timeoutMs } = {}) {
    const limit = Math.min(this.limits.maxCheckTimeoutMs, Math.max(5000, timeoutMs || this.limits.checkTimeoutMs));
    const text = messages({ timeoutMs: limit, memoryMb: this.limits.checkMemoryMb });
    const lease = await this.pool.acquire('check', { priority: 1, waitMs: this.limits.checkQueueWaitMs });
    const sb = lease.sandbox;
    const started = Date.now();
    try {
      for (const f of files) sb.sendFile('FILE', f.path, f.content);
      for (const t of tests) sb.sendFile('TEST', t.path, t.content);
      sb.end();
      const m = await sb.next(limit);
      const base = { durationMs: Date.now() - started, queuedMs: lease.queuedMs, diagnostics: null, tests: null, stdout: '' };
      if (m === null) return { ...base, status: 'timeout', summary: text.timeout };
      if (m.type === 'closed') {
        const exit = await sb.exitState();
        return { ...base, status: exit.oomKilled ? 'oom' : 'crashed', summary: exit.oomKilled ? text.oom : text.crashed };
      }
      return {
        ...base,
        status: m.status,
        summary: m.summary,
        diagnostics: m.diagnostics || null,
        tests: m.tests || null,
        stdout: m.stdout || '',
        truncated: Boolean(m.truncated),
      };
    } finally {
      await this.pool.release(sb);
    }
  }
}

// ---------------------------------------------------------------------------
// Teacher sessions: a jshell kernel that stays alive between cells (state is kept), with an idle
// timeout. A cell that times out or crashes ends the session.
// ---------------------------------------------------------------------------
class SessionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

class Sessions {
  constructor({ pool, limits, log = console }) {
    this.pool = pool;
    this.limits = limits; // {maxSessions, sessionIdleMs, runTimeoutMs, jshellMemoryMb, queueWaitMs}
    this.log = log;
    this.byId = new Map();
  }

  list() {
    return [...this.byId.values()].map((s) => this.describe(s));
  }

  describe(s) {
    return {
      id: s.id,
      owner: s.owner,
      createdAt: new Date(s.createdAt).toISOString(),
      lastUsedAt: new Date(s.lastUsed).toISOString(),
      executionCount: s.count,
      busy: s.busy,
      idleTimeoutMs: this.limits.sessionIdleMs,
    };
  }

  forOwner(owner) {
    for (const s of this.byId.values()) if (s.owner === owner) return s;
    return null;
  }

  async open(owner) {
    const existing = this.forOwner(owner);
    if (existing) return this.describe(existing);
    if (this.byId.size >= this.limits.maxSessions) {
      throw new SessionError('session_limit', `At most ${this.limits.maxSessions} live sessions can run at once. Close one, or run without a session.`);
    }
    const lease = await this.pool.acquire('jshell', { priority: 0, waitMs: this.limits.queueWaitMs });
    // Opens race while they wait for a sandbox: the same owner keeps the first, and the session
    // ceiling is checked again now that this one is about to exist
    const raced = this.forOwner(owner);
    if (raced) { lease.sandbox.end(); await this.pool.release(lease.sandbox); return this.describe(raced); }
    if (this.byId.size >= this.limits.maxSessions) {
      lease.sandbox.end();
      await this.pool.release(lease.sandbox);
      throw new SessionError('session_limit', `At most ${this.limits.maxSessions} live sessions can run at once. Close one, or run without a session.`);
    }
    const s = { id: crypto.randomUUID(), owner, sandbox: lease.sandbox, createdAt: Date.now(), lastUsed: Date.now(), count: 0, busy: false };
    this.byId.set(s.id, s);
    return this.describe(s);
  }

  async run(id, owner, source, input = '') {
    const s = this.byId.get(id);
    if (!s || s.owner !== owner) throw new SessionError('no_session', 'This session has ended. Start a new one.');
    if (s.busy) throw new SessionError('busy', 'A cell is still running in this session.');
    s.busy = true;
    try {
      s.count += 1;
      const r = await evaluateCells(s.sandbox, [{ source, input }], {
        timeoutMs: this.limits.runTimeoutMs, memoryMb: this.limits.jshellMemoryMb, startIndex: s.count,
      });
      s.lastUsed = Date.now();
      const ended = r.status === 'timeout' || r.status === 'oom' || r.status === 'crashed';
      if (ended) await this.close(id);
      return { ...r.cells[0], executionCount: s.count, sessionEnded: ended };
    } finally {
      s.busy = false;
    }
  }

  async close(id) {
    const s = this.byId.get(id);
    if (!s) return false;
    this.byId.delete(id);
    s.sandbox.end();
    await this.pool.release(s.sandbox);
    return true;
  }

  async sweep() {
    const now = Date.now();
    for (const s of [...this.byId.values()]) {
      if (!s.busy && (now - s.lastUsed > this.limits.sessionIdleMs || s.sandbox.closed)) {
        await this.close(s.id).catch((err) => this.log.error('[runner] session close failed:', err.message));
      }
    }
  }

  async shutdown() {
    await Promise.all([...this.byId.keys()].map((id) => this.close(id).catch(() => {})));
  }
}

module.exports = { Executor, Sessions, SessionError, evaluateCells };
