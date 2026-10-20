'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Sessions } = require('../src/executor');
const { removeStrays } = require('../src/runner');

// A pool whose acquire resolves after a delay, so concurrent opens overlap
function slowPool() {
  const released = [];
  return {
    released,
    acquire: () => new Promise((r) => setTimeout(() => r({ sandbox: { id: Math.random().toString(16), end() {}, closed: false }, warm: true, queuedMs: 0 }), 20)),
    release: async (sb) => { released.push(sb.id); },
  };
}
const limits = { maxSessions: 2, sessionIdleMs: 60000, runTimeoutMs: 1000, jshellMemoryMb: 384, queueWaitMs: 1000 };

test('the session ceiling holds when different owners open at once', async () => {
  const pool = slowPool();
  const sessions = new Sessions({ pool, limits, log: { error() {} } });
  const results = await Promise.allSettled(['a', 'b', 'c', 'd'].map((o) => sessions.open(o)));
  assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 2);
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'session_limit'));
  assert.strictEqual(sessions.byId.size, 2);
  assert.strictEqual(pool.released.length, 2, 'sandboxes of refused opens go back to the pool');
});

test('a session answers only its owner', async () => {
  const sessions = new Sessions({ pool: slowPool(), limits, log: { error() {} } });
  const s = await sessions.open('teacher-1');
  await assert.rejects(sessions.run(s.id, 'teacher-2', '1'), (e) => e.code === 'no_session');
  await assert.rejects(sessions.run('nope', 'teacher-1', '1'), (e) => e.code === 'no_session');
  assert.deepStrictEqual((await sessions.open('teacher-1')).id, s.id, 'the same owner gets the same session');
});

test('two opens for the same owner give one session', async () => {
  const pool = slowPool();
  const sessions = new Sessions({ pool, limits, log: { error() {} } });
  const [a, b] = await Promise.all([sessions.open('t'), sessions.open('t')]);
  assert.strictEqual(a.id, b.id);
  assert.strictEqual(sessions.byId.size, 1);
  assert.strictEqual(pool.released.length, 1, 'the second sandbox goes back');
});

test('the startup sweep leaves recent sandboxes alone', async () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const removed = [];
  const gate = {
    list: async () => [
      { id: 'old', createdAt: '2026-10-20T11:50:00Z' },
      { id: 'fresh', createdAt: '2026-10-20T11:59:30Z' },
      { id: 'known', createdAt: '2026-10-20T11:00:00Z' },
    ],
    remove: async (id) => { removed.push(id); },
  };
  await removeStrays(gate, new Set(['known']), { minAgeMs: 120000, now });
  assert.deepStrictEqual(removed, ['old']);
});
