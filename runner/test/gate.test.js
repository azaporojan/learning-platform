'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.GATE_TOKEN = 'a'.repeat(32);
const { sandboxSpec, PROFILES, authorized } = require('../src/gate');

test('sandbox containers are locked down whatever the profile', () => {
  for (const profile of Object.keys(PROFILES)) {
    const s = sandboxSpec('sha256:abc', profile);
    const h = s.HostConfig;
    assert.strictEqual(s.Image, 'sha256:abc');
    assert.strictEqual(s.User, '10001:10001');
    assert.strictEqual(s.NetworkDisabled, true);
    assert.strictEqual(h.NetworkMode, 'none');
    assert.strictEqual(h.Privileged, false);
    assert.strictEqual(h.ReadonlyRootfs, true);
    assert.deepStrictEqual(h.CapDrop, ['ALL']);
    assert.ok(h.SecurityOpt.includes('no-new-privileges'));
    assert.strictEqual(h.Memory, h.MemorySwap, 'no swap');
    assert.ok(h.Memory <= 1024 * 1024 * 1024);
    assert.ok(h.PidsLimit > 0 && h.PidsLimit <= 128);
    assert.ok(!h.Binds && !h.Mounts && !h.Devices, 'no host paths or devices');
    assert.strictEqual(s.Labels['lp.runner'], 'sandbox');
    assert.strictEqual(s.Labels['lp.profile'], profile);
  }
});

test('the JVM heap stays below the container limit', () => {
  for (const p of Object.values(PROFILES)) assert.ok(p.heapMb < p.memoryMb - 64);
});

test('gate token check', () => {
  assert.strictEqual(authorized({ headers: { authorization: `Bearer ${'a'.repeat(32)}` } }), true);
  assert.strictEqual(authorized({ headers: { authorization: `Bearer ${'b'.repeat(32)}` } }), false);
  assert.strictEqual(authorized({ headers: {} }), false);
});
