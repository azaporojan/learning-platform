'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createRunner } = require('../src/runner');
const { BusyError } = require('../src/pool');

const TOKEN = 't'.repeat(32);
async function withServer(executor, fn) {
  const pool = { stats: () => ({}), queuePosition: (id) => (id === 'waiting' ? 3 : 0) };
  const sessions = { list: () => [], byId: new Map() };
  const server = createRunner({ executor, sessions, pool, token: TOKEN });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}
const call = (base, method, path, body, token = TOKEN) => fetch(base + path, {
  method,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test('health is open, everything else needs the token', async () => {
  await withServer({}, async (base) => {
    assert.strictEqual((await fetch(`${base}/health`)).status, 200);
    assert.strictEqual((await call(base, 'POST', '/run', { cells: ['1'] }, 'x'.repeat(32))).status, 401);
  });
});

test('run validates cells and maps busy to 429', async () => {
  let seen;
  const executor = {
    runNotebook: async (cells) => { seen = cells; if (cells[0] === 'busy') throw new BusyError(); return { status: 'ok', cells: [] }; },
  };
  await withServer(executor, async (base) => {
    assert.strictEqual((await call(base, 'POST', '/run', { cells: [] })).status, 400);
    assert.strictEqual((await call(base, 'POST', '/run', { cells: [42] })).status, 400);
    assert.strictEqual((await call(base, 'POST', '/run', { cells: ['x'.repeat(20001)] })).status, 400);
    const ok = await call(base, 'POST', '/run', { cells: ['int x = 1;', 'x'] });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(seen, ['int x = 1;', 'x']);
    const busy = await call(base, 'POST', '/run', { cells: ['busy'] });
    assert.strictEqual(busy.status, 429);
    assert.strictEqual((await busy.json()).code, 'busy');
    assert.deepStrictEqual(await (await call(base, 'GET', '/queue/waiting')).json(), { position: 3 });
  });
});

test('check rejects unsafe file paths', async () => {
  await withServer({ runCheck: async () => ({ status: 'passed' }) }, async (base) => {
    for (const path of ['../x.java', '/abs/X.java', 'a/../../X.java', 'X.class', 'a b/X.java']) {
      const r = await call(base, 'POST', '/check', { files: [{ path, content: '' }], tests: [{ path: 'T.java', content: '' }] });
      assert.strictEqual(r.status, 400, path);
    }
    const ok = await call(base, 'POST', '/check', { files: [{ path: 'shop/A.java', content: 'class A {}' }], tests: [{ path: 'shop/ATest.java', content: '' }] });
    assert.strictEqual(ok.status, 200);
  });
});
