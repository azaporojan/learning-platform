'use strict';
// =============================================================================
// Gate: the only process that holds the Docker socket.
//
// It does not proxy the Docker API. It offers five operations on sandbox containers and builds
// every container itself from a fixed template, so a caller (the runner) can neither choose the
// image, the command, mounts, networks or privileges, nor touch any container it did not create.
//
//   GET    /health
//   POST   /sandboxes                {profile: "jshell" | "check"}  -> {id}   (429 at GATE_MAX_SANDBOXES)
//   POST   /sandboxes/:id/attach     HTTP upgrade: raw Docker attach stream (stdin + stdout/stderr)
//   POST   /sandboxes/:id/start
//   GET    /sandboxes/:id            {running, exitCode, oomKilled, profile, createdAt}
//   DELETE /sandboxes/:id
//   GET    /sandboxes                [{id, profile, createdAt, running}]
//
// Every call except /health needs `Authorization: Bearer $GATE_TOKEN`.
// =============================================================================
const http = require('http');
const net = require('net');
const fs = require('fs');
const crypto = require('crypto');

const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const PORT = parseInt(process.env.GATE_PORT || '2376', 10);
const TOKEN = process.env.GATE_TOKEN || '';
// Fails closed: loopback unless the deployment opts in. On Dokploy GATE_HOST=0.0.0.0 is set
// because the runner reaches the gate over the overlay network; the gate must still never get a
// published port or a domain (README "Deployment").
const HOST = process.env.GATE_HOST || '127.0.0.1';
const MAX_AGE_MS = parseInt(process.env.GATE_MAX_AGE_MS || String(2 * 60 * 60 * 1000), 10);
// A ceiling of its own, independent of the runner's pool: even a broken or compromised runner
// cannot fill the host with sandboxes.
const MAX_SANDBOXES = Math.max(1, parseInt(process.env.GATE_MAX_SANDBOXES || '6', 10));
const LABEL = 'lp.runner';
const LABEL_VALUE = 'sandbox';

const MiB = 1024 * 1024;
// An unset, malformed or out-of-range value falls back to the default (a typo never becomes 64 MB)
const capped = (envName, fallback, max) => {
  const v = parseInt(process.env[envName] || '', 10);
  return Number.isFinite(v) && v >= 64 && v <= max ? v : fallback;
};

// Fixed sandbox profiles. Memory is a hard limit with no swap; the JVM heap sits below it so the
// JVM, not the kernel's OOM killer, hits its ceiling first.
const PROFILES = {
  jshell: { mode: 'jshell', memoryMb: capped('GATE_JSHELL_MEMORY_MB', 384, 1024), heapMb: capped('GATE_JSHELL_HEAP_MB', 256, 768) },
  check: { mode: 'check', memoryMb: capped('GATE_CHECK_MEMORY_MB', 512, 1024), heapMb: capped('GATE_CHECK_HEAP_MB', 320, 768) },
};
const NANO_CPUS = Math.round(Math.min(2, Math.max(0.25, parseFloat(process.env.GATE_SANDBOX_CPUS || '1'))) * 1e9);

// Arguments to /opt/java/openjdk/bin/java (the entrypoint; the base image's own entrypoint script is bypassed)
function kernelCommand(profile) {
  return [
    '-XX:SharedArchiveFile=/opt/lp/kernel.jsa', '-Xshare:auto',
    '-XX:TieredStopAtLevel=1', '-XX:+UseSerialGC', '-XX:-UsePerfData',
    '-Xss1m', `-Xmx${profile.heapMb}m`,
    '-cp', '/opt/lp/kernel.jar:/opt/lp/libs/*', '-Dlp.libs=/opt/lp/libs',
    'lp.Kernel', profile.mode,
  ];
}

function sandboxSpec(image, profileName) {
  const profile = PROFILES[profileName];
  return {
    Image: image,
    Entrypoint: ['/opt/java/openjdk/bin/java'],
    Cmd: kernelCommand(profile),
    User: '10001:10001',
    WorkingDir: '/work',
    Hostname: 'sandbox',
    Env: ['LANG=C.UTF-8', 'HOME=/work', 'JAVA_TOOL_OPTIONS='],
    Labels: { [LABEL]: LABEL_VALUE, 'lp.profile': profileName, 'lp.created': String(Date.now()) },
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: true,
    Tty: false,
    NetworkDisabled: true,
    HostConfig: {
      NetworkMode: 'none',
      Memory: profile.memoryMb * MiB,
      MemorySwap: profile.memoryMb * MiB,
      NanoCpus: NANO_CPUS,
      PidsLimit: 64,
      ReadonlyRootfs: true,
      Tmpfs: {
        '/work': 'rw,noexec,nosuid,nodev,size=32m,mode=1777',
        '/tmp': 'rw,noexec,nosuid,nodev,size=16m,mode=1777',
      },
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Privileged: false,
      IpcMode: 'private',
      OomScoreAdj: 500,
      Ulimits: [{ Name: 'nofile', Soft: 256, Hard: 256 }],
      LogConfig: { Type: 'none', Config: {} },
      AutoRemove: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Docker Engine API over the unix socket
// ---------------------------------------------------------------------------
function docker(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      socketPath: DOCKER_SOCKET,
      method,
      path,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Docker API timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// The sandbox image is the image this gate container runs, so it is always present on the host.
// Returns {id, ref}: sandboxes start from the exact image id; if a cleanup removed that image while
// the gate kept running, they fall back to the image's name (the newest pulled runner image).
async function resolveImage() {
  if (process.env.SANDBOX_IMAGE) return { id: process.env.SANDBOX_IMAGE, ref: process.env.SANDBOX_IMAGE };
  let id = null;
  try {
    const mountinfo = fs.readFileSync('/proc/self/mountinfo', 'utf8');
    const m = mountinfo.match(/\/containers\/([0-9a-f]{64})\//);
    if (m) id = m[1];
  } catch { /* not in a container */ }
  if (!id) id = process.env.HOSTNAME;
  const r = await docker('GET', `/containers/${encodeURIComponent(id || '')}/json`);
  if (r.status !== 200 || !r.json || !r.json.Image) {
    throw new Error('Cannot find the gate container image. Set SANDBOX_IMAGE.');
  }
  return { id: r.json.Image, ref: (r.json.Config && r.json.Config.Image) || r.json.Image };
}

const validId = (id) => /^[0-9a-f]{12,64}$/.test(id || '');

// A container counts as a sandbox only if it carries our label; everything else is invisible.
async function inspectSandbox(id) {
  if (!validId(id)) return null;
  const r = await docker('GET', `/containers/${id}/json`);
  if (r.status !== 200 || !r.json) return null;
  const labels = (r.json.Config && r.json.Config.Labels) || {};
  if (labels[LABEL] !== LABEL_VALUE) return null;
  return r.json;
}

const describe = (c) => ({
  id: c.Id,
  profile: (c.Config && c.Config.Labels && c.Config.Labels['lp.profile']) || null,
  createdAt: c.Created,
  running: Boolean(c.State && c.State.Running),
  exitCode: c.State ? c.State.ExitCode : null,
  oomKilled: Boolean(c.State && c.State.OOMKilled),
});

// Both sides are hashed first, so the comparison takes the same time whatever the given length
const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
function authorized(req) {
  const header = req.headers.authorization || '';
  if (!TOKEN || !header.startsWith('Bearer ')) return false;
  return crypto.timingSafeEqual(digest(header.slice(7)), digest(TOKEN));
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      // Drain a little so the 413 reaches the client, then cut a body that keeps coming
      if (tooBig) { if (size > limit * 4) req.destroy(); return; }
      if (size > limit) { tooBig = true; reject(Object.assign(new Error('Body too large'), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      if (size === 0) return resolve({});
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return reject(Object.assign(new Error('The body must be a JSON object'), { status: 400 }));
      resolve(body);
    });
    req.on('error', reject);
  });
}

async function listSandboxes() {
  const filters = encodeURIComponent(JSON.stringify({ label: [`${LABEL}=${LABEL_VALUE}`] }));
  const r = await docker('GET', `/containers/json?all=1&filters=${filters}`);
  // Docker already filters by label; checking again keeps a misbehaving daemon from widening it
  return (Array.isArray(r.json) ? r.json : []).filter((c) => c.Labels && c.Labels[LABEL] === LABEL_VALUE);
}

async function removeSandbox(id) {
  const r = await docker('DELETE', `/containers/${id}?force=1&v=1`);
  return r.status === 204 || r.status === 404;
}

function createGate({ image }) {
  const images = typeof image === 'string' ? { id: image, ref: image } : image;
  // Creates are serialised: the ceiling counts existing sandboxes, so two parallel creates must
  // not both see room for one more.
  let createLock = Promise.resolve();
  const exclusive = (fn) => {
    const run = createLock.then(fn, fn);
    createLock = run.catch(() => {});
    return run;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://gate');
      const parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
      if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
      if (parts[0] !== 'sandboxes') return send(res, 404, { error: 'not found' });

      if (parts.length === 1 && req.method === 'POST') {
        const body = await readJson(req);
        if (!Object.prototype.hasOwnProperty.call(PROFILES, body.profile)) return send(res, 400, { error: 'profile must be jshell or check' });
        const created = await exclusive(async () => {
          const existing = await listSandboxes();
          if (existing.length >= MAX_SANDBOXES) return { status: 429, body: { error: `at most ${MAX_SANDBOXES} sandboxes at a time` } };
          const name = `lp-sandbox-${crypto.randomBytes(6).toString('hex')}`;
          let r = await docker('POST', `/containers/create?name=${name}`, sandboxSpec(images.id, body.profile));
          if (r.status === 404 && images.ref !== images.id) {
            console.warn(`[gate] image ${images.id.slice(0, 19)} is gone; using ${images.ref}`);
            r = await docker('POST', `/containers/create?name=${name}`, sandboxSpec(images.ref, body.profile));
          }
          if (r.status !== 201) return { status: 502, body: { error: 'create failed', detail: r.json && r.json.message } };
          return { status: 201, body: { id: r.json.Id } };
        });
        return send(res, created.status, created.body);
      }
      if (parts.length === 1 && req.method === 'GET') {
        const list = (await listSandboxes()).map((c) => ({
          id: c.Id,
          profile: (c.Labels && c.Labels['lp.profile']) || null,
          createdAt: new Date(c.Created * 1000).toISOString(),
          running: c.State === 'running',
        }));
        return send(res, 200, list);
      }

      const id = parts[1];
      const sandbox = await inspectSandbox(id);
      if (!sandbox) return send(res, 404, { error: 'no such sandbox' });
      if (parts.length === 2 && req.method === 'GET') return send(res, 200, describe(sandbox));
      if (parts.length === 2 && req.method === 'DELETE') {
        if (!(await removeSandbox(sandbox.Id))) return send(res, 502, { error: 'remove failed' });
        return send(res, 200, { removed: true });
      }
      if (parts.length === 3 && parts[2] === 'start' && req.method === 'POST') {
        const r = await docker('POST', `/containers/${sandbox.Id}/start`);
        if (r.status !== 204 && r.status !== 304) return send(res, 502, { error: 'start failed', detail: r.json && r.json.message });
        return send(res, 200, { started: true });
      }
      if (parts.length === 3 && parts[2] === 'attach') return send(res, 426, { error: 'attach needs an HTTP upgrade' });
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      if (err.status) return send(res, err.status, { error: err.message });
      console.error('[gate] request failed:', err.message || err);
      if (!res.headersSent) send(res, 500, { error: 'gate error' });
    }
  });

  // Attach: after the checks, the client socket is spliced onto a Docker attach connection.
  server.on('upgrade', async (req, socket, head) => {
    const fail = (status, text) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    socket.on('error', () => socket.destroy());
    try {
      const parts = new URL(req.url, 'http://gate').pathname.split('/').filter(Boolean);
      if (req.method !== 'POST' || parts.length !== 3 || parts[0] !== 'sandboxes' || parts[2] !== 'attach') return fail(404, 'Not Found');
      if (!authorized(req)) return fail(401, 'Unauthorized');
      const sandbox = await inspectSandbox(parts[1]);
      if (!sandbox) return fail(404, 'Not Found');
      if (socket.destroyed) return; // the caller left while we looked the sandbox up
      const upstream = net.connect(DOCKER_SOCKET);
      upstream.on('error', () => { upstream.destroy(); socket.destroy(); });
      upstream.on('connect', () => {
        upstream.write(
          `POST /containers/${sandbox.Id}/attach?stream=1&stdin=1&stdout=1&stderr=1 HTTP/1.1\r\n`
          + 'Host: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n');
        if (head && head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      // Tracked so a shutdown can end them: server.close() would wait for upgraded sockets forever
      server.attached.add(socket);
      socket.on('close', () => { server.attached.delete(socket); upstream.destroy(); });
      upstream.on('close', () => socket.destroy());
    } catch (err) {
      console.error('[gate] attach failed:', err.message || err);
      fail(500, 'Internal Server Error');
    }
  });

  server.attached = new Set();
  return server;
}

// Safety net independent of the runner: nothing lives longer than GATE_MAX_AGE_MS.
async function sweep() {
  try {
    const now = Date.now();
    for (const c of await listSandboxes()) {
      if (now - c.Created * 1000 > MAX_AGE_MS) {
        await removeSandbox(c.Id);
        console.warn(`[gate] removed sandbox ${c.Id.slice(0, 12)} older than ${Math.round(MAX_AGE_MS / 60000)} min`);
      }
    }
  } catch (err) {
    console.error('[gate] sweep failed:', err.message || err);
  }
}

async function main() {
  if (!TOKEN || TOKEN.length < 24) {
    console.error('[gate] GATE_TOKEN must be set (at least 24 characters)');
    process.exit(1);
  }
  const image = await resolveImage();
  const server = createGate({ image });
  server.listen(PORT, HOST, () => console.log(`[gate] listening on ${HOST}:${PORT}, sandbox image ${image.id.slice(0, 19)} (${image.ref}), at most ${MAX_SANDBOXES} sandboxes`));
  setInterval(sweep, 60 * 1000).unref();
  sweep();
  // Attach streams are long-lived: end them, or a redeploy waits for Docker's SIGKILL.
  // The runner sees its sandboxes close and its sweep removes what is left.
  const stop = () => {
    server.close(() => process.exit(0));
    for (const socket of server.attached) socket.destroy();
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (require.main === module) main().catch((err) => { console.error('[gate] fatal:', err.message || err); process.exit(1); });

module.exports = { sandboxSpec, kernelCommand, PROFILES, createGate, authorized, sweep, MAX_SANDBOXES };
