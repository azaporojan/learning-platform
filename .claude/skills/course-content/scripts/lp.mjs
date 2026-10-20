#!/usr/bin/env node
// Learning Platform API helper (Node 18+, no dependencies).
//
//   node lp.mjs tree [courseId]                 course → phases → lessons → tasks / study sets / files (ids)
//   node lp.mjs get <path>                      GET  /api<path>, pretty JSON
//   node lp.mjs post <path> <file.json>         POST JSON body from a file
//   node lp.mjs put <path> <file.json>          PUT  JSON body from a file
//   node lp.mjs delete <path>                   DELETE (destructive: confirm with the user first)
//   node lp.mjs script-get <lessonId> [out.md]  lesson script (Markdown) → stdout or file
//   node lp.mjs script-put <lessonId> <file.md> save a lesson script; refuses to overwrite a newer server copy
//   node lp.mjs upload <lessonId> <file>...     attach PDF/DOCX/PPTX/TXT/MD files to a lesson
//   node lp.mjs download <fileId> <out>         save a lesson file (e.g. an existing deck to study)
//   node lp.mjs notebook-get <notebookId> [out.md]          a notebook as Markdown → stdout or file
//   node lp.mjs notebook-put <lessonId> <file.md> [--id N] [--publish] [--title T]
//                                               new lesson notebook from Markdown (images next to the .md are
//                                               uploaded); --id replaces notebook N, refusing if it changed meanwhile
//   node lp.mjs notebook-run <notebookId>       run every code cell, print each cell's status
//   node lp.mjs check-get <taskId>              a task's auto-check (hidden tests, starter, limits)
//   node lp.mjs check-put <taskId> <testsDir> [--starter dir] [--timeout s] [--auto] [--off]
//                                               set the hidden JUnit tests (.java files under package folders)
//   node lp.mjs check-try <taskId> <solutionDir> run the hidden tests against a solution, print the result
//
// Env: LEARNING_API_KEY (required), LEARNING_API_URL (default https://learning.bsf.md/api).
// Node's fetch passes the site's Cloudflare check; Python's urllib does not (error 1010), so use
// this helper or curl rather than urllib/requests.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { basename, extname, dirname, join, relative, sep } from 'node:path';

const API = (process.env.LEARNING_API_URL || 'https://learning.bsf.md/api').replace(/\/$/, '');
const KEY = process.env.LEARNING_API_KEY;
if (!KEY) { console.error('LEARNING_API_KEY is not set'); process.exit(2); }
const auth = { Authorization: `Bearer ${KEY}` };

async function call(method, path, body) {
  const headers = { ...auth };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(API + path, { method, headers, body: payload });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    console.error(`${method} ${path} → ${res.status}`);
    console.error(typeof data === 'string' ? data.slice(0, 2000) : JSON.stringify(data, null, 2));
    process.exit(1);
  }
  return data;
}

const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const print = (d) => console.log(typeof d === 'string' ? d : JSON.stringify(d, null, 2));

const MIME = { '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };


// --flag value / --flag options after the positional arguments
function options(list, flags) {
  const out = { _: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (flags.includes(name)) out[name] = true;
      else out[name] = list[++i];
    } else out._.push(a);
  }
  return out;
}

// Java files under a folder, as [{path: 'shop/Cart.java', content}]
function javaFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.java')) out.push({ path: relative(dir, full).split(sep).join('/'), content: readFileSync(full, 'utf8') });
    }
  };
  walk(dir);
  if (out.length === 0) { console.error(`no .java files under ${dir}`); process.exit(2); }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// The notebook form: the Markdown plus every relative image it references, sent under its relative path
function notebookForm(file) {
  const md = readFileSync(file, 'utf8');
  const fd = new FormData();
  fd.append('notebook', new Blob([md], { type: 'text/markdown' }), basename(file));
  const IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
  const seen = new Set();
  for (const m of md.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) {
    const ref = m[1].replace(/^\.\//, '');
    if (/^[a-z]+:|^\//i.test(ref) || seen.has(ref)) continue;
    const full = join(dirname(file), ref);
    if (!existsSync(full)) { console.error(`image not found: ${ref}`); process.exit(2); }
    seen.add(ref);
    fd.append('files', new Blob([readFileSync(full)], { type: IMG[extname(ref).toLowerCase()] || 'application/octet-stream' }), ref);
  }
  return { fd, images: seen.size };
}

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case 'tree': {
    const courses = await call('GET', '/courses');
    const ids = args[0] ? [Number(args[0])] : courses.map((c) => c.id);
    for (const id of ids) {
      const c = await call('GET', `/courses/${id}`);
      console.log(`COURSE ${c.id} ${c.name}`);
      for (const p of c.phases || []) {
        console.log(`  PHASE ${p.id} [#${p.order_index}${p.requires_previous ? ', gated' : ''}${p.stars_required ? `, ${p.stars_required}★` : ''}] ${p.name}`);
        for (const l of p.lessons || []) {
          console.log(`    LESSON ${l.id} [#${l.order_index}] ${l.title}`);
          for (const t of l.tasks || []) console.log(`      task ${t.id} (${t.type}, ${t.xp_reward}★, due ${t.deadline ? t.deadline.slice(0, 10) : '—'}) ${t.title}`);
          for (const s of l.study_sets || []) console.log(`      ${s.kind} ${s.id} (${s.item_count} items) ${s.title}`);
          for (const f of l.files || []) console.log(`      file ${f.id} ${f.name}`);
        }
      }
    }
    break;
  }
  case 'get': print(await call('GET', args[0])); break;
  case 'post': print(await call('POST', args[0], readJson(args[1]))); break;
  case 'put': print(await call('PUT', args[0], readJson(args[1]))); break;
  case 'delete': print(await call('DELETE', args[0])); break;
  case 'script-get': {
    const d = await call('GET', `/lessons/${args[0]}/script`);
    if (args[1]) { writeFileSync(args[1], d.script || ''); console.error(`saved ${args[1]} (updated ${d.script_updated_at || 'never'})`); }
    else process.stdout.write(d.script || '');
    break;
  }
  case 'script-put': {
    // Read the current timestamp first so a script edited elsewhere in the meantime is not overwritten (409).
    const cur = await call('GET', `/lessons/${args[0]}/script`);
    const script = readFileSync(args[1], 'utf8');
    print(await call('PUT', `/lessons/${args[0]}/script`, { script, expected_script_updated_at: cur.script_updated_at ?? null }));
    break;
  }
  case 'upload': {
    const fd = new FormData();
    for (const f of args.slice(1)) fd.append('files', new Blob([readFileSync(f)], { type: MIME[extname(f).toLowerCase()] || 'application/octet-stream' }), basename(f));
    print(await call('POST', `/lessons/${args[0]}/files`, fd));
    break;
  }
  case 'download': {
    const res = await fetch(`${API}/lesson-files/${args[0]}/download`, { headers: auth });
    if (!res.ok) { console.error(`download ${args[0]} → ${res.status}`); process.exit(1); }
    writeFileSync(args[1], Buffer.from(await res.arrayBuffer()));
    console.error(`saved ${args[1]}`);
    break;
  }
  case 'notebook-get': {
    const res = await fetch(`${API}/notebooks/${args[0]}/export`, { headers: auth });
    if (!res.ok) { console.error(`notebook-get ${args[0]} → ${res.status}`); process.exit(1); }
    const md = await res.text();
    if (args[1]) { writeFileSync(args[1], md); console.error(`saved ${args[1]}`); } else process.stdout.write(md);
    break;
  }
  case 'notebook-put': {
    const o = options(args, ['publish']);
    const [lessonId, file] = o._;
    if (!file) { console.error('usage: notebook-put <lessonId> <file.md> [--id N] [--publish] [--title T]'); process.exit(2); }
    const { fd, images } = notebookForm(file);
    if (o.title) fd.append('title', o.title);
    if (o.id) {
      // Replace the cells of an existing notebook; its current revision guards against overwriting edits made meanwhile
      const cur = await call('GET', `/notebooks/${o.id}`);
      fd.append('baseRevision', String(cur.revision));
      const r = await call('PUT', `/notebooks/${o.id}/markdown`, fd);
      if (o.publish && !cur.published) await call('PUT', `/notebooks/${o.id}`, { published: true });
      console.log(`updated notebook ${o.id} (revision ${r.revision}, ${images} image(s))`);
    } else {
      if (lessonId && lessonId !== 'none') fd.append('lessonId', String(lessonId));
      if (o.publish) fd.append('published', 'true');
      const nb = await call('POST', '/notebooks/import', fd);
      console.log(`created notebook ${nb.id} "${nb.title}": ${nb.cell_count} cells (${nb.code_cell_count} code), ${images} image(s)${nb.published ? ', published' : ', draft'}`);
    }
    break;
  }
  case 'notebook-run': {
    const nb = await call('GET', `/notebooks/${args[0]}`);
    const r = await call('POST', `/notebooks/${args[0]}/run`, {});
    let i = 0;
    for (const c of nb.cells) {
      if (c.kind !== 'code') continue;
      i += 1;
      const o = r.outputs[c.id];
      const first = c.source.split('\n')[0].slice(0, 60);
      const detail = !o ? '' : o.status === 'ok' ? (o.value !== null ? ` → ${String(o.value).slice(0, 60)}` : '') : ` → ${(o.error && o.error.message || o.status).split('\n')[0].slice(0, 120)}`;
      console.log(`${String(i).padStart(3)}  ${(o ? o.status : '—').padEnd(8)} ${first}${detail}`);
    }
    console.log(`run: ${r.status} in ${r.durationMs} ms`);
    if (r.status !== 'ok') process.exitCode = 1;
    break;
  }
  case 'check-get': print(await call('GET', `/tasks/${args[0]}/check`)); break;
  case 'check-put': {
    const o = options(args, ['auto', 'off']);
    const [taskId, testsDir] = o._;
    if (!testsDir) { console.error('usage: check-put <taskId> <testsDir> [--starter dir] [--timeout s] [--auto] [--off]'); process.exit(2); }
    const body = { tests: javaFiles(testsDir), starter: o.starter ? javaFiles(o.starter) : [], timeoutS: o.timeout ? Number(o.timeout) : 30, autoApprove: Boolean(o.auto), enabled: !o.off };
    const r = await call('PUT', `/tasks/${taskId}/check`, body);
    console.log(`task ${taskId}: ${r.tests.length} test file(s), ${r.starter.length} starter file(s), ${r.timeout_s} s, auto-approve ${r.auto_approve ? 'on' : 'off'}, ${r.enabled ? 'on' : 'off'}`);
    break;
  }
  case 'check-try': {
    const r = await call('POST', `/tasks/${args[0]}/check/try`, { files: javaFiles(args[1]) });
    console.log(`${r.status}: ${r.summary}`);
    for (const f of (r.tests && r.tests.failed) || []) console.log(`  ✗ ${f.name}: ${f.message.split('\n')[0]}`);
    for (const d of r.diagnostics || []) console.log(`  ${d.file || 'compiler'}${d.line ? ':' + d.line : ''}: ${d.message.split('\n')[0]}`);
    if (r.status !== 'passed') process.exitCode = 1;
    break;
  }
  default:
    console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 25).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(cmd ? 2 : 0);
}
