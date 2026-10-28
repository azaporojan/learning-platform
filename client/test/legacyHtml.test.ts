// Legacy HTML task descriptions → Markdown (components/legacyHtml.ts). Run: npm test --prefix client
import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown, isLegacyHtml, toMarkdown } from '../components/legacyHtml.ts';

test('a table becomes a GFM table with a header delimiter row', () => {
  const html = '<p>Examples:</p><table><thead><tr><th>Input</th><th>Expected</th></tr></thead>'
    + '<tbody><tr><td><code>&quot;level&quot;</code></td><td><code>true</code></td></tr>'
    + '<tr><td><code>[1, 2, 3]</code></td><td><code>[1, 2, 3] (unchanged)</code></td></tr></tbody></table><p>After.</p>';
  assert.equal(htmlToMarkdown(html), [
    'Examples:', '',
    '| Input | Expected |',
    '| --- | --- |',
    '| `"level"` | `true` |',
    '| `[1, 2, 3]` | `[1, 2, 3] (unchanged)` |', '',
    'After.',
  ].join('\n'));
});

test('a table without thead uses its first row as the header', () => {
  assert.equal(htmlToMarkdown('<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>'),
    '| a | b |\n| --- | --- |\n| 1 | 2 |');
});

test('a pipe inside a cell is escaped and line breaks are joined', () => {
  assert.equal(htmlToMarkdown('<table><tr><th>x</th></tr><tr><td><p>a | b</p><p>c</p></td></tr></table>'),
    '| x |\n| --- |\n| a \\| b c |');
});

test('empty cells keep their place in the row', () => {
  assert.equal(htmlToMarkdown('<table><tr><th>Input</th><th></th></tr><tr><td>1</td><td></td></tr><tr><td>&nbsp;</td><td>2</td></tr></table>'),
    '| Input |  |\n| --- | --- |\n| 1 |  |\n|  | 2 |');
});

test('a description that starts with a table is legacy HTML; Markdown is kept', () => {
  assert.equal(isLegacyHtml('<table><tr><td>1</td></tr></table>'), true);
  assert.equal(toMarkdown('Use `List<String>` here'), 'Use `List<String>` here');
});
