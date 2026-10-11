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
//
// Env: LEARNING_API_KEY (required), LEARNING_API_URL (default https://learning.bsf.md/api).
// Node's fetch passes the site's Cloudflare check; Python's urllib does not (error 1010), so use
// this helper or curl rather than urllib/requests.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

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
  default:
    console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 14).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(cmd ? 2 : 0);
}
