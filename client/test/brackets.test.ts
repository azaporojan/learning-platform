// Stepping over ")" that the bracket closer does not track (notebooks/brackets.ts). Run: npm test --prefix client
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldOvertype } from '../notebooks/brackets.ts';

const at = (text: string) => ({ line: text.replace('|', ''), col: text.indexOf('|') });

test('a ")" from a completion inside an auto-closed call is stepped over', () => {
  const { line, col } = at('System.out.println(name.length(|))');
  assert.equal(shouldOvertype(line, col, ')'), true);
  const outer = at('System.out.println(name.length()|)');
  assert.equal(shouldOvertype(outer.line, outer.col, ')'), true);
});

test('an unbalanced line still inserts the ")"', () => {
  const { line, col } = at('foo(bar(|)'); // one closer for two opens: typing ")" must insert
  assert.equal(shouldOvertype(line, col, ')'), false);
  const none = at('x = y|)');
  assert.equal(shouldOvertype(none.line, none.col, ')'), false);
});

test('only when the next character is the same closer', () => {
  const { line, col } = at('foo(|;');
  assert.equal(shouldOvertype(line, col, ')'), false);
  const sq = at('a[i|]');
  assert.equal(shouldOvertype(sq.line, sq.col, ']'), true);
  assert.equal(shouldOvertype(sq.line, sq.col, ')'), false);
});
