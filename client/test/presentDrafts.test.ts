// Present mode scratch edits (presentDrafts.ts): kept in memory, applied only to the run
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDrafts, withDraft, isDrafted } from '../notebooks/presentDrafts.ts';

const cells = [
  { id: 'a', kind: 'text' as const, source: '# Trap 1' },
  { id: 'b', kind: 'code' as const, source: 'scores.remove(1);', input: 'x' },
  { id: 'c', kind: 'code' as const, source: 'scores' },
];

test('a draft replaces the source of its cell only, keeping the rest of the cell', () => {
  const ran = applyDrafts(cells, { b: 'scores.remove(Integer.valueOf(10));' });
  assert.deepEqual(ran[1], { id: 'b', kind: 'code', source: 'scores.remove(Integer.valueOf(10));', input: 'x' });
  assert.equal(ran[0], cells[0]);
  assert.equal(ran[2], cells[2]);
});

test('the saved cells are never changed', () => {
  applyDrafts(cells, { b: 'edited' });
  assert.equal(cells[1].source, 'scores.remove(1);');
});

test('typing the saved text back removes the draft', () => {
  let d = withDraft({}, cells[1], 'edited');
  assert.equal(isDrafted(d, cells[1]), true);
  d = withDraft(d, cells[1], 'scores.remove(1);');
  assert.equal(isDrafted(d, cells[1]), false);
  assert.deepEqual(d, {});
  assert.equal(withDraft(d, cells[1], 'scores.remove(1);'), d);
});

test('a draft equal to the saved text does not count as an edit', () => {
  assert.equal(isDrafted({ c: 'scores' }, cells[2]), false);
  assert.equal(applyDrafts(cells, { c: 'scores' })[2], cells[2]);
});
