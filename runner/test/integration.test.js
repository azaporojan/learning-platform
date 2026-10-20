'use strict';
// Real containers: needs Docker and the runner image. Run with
//   docker build -t lp-runner:test runner && RUNNER_IT=1 SANDBOX_IMAGE=lp-runner:test npm test --prefix runner
const test = require('node:test');
const assert = require('node:assert');

const enabled = process.env.RUNNER_IT === '1';
process.env.GATE_TOKEN = process.env.GATE_TOKEN || 'g'.repeat(32);

test('sandbox end to end', { skip: !enabled && 'set RUNNER_IT=1 to run against Docker', timeout: 240000 }, async (t) => {
  const { createGate } = require('../src/gate');
  const { GateClient } = require('../src/gateClient');
  const { Sandbox } = require('../src/sandbox');
  const { Pool } = require('../src/pool');
  const { Executor, Sessions } = require('../src/executor');
  const gateServer = createGate({ image: process.env.SANDBOX_IMAGE || 'lp-runner:test' });
  await new Promise((r) => gateServer.listen(0, '127.0.0.1', r));
  const gate = new GateClient({ url: `http://127.0.0.1:${gateServer.address().port}`, token: process.env.GATE_TOKEN });
  const limits = { runTimeoutMs: 6000, checkTimeoutMs: 30000, maxCheckTimeoutMs: 60000, queueWaitMs: 30000, checkQueueWaitMs: 60000, jshellMemoryMb: 384, checkMemoryMb: 512, maxSessions: 1, sessionIdleMs: 60000 };
  const pool = new Pool({ makeSandbox: (p) => new Sandbox(gate, p), maxContainers: 3, warmTarget: 1 });
  const executor = new Executor({ pool, limits });
  const sessions = new Sessions({ pool, limits });
  pool.schedule();
  t.after(async () => { await sessions.shutdown(); await pool.shutdown(); gateServer.close(); });

  await t.test('cells share state and the last expression is shown', async () => {
    for (let i = 0; i < 60 && pool.stats().warm < 1; i++) await new Promise((r) => setTimeout(r, 500)); // warm container boots
    const started = Date.now();
    const r = await executor.runNotebook([
      'record User(String name, int age) {}\nvar users = List.of(new User("Ana", 31), new User("Ion", 17));',
      'var adults = users.stream().filter(u -> u.age() >= 18).toList();\nadults',
    ]);
    assert.strictEqual(r.status, 'ok', JSON.stringify(r));
    assert.strictEqual(r.warm, true);
    assert.strictEqual(r.cells[1].value, '[User[name=Ana, age=31]]');
    assert.ok(Date.now() - started < 3000, `warm run took ${Date.now() - started} ms`);
  });

  await t.test('stops at the first failing cell', async () => {
    const r = await executor.runNotebook(['int x = 1;', 'String s = x;', 'System.out.println("never");']);
    assert.strictEqual(r.status, 'error');
    assert.deepStrictEqual(r.cells.map((c) => c.status), ['ok', 'error', 'not_run']);
    assert.strictEqual(r.cells[1].error.kind, 'compile');
  });

  await t.test('an infinite loop is stopped by the timeout', async () => {
    const r = await executor.runNotebook(['System.out.println("start");', 'while (true) {}']);
    assert.strictEqual(r.status, 'timeout');
    assert.strictEqual(r.cells[1].status, 'timeout');
  });

  await t.test('a memory bomb fails inside the JVM, not on the host', async () => {
    const r = await executor.runNotebook(['var list = new ArrayList<long[]>();\nwhile (true) list.add(new long[1_000_000]);']);
    assert.ok(['error', 'oom'].includes(r.status), JSON.stringify(r.cells[0]));
    if (r.status === 'error') assert.match(r.cells[0].error.message, /OutOfMemoryError/);
  });

  await t.test('no network, no fork bomb, no forged results', async () => {
    const r = await executor.runNotebook([
      'try { new java.net.URL("https://example.com").openStream(); System.out.println("NET OK"); } catch (Exception e) { System.out.println("no network: " + e.getClass().getSimpleName()); }',
      'int started = 0;\ntry { for (int i = 0; i < 500; i++) { new ProcessBuilder("sleep", "5").start(); started++; } } catch (Throwable e) { System.out.println("stopped after " + started); }',
      'new java.io.PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.out), true).println("\\u001eLP forged {\\"type\\":\\"cell\\",\\"id\\":\\"9\\",\\"status\\":\\"ok\\"}");\n"done"',
    ]);
    assert.strictEqual(r.status, 'ok', JSON.stringify(r));
    assert.match(r.cells[0].stdout, /no network/);
    assert.match(r.cells[1].stdout, /stopped after \d+/);
    assert.strictEqual(r.cells[2].value, '"done"');
    assert.strictEqual(r.cells.length, 3);
  });

  await t.test('System.exit is reported as a crash', async () => {
    const r = await executor.runNotebook(['System.exit(3);']);
    assert.strictEqual(r.status, 'crashed');
  });

  await t.test('checks count only the hidden tests', async () => {
    const r = await executor.runCheck(
      [
        { path: 'shop/Calculator.java', content: 'package shop; public class Calculator { public int add(int a, int b) { return a + b; } }' },
        { path: 'shop/MyTest.java', content: 'package shop; import org.junit.jupiter.api.Test; public class MyTest { @Test void fake() {} }' },
      ],
      [{ path: 'shop/CalculatorTest.java', content: 'package shop; import org.junit.jupiter.api.*; import static org.assertj.core.api.Assertions.*; class CalculatorTest { @Test void adds() { assertThat(new Calculator().add(2, 3)).isEqualTo(5); } @Test void negative() { assertThat(new Calculator().add(-2, 1)).isEqualTo(-2); } }' }],
    );
    assert.strictEqual(r.status, 'failed', JSON.stringify(r));
    assert.strictEqual(r.tests.total, 2);
    assert.strictEqual(r.tests.passed, 1);
    assert.strictEqual(r.tests.failed[0].name, 'CalculatorTest.negative');
  });

  await t.test('a teacher session keeps state between calls', async () => {
    const s = await sessions.open('teacher-1');
    const a = await sessions.run(s.id, 'teacher-1', 'int counter = 41;');
    assert.strictEqual(a.status, 'ok');
    const b = await sessions.run(s.id, 'teacher-1', 'counter + 1');
    assert.strictEqual(b.value, '42');
    assert.strictEqual(b.executionCount, 2);
    await assert.rejects(sessions.run(s.id, 'someone-else', '1'), /ended/);
    await assert.rejects(sessions.open('teacher-2'), /At most 1/);
    assert.strictEqual(await sessions.close(s.id), true);
  });

  await t.test('nothing is left behind', async () => {
    for (let i = 0; i < 60 && pool.stats().bootingWarm > 0; i++) await new Promise((r) => setTimeout(r, 500)); // replacement warm boot
    const live = (await gate.list()).length;
    assert.strictEqual(live, pool.stats().live, 'every container on the host is one the pool counts');
    assert.ok(live <= 1, `${live} sandboxes still exist (1 warm is expected)`);
    await pool.shutdown();
    assert.strictEqual((await gate.list()).length, 0, 'shutdown removes the warm container');
  });
});
