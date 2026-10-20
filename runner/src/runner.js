'use strict';
// =============================================================================
// Runner API. Called by the Learning Platform server only (bearer RUNNER_TOKEN); never public.
//
//   GET    /health                       {ok}
//   GET    /stats                        pool + sessions
//   POST   /run          {cells: [string], requestId?}   run-to-here, stateless
//   GET    /queue/:requestId             {position}      0 = not waiting (running or done)
//   POST   /check        {files: [{path, content}], tests: [{path, content}], timeoutMs?}
//   GET    /sessions                     live teacher sessions
//   POST   /sessions     {owner}         open (or return) the owner's session
//   POST   /sessions/:id/cells  {owner, source}   evaluate one cell, state kept
//   DELETE /sessions/:id?owner=…         close
// =============================================================================
const http = require('http');
const crypto = require('crypto');
const { GateClient } = require('./gateClient');
const { Sandbox } = require('./sandbox');
const { Pool, BusyError } = require('./pool');
const { Executor, Sessions, SessionError } = require('./executor');

const int = (name, fallback) => {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const LIMITS = {
  maxContainers: int('RUNNER_MAX_CONTAINERS', 4),
  warmTarget: int('RUNNER_WARM', 2),
  maxSessions: int('RUNNER_MAX_SESSIONS', 2),
  runTimeoutMs: int('RUNNER_RUN_TIMEOUT_MS', 15000),
  checkTimeoutMs: int('RUNNER_CHECK_TIMEOUT_MS', 30000),
  maxCheckTimeoutMs: int('RUNNER_MAX_CHECK_TIMEOUT_MS', 60000),
  queueWaitMs: int('RUNNER_QUEUE_WAIT_MS', 20000),
  checkQueueWaitMs: int('RUNNER_CHECK_QUEUE_WAIT_MS', 120000),
  sessionIdleMs: int('RUNNER_SESSION_IDLE_MS', 10 * 60 * 1000),
  jshellMemoryMb: int('GATE_JSHELL_MEMORY_MB', 384),
  checkMemoryMb: int('GATE_CHECK_MEMORY_MB', 512),
};

const MAX_CELLS = 200;
const MAX_CELL_CHARS = 20000;
const MAX_RUN_CHARS = 200000;
const MAX_FILES = 40;
const MAX_FILE_CHARS = 100000;
const MAX_CHECK_CHARS = 600000;

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      // Drain a little so the 413 reaches the client, then cut a body that keeps coming
      if (tooBig) { if (size > limit * 4) req.destroy(); return; }
      if (size > limit) { tooBig = true; reject(new HttpError(413, 'Request too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      if (size === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function validCells(cells) {
  if (!Array.isArray(cells) || cells.length === 0 || cells.length > MAX_CELLS) throw new HttpError(400, `cells must be an array of 1-${MAX_CELLS} strings`);
  let total = 0;
  for (const c of cells) {
    if (typeof c !== 'string' || c.length > MAX_CELL_CHARS) throw new HttpError(400, `each cell must be a string of at most ${MAX_CELL_CHARS} characters`);
    total += c.length;
  }
  if (total > MAX_RUN_CHARS) throw new HttpError(400, `cells may hold at most ${MAX_RUN_CHARS} characters in total`);
  return cells;
}

const SAFE_PATH = /^[A-Za-z0-9_$-]+(\/[A-Za-z0-9_$-]+)*\.java$/;
function validFiles(list, name, { allowEmpty = false } = {}) {
  if (!Array.isArray(list) || list.length > MAX_FILES || (!allowEmpty && list.length === 0)) throw new HttpError(400, `${name} must be an array of 1-${MAX_FILES} files`);
  return list.map((f, i) => {
    if (!f || typeof f.path !== 'string' || !SAFE_PATH.test(f.path)) throw new HttpError(400, `${name}[${i}].path must look like pkg/Name.java`);
    if (typeof f.content !== 'string' || f.content.length > MAX_FILE_CHARS) throw new HttpError(400, `${name}[${i}].content must be a string of at most ${MAX_FILE_CHARS} characters`);
    return { path: f.path, content: f.content };
  });
}

function createRunner({ executor, sessions, pool, token }) {
  // Both sides are hashed first, so the comparison takes the same time whatever the given length
  const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
  const expected = digest(token);
  const authorized = (req) => {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return false;
    return crypto.timingSafeEqual(digest(header.slice(7)), expected);
  };
  // The owner of a session is chosen by the platform (from the signed-in user), never by a student
  const ownerOf = (v) => {
    if (typeof v !== 'string' || !v || v.length > 100) throw new HttpError(400, 'owner must be 1-100 characters');
    return v;
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://runner');
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
      if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });

      if (req.method === 'GET' && url.pathname === '/stats') {
        return send(res, 200, { pool: pool.stats(), sessions: sessions.list(), limits: LIMITS });
      }
      if (req.method === 'POST' && url.pathname === '/run') {
        const body = await readJson(req, 1024 * 1024);
        const cells = validCells(body.cells);
        const requestId = typeof body.requestId === 'string' ? body.requestId.slice(0, 100) : null;
        return send(res, 200, await executor.runNotebook(cells, { requestId }));
      }
      if (req.method === 'GET' && parts[0] === 'queue' && parts.length === 2) {
        return send(res, 200, { position: pool.queuePosition(parts[1]) });
      }
      if (req.method === 'POST' && url.pathname === '/check') {
        const body = await readJson(req, 2 * 1024 * 1024);
        const files = validFiles(body.files, 'files');
        const tests = validFiles(body.tests, 'tests');
        const total = [...files, ...tests].reduce((n, f) => n + f.content.length, 0);
        if (total > MAX_CHECK_CHARS) throw new HttpError(400, 'The files are too large');
        const timeoutMs = Number.isInteger(body.timeoutMs) && body.timeoutMs > 0 ? body.timeoutMs : undefined;
        return send(res, 200, await executor.runCheck(files, tests, { timeoutMs }));
      }
      if (parts[0] === 'sessions') {
        if (req.method === 'GET' && parts.length === 1) return send(res, 200, sessions.list());
        if (req.method === 'POST' && parts.length === 1) {
          const body = await readJson(req, 4096);
          return send(res, 201, await sessions.open(ownerOf(body.owner)));
        }
        if (req.method === 'POST' && parts.length === 3 && parts[2] === 'cells') {
          const body = await readJson(req, 256 * 1024);
          if (typeof body.source !== 'string' || body.source.length > MAX_CELL_CHARS) throw new HttpError(400, 'source must be a string');
          return send(res, 200, await sessions.run(parts[1], ownerOf(body.owner), body.source));
        }
        if (req.method === 'DELETE' && parts.length === 2) {
          const s = sessions.byId.get(parts[1]);
          if (!s || s.owner !== (url.searchParams.get('owner') || '')) return send(res, 404, { error: 'no such session' });
          await sessions.close(parts[1]);
          return send(res, 200, { closed: true });
        }
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...(err.extra || {}) });
      if (err instanceof BusyError) return send(res, 429, { error: err.message, code: 'busy' });
      if (err instanceof SessionError) return send(res, err.code === 'no_session' ? 404 : err.code === 'busy' ? 409 : 429, { error: err.message, code: err.code });
      console.error('[runner] request failed:', err.stack || err.message || err);
      if (res.headersSent) return;
      // Gate answers and network failures towards the gate are transient (502); anything else is a bug (500)
      const fromGate = err.status || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND'].includes(err.code)
        || /^gate |attach refused|kernel did not start|gate timeout/.test(err.message || '');
      if (fromGate) send(res, 502, { error: 'The runner could not start a sandbox. Try again in a moment.', code: 'sandbox_unavailable' });
      else send(res, 500, { error: 'The runner hit an internal error.', code: 'internal' });
    }
  });
}

// Sandboxes this process does not know about (left over from a previous run) are removed. Ones
// created in the last minAgeMs are left alone: during an overlapping redeploy they may still
// belong to the runner that is shutting down. The runner is meant to run as one replica.
async function removeStrays(gate, known, { minAgeMs = 120000, now = Date.now() } = {}) {
  try {
    for (const s of await gate.list()) {
      if (known.has(s.id)) continue;
      const age = now - Date.parse(s.createdAt);
      if (Number.isFinite(age) && age < minAgeMs) continue;
      await gate.remove(s.id);
    }
  } catch (err) {
    console.error('[runner] stray sweep failed:', err.message);
  }
}

function dropPrivileges() {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    process.setgid(10001);
    process.setuid(10001);
  }
}

async function main() {
  const token = process.env.RUNNER_TOKEN || '';
  if (token.length < 24) { console.error('[runner] RUNNER_TOKEN must be set (at least 24 characters)'); process.exit(1); }
  const gateToken = process.env.GATE_TOKEN || '';
  if (gateToken.length < 24) { console.error('[runner] GATE_TOKEN must be set (at least 24 characters)'); process.exit(1); }
  if (gateToken === token) { console.error('[runner] GATE_TOKEN and RUNNER_TOKEN must be different secrets'); process.exit(1); }
  dropPrivileges();
  const gate = new GateClient({ url: process.env.GATE_URL || 'http://gate:2376', token: gateToken });
  const pool = new Pool({
    makeSandbox: (profile) => new Sandbox(gate, profile),
    maxContainers: LIMITS.maxContainers,
    warmTarget: LIMITS.warmTarget,
  });
  const executor = new Executor({ pool, limits: LIMITS });
  const sessions = new Sessions({ pool, limits: LIMITS });

  // Sandboxes left by a previous run belong to no one: remove those older than two minutes (younger
  // ones may still be used by a runner that is shutting down; the periodic sweep gets them later)
  await removeStrays(gate, new Set());
  pool.schedule();

  const server = createRunner({ executor, sessions, pool, token });
  const port = int('PORT', 8080);
  const host = process.env.HOST || '0.0.0.0';
  server.listen(port, host, () => console.log(`[runner] listening on ${port}; limits ${JSON.stringify(LIMITS)}`));

  setInterval(() => {
    sessions.sweep();
    pool.recycle();
    const known = new Set([
      ...pool.warm.map((s) => s.id),
      ...[...sessions.byId.values()].map((s) => s.sandbox.id),
    ]);
    // Busy sandboxes are never older than the longest check; only clearly stale ones go
    gate.list().then((list) => {
      const cutoff = Date.now() - (LIMITS.maxCheckTimeoutMs + LIMITS.checkQueueWaitMs + 60000);
      return Promise.all(list.filter((s) => !known.has(s.id) && Date.parse(s.createdAt) < cutoff).map((s) => gate.remove(s.id)));
    }).catch((err) => console.error('[runner] sweep failed:', err.message));
  }, 30000).unref();

  const stop = async () => {
    server.close();
    await sessions.shutdown();
    await pool.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (require.main === module) main().catch((err) => { console.error('[runner] fatal:', err.message || err); process.exit(1); });

module.exports = { createRunner, validCells, validFiles, removeStrays, LIMITS };
