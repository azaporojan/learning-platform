// Unit tests for the mysql2 → pg compatibility layer (no database needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const { toPgQuery } = require('../db');

test('rewrites ? placeholders to $n in order', () => {
  const q = toPgQuery('SELECT * FROM users WHERE id = ? AND role = ?', [7, 'admin']);
  assert.equal(q.text, 'SELECT * FROM users WHERE id = $1 AND role = $2');
  assert.deepEqual(q.values, [7, 'admin']);
});

test('leaves ? inside string literals alone', () => {
  const q = toPgQuery("SELECT 'what?' AS q, name FROM users WHERE id = ?", [1]);
  assert.equal(q.text, "SELECT 'what?' AS q, name FROM users WHERE id = $1");
  assert.deepEqual(q.values, [1]);
});

test('expands bulk VALUES ? with an array of rows', () => {
  const q = toPgQuery('INSERT INTO chat_members (chat_id, user_id) VALUES ? ON CONFLICT DO NOTHING', [[[1, 2], [1, 3]]]);
  assert.equal(q.text, 'INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2), ($3, $4) ON CONFLICT DO NOTHING');
  assert.deepEqual(q.values, [1, 2, 1, 3]);
});

test('rejects a parameter count mismatch', () => {
  assert.throws(() => toPgQuery('SELECT ? , ?', [1]), /Missing parameter/);
  assert.throws(() => toPgQuery('SELECT ?', [1, 2]), /Too many parameters/);
});
