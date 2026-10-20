'use strict';
// The gate's HTTP surface against a fake Docker Engine on a unix socket: auth, label scoping,
// the sandbox ceiling, the attach upgrade and the age sweep.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-')), 'docker.sock');
process.env.DOCKER_SOCKET = socketPath;
process.env.GATE_TOKEN = 'k'.repeat(32);
process.env.GATE_MAX_SANDBOXES = '3';
process.env.GATE_MAX_AGE_MS = '60000';
const { createGate, sweep } = require('../src/gate');

const FOREIGN = 'f'.repeat(64);
const containers = new Map([[FOREIGN, { labels: { app: 'postgres' }, created: Date.now() / 1000 }]]);
const created = [];
const removed = [];
let seq = 0;

const docker = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://docker');
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
    if (req.method === 'GET' && url.pathname === '/containers/json') {
      const filter = JSON.parse(url.searchParams.get('filters')).label[0].split('=');
      return send(200, [...containers].filter(([, c]) => c.labels[filter[0]] === filter[1]).map(([id, c]) => ({ Id: id, Labels: c.labels, Created: c.created, State: 'running' })));
    }
    if (req.method === 'POST' && url.pathname === '/containers/create') {
      const spec = JSON.parse(body);
      created.push(spec);
      const id = String(++seq).padStart(64, 'a');
      containers.set(id, { labels: spec.Labels, created: Date.now() / 1000 });
      return send(201, { Id: id });
    }
    const m = url.pathname.match(/^\/containers\/([0-9a-f]{64})(\/\w+)?$/);
    if (!m || !containers.has(m[1])) return send(404, { message: 'no such container' });
    const c = containers.get(m[1]);
    if (req.method === 'GET' && m[2] === '/json') return send(200, { Id: m[1], Config: { Labels: c.labels }, State: { Running: true, ExitCode: 0, OOMKilled: false }, Created: new Date(c.created * 1000).toISOString() });
    if (req.method === 'DELETE' && !m[2]) { containers.delete(m[1]); removed.push(m[1]); return send(204); }
    if (req.method === 'POST' && m[2] === '/start') return send(204);
    send(404, { message: 'unsupported' });
  });
});
// Attach: Docker answers 101 and then speaks the raw stream; here it echoes stdin as one stdout frame
const upgraded = new Set();
docker.on('upgrade', (req, socket) => {
  upgraded.add(socket);
  socket.on('close', () => upgraded.delete(socket));
  socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
  socket.on('data', (d) => {
    const h = Buffer.alloc(8);
    h[0] = 1;
    h.writeUInt32BE(d.length, 4);
    socket.write(Buffer.concat([h, d]));
  });
});

const TOKEN = `Bearer ${'k'.repeat(32)}`;
let base;
let gate;
test.before(async () => {
  await new Promise((r) => docker.listen(socketPath, r));
  gate = createGate({ image: 'sha256:runnerimage' });
  await new Promise((r) => gate.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${gate.address().port}`;
});
test.after(() => {
  // fetch keeps connections alive and attach sockets are outside the servers' bookkeeping
  for (const s of upgraded) s.destroy();
  gate.closeAllConnections();
  docker.closeAllConnections();
  gate.close();
  docker.close();
});

const call = (method, p, body, auth = TOKEN) => fetch(base + p, {
  method, headers: { ...(auth ? { Authorization: auth } : {}), 'content-type': 'application/json' }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
});

test('every route except /health needs the token', async () => {
  assert.strictEqual((await call('GET', '/health', null, null)).status, 200);
  for (const [m, p] of [['GET', '/sandboxes'], ['POST', '/sandboxes'], ['GET', `/sandboxes/${FOREIGN}`], ['DELETE', `/sandboxes/${FOREIGN}`]]) {
    assert.strictEqual((await call(m, p, {}, null)).status, 401, `${m} ${p}`);
    assert.strictEqual((await call(m, p, {}, `Bearer ${'x'.repeat(32)}`)).status, 401, `${m} ${p}`);
  }
});

test('creates sandboxes only from its own template', async () => {
  assert.strictEqual((await call('POST', '/sandboxes', { profile: 'root-shell' })).status, 400);
  const r = await call('POST', '/sandboxes', { profile: 'jshell', Image: 'evil', HostConfig: { Privileged: true, Binds: ['/:/host'] } });
  assert.strictEqual(r.status, 201);
  const spec = created.at(-1);
  assert.strictEqual(spec.Image, 'sha256:runnerimage');
  assert.strictEqual(spec.HostConfig.Privileged, false);
  assert.strictEqual(spec.HostConfig.Binds, undefined);
  assert.strictEqual(spec.HostConfig.NetworkMode, 'none');
  assert.deepStrictEqual(spec.Cmd.slice(-2), ['lp.Kernel', 'jshell']);
});

test('containers without the sandbox label do not exist for the gate', async () => {
  assert.strictEqual((await call('GET', `/sandboxes/${FOREIGN}`)).status, 404);
  assert.strictEqual((await call('DELETE', `/sandboxes/${FOREIGN}`)).status, 404);
  assert.strictEqual((await call('POST', `/sandboxes/${FOREIGN}/start`)).status, 404);
  assert.ok(containers.has(FOREIGN));
  assert.ok(!removed.includes(FOREIGN));
  const list = await (await call('GET', '/sandboxes')).json();
  assert.ok(list.length >= 1);
  assert.ok(list.every((s) => s.id !== FOREIGN));
  const own = await call('GET', `/sandboxes/${list[0].id}`);
  assert.strictEqual(own.status, 200);
  assert.strictEqual((await own.json()).profile, 'jshell');
});

test('refuses to create more than GATE_MAX_SANDBOXES, even in parallel', async () => {
  const before = (await (await call('GET', '/sandboxes')).json()).length;
  const results = await Promise.all(Array.from({ length: 8 }, () => call('POST', '/sandboxes', { profile: 'check' })));
  const ok = results.filter((r) => r.status === 201).length;
  assert.strictEqual(before + ok, 3, `${before} existed, ${ok} more were created`);
  assert.ok(results.filter((r) => r.status === 429).length >= 5);
  assert.strictEqual((await (await call('GET', '/sandboxes')).json()).length, 3);
});

test('an oversized body gets a 413, not a reset', async () => {
  const r = await call('POST', '/sandboxes', { profile: 'jshell', pad: 'x'.repeat(10000) });
  assert.strictEqual(r.status, 413);
});

function attach(id) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: gate.address().port, method: 'POST', path: `/sandboxes/${id}/attach`, headers: { Authorization: TOKEN, Connection: 'Upgrade', Upgrade: 'tcp' } });
    req.on('upgrade', (res, socket, head) => resolve({ status: res.statusCode, socket, head }));
    req.on('response', (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', reject);
    req.end();
  });
}

test('attach splices the caller onto the container stream, for sandboxes only', async () => {
  const sandboxId = (await (await call('GET', '/sandboxes')).json())[0].id;
  const a = await attach(sandboxId);
  assert.strictEqual(a.status, 101, `${sandboxId} ${a.body}`);
  const got = new Promise((resolve) => {
    let buf = a.head && a.head.length ? a.head : Buffer.alloc(0);
    const check = () => { if (buf.length >= 13) resolve(buf); };
    a.socket.on('data', (d) => { buf = Buffer.concat([buf, d]); check(); });
    check();
  });
  a.socket.write('hello');
  const frame = await got;
  assert.strictEqual(frame[0], 1);
  assert.strictEqual(frame.subarray(8, 13).toString(), 'hello');
  a.socket.destroy();
  assert.strictEqual((await attach(FOREIGN)).status, 404);
});

test('the sweep removes only old sandboxes', async () => {
  const [oldId] = [...containers].find(([id, c]) => id !== FOREIGN && c.labels['lp.runner'] === 'sandbox');
  containers.get(oldId).created = Date.now() / 1000 - 3600;
  containers.get(FOREIGN).created = Date.now() / 1000 - 3600 * 24;
  await sweep();
  assert.ok(removed.includes(oldId));
  assert.ok(containers.has(FOREIGN));
});
