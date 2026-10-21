// ---------------------------------------------------------------------------
// Notebook <-> Markdown, the authoring format used by the course-content skill and by
// Import / Export in the app.
//
//   # Streams: filter, map, collect          <- text cell (the first "# " heading is the title)
//
//   ```java run                               <- a code cell
//   var xs = List.of(1, 2, 3);
//   ```
//
//   Text between code cells is one text cell.
//   <!-- cell -->                             <- splits two text cells
//
//   ```input                                 <- right after a code cell: what its Scanner reads
//   5 7
//   ```
//
// A ```java fence without "run" (or any other fence) stays inside the text cell, highlighted but
// not runnable. A code cell whose source contains ``` lines is written with a longer fence.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const CELL_SPLIT = '<!-- cell -->';
const newId = () => crypto.randomBytes(6).toString('base64url');

function parseNotebookMarkdown(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const cells = [];
  let text = [];
  let code = null; // {fence, lines}
  let textFence = null; // fence marker while inside a non-runnable fence of a text cell
  let lastCode = null; // the code cell just closed, while only blank lines follow it
  let input = null; // {fence, lines, cell} while inside an ```input fence

  const flushText = () => {
    while (text.length && !text[0].trim()) text.shift();
    while (text.length && !text[text.length - 1].trim()) text.pop();
    if (text.length) cells.push({ id: newId(), kind: 'text', source: text.join('\n') });
    text = [];
  };

  for (const line of lines) {
    if (input) {
      // A new ```java run fence also ends an input someone forgot to close, so nothing after it is lost
      // (only a plain ``` input fence: a longer one was chosen on purpose to hold such lines)
      const closesAt = line.trim() === input.fence ? 'fence' : (input.fence === '```' && /^(`{3,})\s*java\s+run\s*$/i.test(line) ? 'code' : null);
      if (!closesAt) { input.lines.push(line); continue; }
      if (input.lines.length) input.cell.input = input.lines.join('\n');
      input = null;
      if (closesAt === 'fence') continue;
    }
    if (code) {
      if (line.trim() === code.fence) {
        lastCode = { id: newId(), kind: 'code', source: code.lines.join('\n') };
        cells.push(lastCode);
        code = null;
      } else code.lines.push(line);
      continue;
    }
    if (lastCode) {
      const inputOpen = line.match(/^(`{3,})\s*input\s*$/i);
      if (inputOpen) { input = { fence: inputOpen[1], lines: [], cell: lastCode }; lastCode = null; continue; }
      if (line.trim()) lastCode = null;
    }
    if (textFence) {
      text.push(line);
      if (line.trim() === textFence) textFence = null;
      continue;
    }
    const open = line.match(/^(`{3,})\s*java\s+run\s*$/i);
    if (open) {
      flushText();
      code = { fence: open[1], lines: [] };
      continue;
    }
    const otherFence = line.match(/^(`{3,}|~{3,})/);
    if (otherFence) {
      textFence = otherFence[1];
      text.push(line);
      continue;
    }
    if (line.trim() === CELL_SPLIT) { flushText(); continue; }
    text.push(line);
  }
  // An unclosed code fence still becomes a cell rather than losing the code
  if (code) cells.push({ id: newId(), kind: 'code', source: code.lines.join('\n') });
  if (input && input.lines.length) input.cell.input = input.lines.join('\n');
  flushText();

  const firstText = cells.find((c) => c.kind === 'text');
  const heading = firstText && firstText.source.split('\n').find((l) => /^#\s+\S/.test(l));
  const title = heading ? heading.replace(/^#\s+/, '').trim().slice(0, 255) : null;
  return { title, cells };
}

function fenceFor(source) {
  let longest = 2;
  for (const m of String(source).matchAll(/^(`{3,})/gm)) longest = Math.max(longest, m[1].length);
  return '`'.repeat(longest + 1);
}

function notebookToMarkdown(cells) {
  const parts = [];
  let previous = null;
  for (const cell of cells || []) {
    if (cell.kind === 'code') {
      const fence = fenceFor(cell.source);
      parts.push(`${fence}java run\n${cell.source}\n${fence}`);
      if (cell.input) {
        const inputFence = fenceFor(cell.input);
        parts.push(`${inputFence}input\n${cell.input.replace(/\n$/, '')}\n${inputFence}`);
      }
    } else {
      if (previous === 'text') parts.push(CELL_SPLIT);
      parts.push(cell.source);
    }
    previous = cell.kind;
  }
  return `${parts.join('\n\n')}\n`;
}

module.exports = { parseNotebookMarkdown, notebookToMarkdown, CELL_SPLIT };
