// Outline scroll-spy (outlineSpy.ts): which heading is highlighted for a scroll position
import test from 'node:test';
import assert from 'node:assert/strict';
import { activeHeadingIndex } from '../notebooks/outlineSpy.ts';

test('the first heading before any heading reaches the line', () => {
  assert.equal(activeHeadingIndex([200, 600, 900], 100, false), 0);
});

test('the last heading that passed the line', () => {
  assert.equal(activeHeadingIndex([-800, -50, 100, 400], 120, false), 2);
  assert.equal(activeHeadingIndex([-800, -50, 300, 400], 120, false), 1);
});

test('the last heading at the bottom of the page', () => {
  assert.equal(activeHeadingIndex([-800, -50, 300, 400], 120, true), 3);
});

test('headings that are not on the page are skipped', () => {
  assert.equal(activeHeadingIndex([null, 300, null], 100, false), 1);
  assert.equal(activeHeadingIndex([-10, null], 100, true), 0);
  assert.equal(activeHeadingIndex([], 100, false), null);
});
