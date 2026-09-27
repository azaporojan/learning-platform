// Integration smoke test: boots the real server against a PostgreSQL database
// (DB_* env vars), applies the migrations and exercises the auth + authorization
// rules that the security review fixed. Skipped when no database is reachable.
//
//   DB_HOST=localhost DB_NAME=learning_test DB_USER=learning DB_PASSWORD=learning npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Client } = require('pg');

const PORT = 3900 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}/api`;
const ADMIN_EMAIL = 'admin@example.test';
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'learning',
  password: process.env.DB_PASSWORD || 'learning',
  database: process.env.DB_NAME || 'learning_test',
};

async function dbReachable() {
  const c = new Client(dbConfig);
  try {
    await c.connect();
    await c.end();
    return true;
  } catch (e) {
    return false;
  }
}

async function resetDb() {
  const c = new Client(dbConfig);
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
}

async function readLoginCode(email) {
  const c = new Client(dbConfig);
  await c.connect();
  const { rows } = await c.query('SELECT login_code FROM users WHERE email = $1', [email]);
  await c.end();
  return rows[0].login_code;
}

function startServer(uploadsDir) {
  const child = spawn(process.execPath, ['index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      DB_HOST: dbConfig.host,
      DB_PORT: String(dbConfig.port),
      DB_USER: dbConfig.user,
      DB_PASSWORD: dbConfig.password,
      DB_NAME: dbConfig.database,
      JWT_SECRET: process.env.JWT_SECRET || 'test-only-jwt-secret-that-is-long-enough-0123456789',
      BOOTSTRAP_ADMIN_EMAIL: ADMIN_EMAIL,
      UPLOADS_DIR: uploadsDir,
      EMAIL_USER: '',
      EMAIL_PASS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  child.getOutput = () => output;
  return child;
}

async function waitForHealth(child) {
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${child.getOutput()}`);
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not become healthy:\n${child.getOutput()}`);
}

// Minimal cookie-jar fetch
function session() {
  let cookieHeader = '';
  return async (pathname, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (cookieHeader) headers.cookie = cookieHeader;
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(opts.json);
    }
    const res = await fetch(`${BASE}${pathname}`, { ...opts, headers });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookieHeader = setCookie.split(';')[0];
    let body = null;
    try { body = await res.json(); } catch (e) { /* non-JSON */ }
    return { status: res.status, body, res };
  };
}

async function loginAs(email, password) {
  const s = session();
  const login = await s('/login', { method: 'POST', json: { email, password } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const code = await readLoginCode(email);
  const verify = await s('/verify-code', { method: 'POST', json: { userId: login.body.userId, code } });
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  return s;
}

test('API smoke test against PostgreSQL', { timeout: 120000 }, async (t) => {
  if (!(await dbReachable())) {
    t.skip(`no PostgreSQL reachable at ${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
    return;
  }
  await resetDb();
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-uploads-'));
  const child = startServer(uploadsDir);
  t.after(() => { child.kill('SIGTERM'); fs.rmSync(uploadsDir, { recursive: true, force: true }); });
  await waitForHealth(child);

  const anon = session();

  // Migrations seeded the default paths; anonymous callers can list them.
  const paths = await anon('/paths');
  assert.equal(paths.status, 200);
  assert.equal(paths.body.length, 2);

  // Admin-only routes reject anonymous requests (used to be wide open).
  for (const [method, url] of [['POST', '/lessons'], ['POST', '/tasks'], ['DELETE', '/lessons/1'], ['DELETE', '/tasks/1'], ['POST', '/upload-image']]) {
    const r = await anon(url, { method, json: {} });
    assert.equal(r.status, 401, `${method} ${url} should require auth`);
  }

  // Registration validation + bootstrap admin
  const weak = await anon('/register', { method: 'POST', json: { name: 'A', email: 'bad', password: 'short' } });
  assert.equal(weak.status, 400);
  const adminReg = await anon('/register', { method: 'POST', json: { name: 'Admin', email: ADMIN_EMAIL, password: 'AdminPass123!' } });
  assert.equal(adminReg.status, 201, JSON.stringify(adminReg.body));
  const studentReg = await anon('/register', { method: 'POST', json: { name: 'Student', email: 'student@example.test', password: 'StudentPass1!' } });
  assert.equal(studentReg.status, 201, JSON.stringify(studentReg.body));

  // Unapproved student cannot log in yet
  const blocked = await anon('/login', { method: 'POST', json: { email: 'student@example.test', password: 'StudentPass1!' } });
  assert.equal(blocked.status, 403);

  // Admin login via email code (read from DB — no SMTP in tests)
  const admin = await loginAs(ADMIN_EMAIL, 'AdminPass123!');
  const me = await admin('/me');
  assert.equal(me.body.user.role, 'admin');

  // Wrong 2FA code handling: 5 wrong attempts invalidate the code
  const s2 = session();
  const l2 = await s2('/login', { method: 'POST', json: { email: ADMIN_EMAIL, password: 'AdminPass123!' } });
  assert.equal(l2.status, 200);
  for (let i = 0; i < 4; i++) {
    const w = await s2('/verify-code', { method: 'POST', json: { userId: l2.body.userId, code: '000000' } });
    assert.equal(w.status, 400);
    assert.equal(w.body.error, 'Incorrect code.');
  }
  const fifth = await s2('/verify-code', { method: 'POST', json: { userId: l2.body.userId, code: '000000' } });
  assert.equal(fifth.status, 400);
  assert.match(fifth.body.error, /Too many incorrect attempts/);

  // Admin approves the student; notifications metadata round-trips through JSONB
  const users = await admin('/admin/users');
  const student = users.body.find((u) => u.email === 'student@example.test');
  assert.equal(student.is_approved, false);
  const approve = await admin(`/users/${student.id}/approve`, { method: 'POST' });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  const adminNotifs = await admin('/notifications');
  const pending = adminNotifs.body.find((n) => n.type === 'new_user_pending');
  assert.equal(pending.metadata.userId, student.id);
  assert.equal(pending.status, 'approved');

  // Content creation as admin (lesson → task) and the deadline normalisation
  const lesson = await admin('/lessons', { method: 'POST', json: { pathId: paths.body[0].id, title: 'Intro', order: 1 } });
  assert.equal(lesson.status, 201, JSON.stringify(lesson.body));
  const task = await admin('/tasks', { method: 'POST', json: { lessonId: lesson.body.id, title: 'Task 1', type: 'mandatory', xp: 10, deadline: '2030-01-01' } });
  assert.equal(task.status, 201, JSON.stringify(task.body));
  const details = await admin(`/paths/${paths.body[0].id}/details`);
  assert.equal(details.status, 200);
  assert.equal(details.body[0].tasks.length, 1);

  // Student session: cannot touch admin routes, can view + submit, sees only own submissions
  const stud = await loginAs('student@example.test', 'StudentPass1!');
  const forbidden = await stud('/lessons', { method: 'POST', json: { pathId: 1, title: 'x', order: 2 } });
  assert.equal(forbidden.status, 403);
  const addStars = await stud(`/admin/users/${student.id}/add-stars`, { method: 'POST', json: { stars: 100 } });
  assert.equal(addStars.status, 403);

  const viewed = await stud(`/tasks/${task.body.id}/mark-viewed`, { method: 'POST' });
  assert.equal(viewed.status, 200);
  const viewedAgain = await stud(`/tasks/${task.body.id}/mark-viewed`, { method: 'POST' }); // upsert path
  assert.equal(viewedAgain.status, 200);

  const form = new FormData();
  form.append('file', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), '../evil name.html');
  const submit = await stud(`/tasks/${task.body.id}/submit`, { method: 'POST', body: form });
  assert.equal(submit.status, 201, JSON.stringify(submit.body));
  const stored = fs.readdirSync(uploadsDir);
  assert.equal(stored.length, 1);
  assert.match(stored[0], /-evil_name\.html$/); // sanitised basename, no traversal

  // HTML uploads are served as downloads, never rendered inline
  const raw = await fetch(`${BASE}/uploads/${stored[0]}`);
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get('content-disposition'), 'attachment');
  assert.equal(raw.headers.get('x-content-type-options'), 'nosniff');

  // Download requires auth and ownership (or admin)
  const anonDl = await anon(`/submissions/download/${submit.body.id}`);
  assert.equal(anonDl.status, 401);
  const ownDl = await stud(`/submissions/download/${submit.body.id}`);
  assert.equal(ownDl.status, 200);
  const adminDl = await admin(`/submissions/download/${submit.body.id}`);
  assert.equal(adminDl.status, 200);

  // Approve-all grants stars (bigint/count and boolean columns come back as JS numbers/booleans)
  const approveAll = await admin(`/tasks/${task.body.id}/approve-all`, { method: 'POST', json: { studentId: student.id } });
  assert.equal(approveAll.status, 200, JSON.stringify(approveAll.body));
  const leaderboard = await anon('/users');
  assert.equal(leaderboard.body[0].stars, 10);

  // Chats: membership enforced, bulk insert + ON CONFLICT paths work
  const chat = await admin('/chats', { method: 'POST', json: { name: 'General', memberIds: [student.id, student.id, 9999] } });
  assert.equal(chat.status, 201, JSON.stringify(chat.body));
  const msg = await stud(`/chats/${chat.body.id}/messages`, { method: 'POST', json: { content: 'hello' } });
  assert.equal(msg.status, 201, JSON.stringify(msg.body));
  const outsider = session();
  const outsiderMsgs = await outsider(`/chats/${chat.body.id}/messages`);
  assert.equal(outsiderMsgs.status, 401);
  const list = await admin('/chats');
  assert.equal(list.body[0].message_count, 1);

  // API keys: created by an admin, usable as a bearer token, revocable
  const noKey = await stud('/admin/api-keys', { method: 'POST', json: { name: 'nope' } });
  assert.equal(noKey.status, 403);
  const created = await admin('/admin/api-keys', { method: 'POST', json: { name: 'claude agent' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.match(created.body.key, /^lp_[0-9a-f]{40}$/);
  const keyList = await admin('/admin/api-keys');
  assert.equal(keyList.body.length, 1);
  assert.equal(keyList.body[0].key, undefined); // never echoed back
  const bearer = { Authorization: `Bearer ${created.body.key}` };

  const bad = await fetch(`${BASE}/admin/api-keys`, { headers: { Authorization: 'Bearer lp_deadbeef' } });
  assert.equal(bad.status, 401);

  // The import endpoint is admin-only: anonymous → 401, student session → 403
  const anonImport = await anon('/admin/paths/import', { method: 'POST', json: { name: 'x', lessons: [] } });
  assert.equal(anonImport.status, 401);
  const studentImport = await stud('/admin/paths/import', { method: 'POST', json: { name: 'x', lessons: [] } });
  assert.equal(studentImport.status, 403);

  // Import a whole path with the key (no cookie)
  const importDoc = {
    name: 'Agent Path',
    description: 'Created by an agent',
    stars_required: 0,
    lessons: [
      { title: 'L1', description: 'first', tasks: [{ title: 'T1', xp: 5 }, { title: 'T2', type: 'optional', deadline: '2031-05-01' }] },
      { title: 'L2', tasks: [{ title: 'T3' }] },
      { title: 'L3' },
    ],
  };
  const invalid = await fetch(`${BASE}/admin/paths/import`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ lessons: [{ title: '' }] }) });
  assert.equal(invalid.status, 400);
  const badTypes = await fetch(`${BASE}/admin/paths/import`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', description: { foo: 'bar' }, lessons: [{ title: 'L', description: 123, tasks: [{ title: 'T', description: ['no'] }] }] }) });
  const badTypesBody = await badTypes.json();
  assert.equal(badTypes.status, 400);
  assert.equal(badTypesBody.details.length, 3);
  const missingPath = await fetch(`${BASE}/admin/paths/import`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ pathId: 999999, lessons: [{ title: 'L' }] }) });
  assert.equal(missingPath.status, 404);
  const imp = await fetch(`${BASE}/admin/paths/import`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify(importDoc) });
  const impBody = await imp.json();
  assert.equal(imp.status, 201, JSON.stringify(impBody));
  assert.equal(impBody.counts.lessons, 3);
  assert.equal(impBody.counts.tasks, 3);
  const importedDetails = await admin(`/paths/${impBody.path.id}/details`);
  assert.equal(importedDetails.body.length, 3);
  assert.equal(importedDetails.body[0].parent_id, null);
  assert.equal(importedDetails.body[1].parent_id, importedDetails.body[0].id);
  assert.equal(importedDetails.body[1].position_x, importedDetails.body[0].position_x + 250);
  assert.equal(importedDetails.body[0].tasks[0].position_y, 250 - 120); // odd lesson → tasks go up
  assert.equal(importedDetails.body[1].tasks[0].position_y, 250 + 120); // even lesson → tasks go down
  assert.equal(importedDetails.body[0].tasks[1].type, 'optional');

  // Append to the existing path continues the chain
  const append = await fetch(`${BASE}/admin/paths/import`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ pathId: impBody.path.id, lessons: [{ title: 'L4' }] }) });
  assert.equal(append.status, 201);
  const appended = await admin(`/paths/${impBody.path.id}/details`);
  assert.equal(appended.body.length, 4);
  assert.equal(appended.body[3].parent_id, importedDetails.body[2].id);
  assert.equal(appended.body[3].order_index, 4);

  // Revoked keys stop working immediately
  const revoke = await admin(`/admin/api-keys/${created.body.id}`, { method: 'DELETE' });
  assert.equal(revoke.status, 200);
  const afterRevoke = await fetch(`${BASE}/admin/api-keys`, { headers: bearer });
  assert.equal(afterRevoke.status, 401);

  // Logout clears the session
  await stud('/logout', { method: 'POST' });
  const afterLogout = await stud('/me');
  assert.equal(afterLogout.status, 401);
});
