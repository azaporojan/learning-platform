'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Pool, BusyError } = require('../src/pool');

class FakeSandbox {
  constructor(profile, log, { bootMs = 5, fail = false, destroyMs = 0 } = {}) {
    this.destroyMs = destroyMs;
    this.profile = profile;
    this.log = log;
    this.bootMs = bootMs;
    this.fail = fail;
    this.closed = false;
    this.createdAt = Date.now();
    this.id = Math.random().toString(16).slice(2);
  }
  boot() {
    this.log.booted.push(this.profile);
    return new Promise((resolve, reject) => setTimeout(() => (this.fail ? reject(new Error('boom')) : resolve(this)), this.bootMs));
  }
  async destroy() {
    if (this.destroyMs) await new Promise((r) => setTimeout(r, this.destroyMs));
    this.closed = true;
    this.log.destroyed.push(this.profile);
  }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const makePool = (opts = {}) => {
  const log = { booted: [], destroyed: [] };
  const pool = new Pool({ makeSandbox: (p) => new FakeSandbox(p, log, opts.sandbox), maxContainers: 4, warmTarget: 2, log: { error() {} }, ...opts });
  return { pool, log };
};

test('fills the warm pool and serves a notebook run from it', async () => {
  const { pool } = makePool();
  pool.schedule();
  await tick();
  assert.strictEqual(pool.stats().warm, 2);
  const lease = await pool.acquire('jshell');
  assert.strictEqual(lease.warm, true);
  // A leased sandbox is known to the pool until released, so the stray sweep leaves it alone
  assert.ok(pool.leased.has(lease.sandbox));
  await pool.release(lease.sandbox);
  assert.strictEqual(pool.leased.size, 0);
  await tick();
  assert.strictEqual(pool.stats().warm, 2);
  assert.strictEqual(pool.stats().live, 2);
  await pool.shutdown();
});

test('never exceeds the container ceiling and queues the rest', async () => {
  const { pool } = makePool({ warmTarget: 0 });
  const leases = await Promise.all([1, 2, 3, 4].map(() => pool.acquire('jshell')));
  assert.strictEqual(pool.stats().live, 4);
  const fifth = pool.acquire('jshell', { requestId: 'r5' });
  await tick();
  assert.strictEqual(pool.queuePosition('r5'), 1);
  await pool.release(leases[0].sandbox);
  const got = await fifth;
  assert.ok(got.sandbox);
  assert.ok(pool.stats().live <= 4);
  await Promise.all([...leases.slice(1), got].map((l) => pool.release(l.sandbox)));
  await pool.shutdown();
});

test('notebook runs are served before checks that waited longer', async () => {
  const { pool } = makePool({ maxContainers: 1, warmTarget: 0 });
  const first = await pool.acquire('jshell');
  const order = [];
  const check = pool.acquire('check', { priority: 1 }).then((l) => { order.push('check'); return l; });
  await tick(5);
  const run = pool.acquire('jshell', { priority: 0 }).then((l) => { order.push('run'); return l; });
  await pool.release(first.sandbox);
  const r = await run;
  await pool.release(r.sandbox);
  const c = await check;
  await pool.release(c.sandbox);
  assert.deepStrictEqual(order, ['run', 'check']);
  await pool.shutdown();
});

test('a check takes down an idle warm container when the pool is full', async () => {
  const { pool, log } = makePool({ maxContainers: 2, warmTarget: 2 });
  pool.schedule();
  await tick();
  assert.strictEqual(pool.stats().warm, 2);
  const lease = await pool.acquire('check', { priority: 1 });
  assert.strictEqual(lease.sandbox.profile, 'check');
  assert.strictEqual(log.destroyed.filter((p) => p === 'jshell').length, 1);
  assert.ok(pool.stats().live <= 2);
  await pool.release(lease.sandbox);
  await pool.shutdown();
});

test('times out with BusyError when nothing frees up', async () => {
  const { pool } = makePool({ maxContainers: 1, warmTarget: 0 });
  const held = await pool.acquire('jshell');
  await assert.rejects(pool.acquire('jshell', { waitMs: 30 }), BusyError);
  await pool.release(held.sandbox);
  await pool.shutdown();
});

test('a failing boot frees its place and rejects the request', async () => {
  const { pool } = makePool({ warmTarget: 0, sandbox: { fail: true } });
  await assert.rejects(pool.acquire('check'), /boom/);
  assert.strictEqual(pool.stats().live, 0);
  await pool.shutdown();
});

test('recycle replaces warm containers past their age', async () => {
  const { pool, log } = makePool({ warmMaxAgeMs: 1 });
  pool.schedule();
  await tick();
  await tick(5);
  pool.recycle();
  await tick();
  assert.strictEqual(log.destroyed.length, 2);
  assert.strictEqual(pool.stats().warm, 2);
  await pool.shutdown();
});

test('a sandbox stays owned by the pool until its removal has finished', async () => {
  const { pool } = makePool({ warmTarget: 0, sandbox: { destroyMs: 50 } });
  const lease = await pool.acquire('check');
  const sb = lease.sandbox;
  assert.ok(pool.owned.has(sb), 'owned while leased');
  // A slow removal: no longer leased, but the stray sweep must still see it as known
  const released = pool.release(sb);
  assert.strictEqual(pool.leased.has(sb), false);
  assert.ok(pool.owned.has(sb), 'still owned while being removed');
  await released;
  assert.strictEqual(pool.owned.has(sb), false);
});

test('a second destroy waits for the same removal, so the sandbox stays owned until it is done', async () => {
  const { pool } = makePool({ warmTarget: 0, sandbox: { destroyMs: 50 } });
  const sb = (await pool.acquire('check')).sandbox;
  const first = sb.destroy();
  const second = sb.destroy();
  assert.strictEqual(first, second);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(pool.owned.has(sb), 'still owned while the removal runs');
  await second;
  assert.strictEqual(pool.owned.has(sb), false);
});
