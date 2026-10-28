// Scoped checks and grouped failures (checks/onlyClass.ts). Run: npm test --prefix client
import test from 'node:test';
import assert from 'node:assert/strict';
import { classOfFile, groupFailures } from '../checks/onlyClass.ts';

test('the class of the open file', () => {
  assert.equal(classOfFile('BubbleSort.java'), 'BubbleSort');
  assert.equal(classOfFile('shop/Cart.java'), 'Cart');
  assert.equal(classOfFile('Testimonial.java'), 'Testimonial');
  assert.equal(classOfFile(null), null);
  assert.equal(classOfFile('my-file.java'), null);
});

test('failures are grouped by test class in the order they came', () => {
  const groups = groupFailures([
    { name: 'BinarySearchTest: finds 1', message: '' },
    { name: 'CountVowelsTest.countsY', message: '' }, // runner/kernel Kernel.nameOf: Class.method or Class: display name
    { name: 'BinarySearchTest: finds 9', message: '' },
    { name: 'did not finish', message: '' },
  ]);
  assert.deepEqual(groups.map((g) => [g.group, g.items.length]), [['BinarySearchTest', 2], ['CountVowelsTest', 1], ['', 1]]);
});
