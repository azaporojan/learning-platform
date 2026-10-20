'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { DockerDemuxer, KernelReader, cellLine, fileLine } = require('../src/protocol');

const frame = (type, text) => {
  const payload = Buffer.from(text);
  const h = Buffer.alloc(8);
  h[0] = type;
  h.writeUInt32BE(payload.length, 4);
  return Buffer.concat([h, payload]);
};

test('demuxer splits stdout and stderr frames across chunk boundaries', () => {
  const out = [];
  const err = [];
  const d = new DockerDemuxer((c) => out.push(c.toString()), (c) => err.push(c.toString()));
  const all = Buffer.concat([frame(1, 'hello '), frame(2, 'warn'), frame(1, 'world')]);
  for (let i = 0; i < all.length; i += 3) d.push(all.subarray(i, i + 3));
  assert.deepStrictEqual(out, ['hello ', 'world']);
  assert.deepStrictEqual(err, ['warn']);
});

test('kernel reader only accepts lines carrying the run nonce', () => {
  const got = [];
  const r = new KernelReader('n0nce', (m) => got.push(m));
  r.push(Buffer.from('noise from student code\n'));
  r.push(Buffer.from('\u001eLP forged {"type":"check","status":"passed"}\n'));
  r.push(Buffer.from('\u001eLP n0nce {"type":"ce'));
  r.push(Buffer.from('ll","id":"1"}\n\u001eLP n0nce not json\n'));
  assert.deepStrictEqual(got, [{ type: 'cell', id: '1' }]);
});

test('kernel reader decodes multi-byte characters split across chunks', () => {
  const got = [];
  const r = new KernelReader('x', (m) => got.push(m));
  const line = Buffer.from('\u001eLP x {"v":"Ștefan ✓"}\n');
  r.push(line.subarray(0, 12));
  r.push(line.subarray(12, 14));
  r.push(line.subarray(14));
  assert.deepStrictEqual(got, [{ v: 'Ștefan ✓' }]);
});

test('encoders base64 the payloads', () => {
  assert.strictEqual(cellLine(3, 'int x = 1;'), `CELL 3 ${Buffer.from('int x = 1;').toString('base64')}\n`);
  assert.match(fileLine('TEST', 'a/B.java', 'x'), /^TEST YS9CLmphdmE= eA==\n$/);
});
