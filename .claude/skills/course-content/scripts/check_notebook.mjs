#!/usr/bin/env node
// Checks a notebook lesson (Markdown, see references/notebooks.md) before it is published.
//
//   node check_notebook.mjs lesson.md          lint: format, images, JShell pitfalls, cell sizes
//   node check_notebook.mjs lesson.md --run    and run every code cell on the platform: the file is
//                                              imported as a private playground, run, and deleted
//
// Exit code 1 when there are errors (or a cell fails with --run); warnings alone exit 0.
// --run needs LEARNING_API_KEY (and LEARNING_API_URL for another server).

import { readFileSync, existsSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

const [file, ...flags] = process.argv.slice(2);
if (!file) { console.error('usage: check_notebook.mjs <lesson.md> [--run]'); process.exit(2); }
const md = readFileSync(file, 'utf8');

// Same rules as server/notebookMarkdown.js
function parse(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const cells = [];
  let buf = [];
  let code = null;
  let textFence = null;
  let lastCode = null; // the code cell just closed, while only blank lines follow (an ```input may come)
  let input = null; // {fence, lines, cell} inside an ```input fence
  let startLine = 1;
  const flush = (lineNo) => {
    while (buf.length && !buf[0].trim()) buf.shift();
    while (buf.length && !buf[buf.length - 1].trim()) buf.pop();
    if (buf.length) cells.push({ kind: 'text', source: buf.join('\n'), line: startLine });
    buf = [];
    startLine = lineNo;
  };
  lines.forEach((line, i) => {
    const n = i + 1;
    if (input) {
      if (line.trim() === input.fence) { input.cell.input = input.lines.join('\n'); input = null; startLine = n + 1; return; }
      // Same as the server: a new ```java run fence ends an unclosed input (reported below)
      if (!/^(`{3,})\s*java\s+run\s*$/i.test(line)) { input.lines.push(line); return; }
      input.cell.input = input.lines.join('\n');
      input.cell.inputUnclosed = true;
      input = null;
    }
    if (code) {
      if (line.trim() === code.fence) {
        lastCode = { kind: 'code', source: code.lines.join('\n'), line: code.line };
        cells.push(lastCode); code = null; startLine = n + 1;
      } else code.lines.push(line);
      return;
    }
    if (lastCode) {
      const inputOpen = line.match(/^(`{3,})\s*input\s*$/i);
      if (inputOpen) { input = { fence: inputOpen[1], lines: [], cell: lastCode }; lastCode = null; return; }
      if (line.trim()) lastCode = null;
    }
    if (textFence) { buf.push(line); if (line.trim() === textFence) textFence = null; return; }
    const open = line.match(/^(`{3,})\s*java\s+run\s*$/i);
    if (open) { flush(n); code = { fence: open[1], lines: [], line: n + 1 }; return; }
    const other = line.match(/^(`{3,}|~{3,})/);
    if (other) { textFence = other[1]; buf.push(line); return; }
    if (line.trim() === '<!-- cell -->') { flush(n + 1); return; }
    if (!buf.length) startLine = n;
    buf.push(line);
  });
  if (code) cells.push({ kind: 'code', source: code.lines.join('\n'), line: code.line, unclosed: true });
  if (input) { input.cell.input = input.lines.join('\n'); input.cell.inputUnclosed = true; }
  flush(lines.length);
  return cells;
}

const cells = parse(md);
const errors = [];
const warnings = [];
const at = (c) => `${basename(file)}:${c.line}`;

if (!cells.length) errors.push('the notebook is empty');
if (cells[0] && !(cells[0].kind === 'text' && /^#\s+\S/.test(cells[0].source))) warnings.push('start with a "# Title" text cell (it becomes the title and the first slide)');
const code = cells.filter((c) => c.kind === 'code');
if (!code.length) errors.push('no ```java run cell: nothing for students to run');

for (const c of cells) {
  if (c.kind === 'code') {
    if (c.unclosed) errors.push(`${at(c)} a \`\`\`java run fence is never closed`);
    if (c.inputUnclosed) errors.push(`${at(c)} the \`\`\`input fence after this cell is never closed`);
    if (!c.source.trim()) warnings.push(`${at(c)} empty code cell`);
    if (/^\s*package\s+[\w.]+\s*;/m.test(c.source)) errors.push(`${at(c)} "package" is not allowed in a notebook cell (JShell)`);
    if (/new\s+Scanner\s*\(\s*System\.in\s*\)|System\.in\.read/.test(c.source) && !(c.input || '').trim()) {
      warnings.push(`${at(c)} reads System.in but has no input: add an \`\`\`input fence right after the cell (one value per line)`);
    }
    if (/public\s+static\s+void\s+main\s*\(/.test(c.source)) warnings.push(`${at(c)} a main method is not needed (cells run top to bottom) and is not called by itself`);
    if (/Thread\.sleep\s*\(\s*(\d{4,})/.test(c.source)) warnings.push(`${at(c)} long Thread.sleep: a whole run gets 15 s`);
    if (/\bwhile\s*\(\s*true\s*\)/.test(c.source)) warnings.push(`${at(c)} while (true): make sure it ends (15 s limit)`);
    if (/https?:\/\/|new\s+URL\s*\(|HttpClient/.test(c.source)) warnings.push(`${at(c)} network access: the sandbox has none`);
    const n = c.source.split('\n').length;
    if (n > 25) warnings.push(`${at(c)} ${n} lines: split long code cells (3-12 lines read best)`);
  } else {
    if (c.source.length > 1400) warnings.push(`${at(c)} long text cell (${c.source.length} characters): split it or move detail to a callout`);
    for (const m of c.source.matchAll(/!\[([^\]]*)\]\(([^)\s]+)/g)) {
      const ref = m[2].replace(/^\.\//, '');
      if (!m[1].trim()) warnings.push(`${at(c)} image "${ref}" has no alt text`);
      if (/^[a-z]+:|^\//i.test(ref)) continue;
      if (!existsSync(join(dirname(file), ref))) errors.push(`${at(c)} image not found: ${ref}`);
      else if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(extname(ref).toLowerCase())) errors.push(`${at(c)} ${ref}: images must be PNG, JPEG, GIF, WebP or SVG`);
    }
    for (const m of c.source.matchAll(/^>\s*\*\*([^*]+)\*\*/gm)) {
      const tag = m[1].trim().replace(/[:.]$/, '').toLowerCase();
      if (!['note', 'tip', 'goal', 'warning', 'important', 'istqb', 'exercise'].includes(tag)) warnings.push(`${at(c)} "> **${m[1]}**" is a plain quote, not a callout (Note, Tip, Goal, Warning, Important, ISTQB, Exercise)`);
    }
  }
}

const slides = cells.filter((c) => c.kind === 'text' && /^\s*#{1,2}\s+\S/.test(c.source)).length;
console.log(`${basename(file)}: ${cells.length} cells (${code.length} code, ${cells.length - code.length} text), ${slides} slide(s) in Present mode`);
for (const w of warnings) console.log(`  warning: ${w}`);
for (const e of errors) console.log(`  ERROR:   ${e}`);

if (flags.includes('--run')) {
  if (errors.length) { console.log('not running: fix the errors first'); process.exit(1); }
  const API = (process.env.LEARNING_API_URL || 'https://learning.bsf.md/api').replace(/\/$/, '');
  const KEY = process.env.LEARNING_API_KEY;
  if (!KEY) { console.error('LEARNING_API_KEY is not set (needed for --run)'); process.exit(2); }
  const auth = { Authorization: `Bearer ${KEY}` };
  const call = async (method, path, body) => {
    const res = await fetch(API + path, {
      method, headers: body instanceof FormData ? auth : { ...auth, 'Content-Type': 'application/json' },
      body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data && data.error ? data.error : ''}`);
    return data;
  };
  const fd = new FormData();
  fd.append('notebook', new Blob([md], { type: 'text/markdown' }), basename(file));
  fd.append('title', `[check] ${basename(file)}`);
  let nb;
  let failed = false;
  try {
    nb = await call('POST', '/notebooks/import', fd);
    const r = await call('POST', `/notebooks/${nb.id}/run`, {});
    let i = 0;
    for (const c of nb.cells) {
      if (c.kind !== 'code') continue;
      i += 1;
      const o = r.outputs[c.id];
      const first = c.source.split('\n')[0].slice(0, 60);
      if (!o || o.status === 'ok') {
        console.log(`  cell ${String(i).padStart(2)} ok      ${first}${o && o.value !== null ? `  → ${String(o.value).slice(0, 50)}` : ''}`);
      } else {
        failed = true;
        console.log(`  cell ${String(i).padStart(2)} ${o.status.toUpperCase().padEnd(7)} ${first}\n           ${(o.error ? o.error.message : o.status).split('\n').slice(0, 3).join('\n           ')}`);
      }
    }
    console.log(`run: ${r.status} in ${r.durationMs} ms${failed ? ' (a cell that fails on purpose must say so in the text before it)' : ''}`);
  } catch (e) {
    failed = true;
    console.error(`run failed: ${e.message}`);
  } finally {
    if (nb) await call('DELETE', `/notebooks/${nb.id}`).catch(() => console.error(`could not delete the temporary notebook ${nb.id}`));
  }
  process.exit(errors.length || failed ? 1 : 0);
}
process.exit(errors.length ? 1 : 0);
