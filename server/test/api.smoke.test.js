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

// The database only holds a hash of the emailed login code; without SMTP (tests, dev) the
// server prints the code itself, so the latest one is read from its output.
let serverOutput = () => '';
async function readLoginCode(email) {
  const re = new RegExp(`login code for ${email.toLowerCase().replace(/[.]/g, '\\.')}: (\\d{6})`, 'g');
  for (let i = 0; i < 40; i++) {
    const all = [...serverOutput().matchAll(re)];
    if (all.length > 0) return all[all.length - 1][1];
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no login code logged for ${email}`);
}

async function dbQuery(sql, params) {
  const c = new Client(dbConfig);
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
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
      PASSWORD_PEPPER: 'dGVzdC1vbmx5LXBlcHBlci10aGF0LWlzLTMyLWJ5dGVzLWxvbmch', // test-only, 37 bytes
      PASSWORD_BREACH_CHECK: 'false',
      LOG_LOGIN_CODES: 'true',        // no SMTP here: read codes from the log (never on by default) // no network in CI; covered by test/passwords.test.js
      AUTH_RATE_LIMIT: '1000',        // the suite logs in far more than a real user would
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
  const call = async (pathname, opts = {}) => {
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
  call.cookie = () => cookieHeader;
  return call;
}

// Notification emails are sent without blocking the request (and only logged in tests, where
// SMTP is not configured): wait for the log line.
async function waitForOutput(child, pattern) {
  for (let i = 0; i < 40; i++) {
    if (pattern.test(child.getOutput())) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`server output never matched ${pattern}:\n${child.getOutput().slice(-2000)}`);
}

// Lesson material bytes (the .orphaned/ folder aside)
const lessonFileCount = (dir) => fs.readdirSync(path.join(dir, 'lesson-files')).filter((f) => !f.startsWith('.')).length;

// Files in the uploads root (lesson materials live in their own subfolder)
const uploadedFiles = (dir) => fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());

// The server removes a rejected upload asynchronously: give the unlink a moment to land
async function eventually(check, message) {
  for (let i = 0; i < 40; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(message);
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
  // A lesson file whose row is gone (e.g. the DB was restored from an older backup) is set aside
  // at startup, never deleted
  fs.mkdirSync(path.join(uploadsDir, 'lesson-files'), { recursive: true });
  const stray = path.join(uploadsDir, 'lesson-files', '1700000000000-abc.pdf');
  fs.writeFileSync(stray, '%PDF-1.4 stray');
  fs.utimesSync(stray, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
  const child = startServer(uploadsDir);
  serverOutput = child.getOutput;
  t.after(() => { child.kill('SIGTERM'); fs.rmSync(uploadsDir, { recursive: true, force: true }); });
  await waitForHealth(child);
  await eventually(() => fs.existsSync(path.join(uploadsDir, 'lesson-files', '.orphaned', '1700000000000-abc.pdf')), 'the orphaned file was not set aside');
  assert.equal(fs.readFileSync(path.join(uploadsDir, 'lesson-files', '.orphaned', '1700000000000-abc.pdf'), 'utf8'), '%PDF-1.4 stray');
  assert.equal(lessonFileCount(uploadsDir), 0);

  const anon = session();

  // A fresh install starts with an empty catalogue (003 removes the unused demo paths of 001);
  // anonymous callers can list paths and courses.
  const emptyPaths = await anon('/paths');
  assert.equal(emptyPaths.status, 200);
  assert.equal(emptyPaths.body.length, 0);
  const emptyCourses = await anon('/courses');
  assert.equal(emptyCourses.status, 200);
  assert.deepEqual(emptyCourses.body, []);

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
  // Every notification deep-links into the app, and its email carries the same link
  assert.equal(pending.link, `/users?user=${student.id}`);
  await waitForOutput(child, /to=admin@example\.test subject="New User Registered" link=\S+\/users\?user=\d+/);
  await waitForOutput(child, /to=student@example\.test subject="Account Approved! 🎉" link=\S+\/courses\b/);

  // Courses: admin creates a course and two phases; the second phase is gated on the first
  const anonCourse = await anon('/courses', { method: 'POST', json: { name: 'x' } });
  assert.equal(anonCourse.status, 401);
  const badCourse = await admin('/courses', { method: 'POST', json: { name: '' } });
  assert.equal(badCourse.status, 400);
  const course = await admin('/courses', { method: 'POST', json: { name: 'QA Automation Engineer', description: 'd' } });
  assert.equal(course.status, 201, JSON.stringify(course.body));
  const phase1 = await admin('/paths', { method: 'POST', json: { name: 'Phase 1', stars_required: 0, course_id: course.body.id } });
  assert.equal(phase1.status, 200, JSON.stringify(phase1.body));
  assert.equal(phase1.body.order_index, 1);
  const phase2 = await admin('/paths', { method: 'POST', json: { name: 'Phase 2', stars_required: 0, course_id: course.body.id } });
  assert.equal(phase2.body.order_index, 2);
  assert.equal(phase2.body.requires_previous, true);
  const badPhase = await admin(`/paths/${phase2.body.id}`, { method: 'PUT', json: { name: 'Phase 2', requires_previous: 'yes' } });
  assert.equal(badPhase.status, 400);
  const badStars = await admin(`/paths/${phase2.body.id}`, { method: 'PUT', json: { name: 'Phase 2', stars_required: 'lots' } });
  assert.equal(badStars.status, 400);
  const negativeStars = await admin('/paths', { method: 'POST', json: { name: 'x', stars_required: -1 } });
  assert.equal(negativeStars.status, 400);
  const hugeOrder = await admin(`/paths/${phase2.body.id}`, { method: 'PUT', json: { name: 'Phase 2', order_index: 2147483647 } });
  assert.equal(hugeOrder.status, 400);

  // Concurrent appends and moves in one course never collide (course row lock, fixed lock order)
  const busy = await admin('/courses', { method: 'POST', json: { name: 'Busy' } });
  const appended6 = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => admin('/paths', { method: 'POST', json: { name: `B${n}`, course_id: busy.body.id } })));
  assert.deepEqual(appended6.map((r) => r.status), [200, 200, 200, 200, 200, 200]);
  const busyIds = appended6.map((r) => r.body.id);
  const reordered6 = await Promise.all(busyIds.map((pid, i) => admin(`/paths/${pid}`, { method: 'PUT', json: { name: `B${i + 1}m`, order_index: 6 - i } })));
  assert.deepEqual(reordered6.map((r) => r.status), [200, 200, 200, 200, 200, 200]);
  const busyRoad = await admin(`/courses/${busy.body.id}`);
  assert.deepEqual(busyRoad.body.phases.map((p) => p.order_index), [1, 2, 3, 4, 5, 6]);
  const dropped = await Promise.all(busyIds.map((pid) => admin(`/paths/${pid}`, { method: 'DELETE' })));
  assert.deepEqual(dropped.map((r) => r.status), [200, 200, 200, 200, 200, 200]);
  assert.equal((await admin(`/courses/${busy.body.id}`, { method: 'DELETE' })).status, 200);
  const noName = await admin('/paths', { method: 'POST', json: { course_id: course.body.id } });
  assert.equal(noName.status, 400);
  const ghostCourse = await admin('/paths', { method: 'POST', json: { name: 'x', course_id: 999999 } });
  assert.equal(ghostCourse.status, 404);
  const ghostCoursePut = await admin(`/paths/${phase2.body.id}`, { method: 'PUT', json: { name: 'Phase 2', course_id: 999999 } });
  assert.equal(ghostCoursePut.status, 404);
  const missingPhase = await admin('/paths/999999', { method: 'PUT', json: { name: 'x' } });
  assert.equal(missingPhase.status, 404);
  const paths = await anon('/paths');
  assert.equal(paths.body.length, 2);
  assert.equal(paths.body[0].course_id, course.body.id);

  // Content creation as admin (lesson → task) and the deadline normalisation
  const lesson = await admin('/lessons', { method: 'POST', json: { pathId: paths.body[0].id, title: 'Intro', order: 1 } });
  assert.equal(lesson.status, 201, JSON.stringify(lesson.body));
  const task = await admin('/tasks', { method: 'POST', json: { lessonId: lesson.body.id, title: 'Task 1', type: 'mandatory', xp: 10, deadline: '2030-01-01' } });
  assert.equal(task.status, 201, JSON.stringify(task.body));
  const details = await admin(`/paths/${paths.body[0].id}/details`);
  assert.equal(details.status, 200);
  assert.equal(details.body[0].tasks.length, 1);
  // Response shape of the legacy route stays stable (explicit column list)
  for (const key of ['id', 'path_id', 'title', 'description', 'position_x', 'position_y', 'order_index', 'parent_id', 'created_at', 'updated_at', 'completed', 'tasks']) {
    assert.ok(key in details.body[0], `details lesson is missing ${key}`);
  }

  // Moving nodes: PUT accepts optional order / position / parent so a path can be restructured
  // without deleting lessons (which would cascade to tasks and submissions).
  const second = await admin('/lessons', { method: 'POST', json: { pathId: paths.body[0].id, title: 'Second', order: 2, x: 330, y: 250, parentId: lesson.body.id } });
  assert.equal(second.status, 201);
  const moved = await admin(`/lessons/${lesson.body.id}`, { method: 'PUT', json: { title: 'Intro (moved)', description: 'd', order: 3, x: 580, y: 250, parentId: second.body.id } });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const movedTask = await admin(`/tasks/${task.body.id}`, { method: 'PUT', json: { title: 'Task 1', type: 'mandatory', xp: 10, deadline: '2030-01-01', x: 700, y: 130 } });
  assert.equal(movedTask.status, 200, JSON.stringify(movedTask.body));
  const reordered = await admin(`/paths/${paths.body[0].id}/details`);
  assert.deepEqual(reordered.body.map((l) => [l.title, l.order_index, l.position_x, l.parent_id]), [['Second', 2, 330, lesson.body.id], ['Intro (moved)', 3, 580, second.body.id]]);
  assert.equal(reordered.body[1].tasks[0].position_x, 700);
  assert.equal(reordered.body[1].tasks[0].position_y, 130);
  // Plain title/description updates (the UI's call) keep working and leave the graph alone
  const renamed = await admin(`/lessons/${lesson.body.id}`, { method: 'PUT', json: { title: 'Intro', description: '' } });
  assert.equal(renamed.status, 200);
  const unchanged = await admin(`/paths/${paths.body[0].id}/details`);
  assert.equal(unchanged.body[1].order_index, 3);
  const badOrder = await admin(`/lessons/${lesson.body.id}`, { method: 'PUT', json: { title: 'Intro', order: 0 } });
  assert.equal(badOrder.status, 400);
  const selfParent = await admin(`/lessons/${lesson.body.id}`, { method: 'PUT', json: { title: 'Intro', parentId: lesson.body.id } });
  assert.equal(selfParent.status, 400);
  const missing = await admin('/lessons/999999', { method: 'PUT', json: { title: 'nope' } });
  assert.equal(missing.status, 404);
  // Lesson script (admin-only Markdown notes): saved/read by admins, invisible everywhere else
  const badScript = await admin(`/lessons/${lesson.body.id}/script`, { method: 'PUT', json: { script: 42 } });
  assert.equal(badScript.status, 400);
  const saveScript = await admin(`/lessons/${lesson.body.id}/script`, { method: 'PUT', json: { script: '# Plan\n\n| step | min |\n|---|---|\n| intro | 10 |' } });
  assert.equal(saveScript.status, 200, JSON.stringify(saveScript.body));
  const readScript = await admin(`/lessons/${lesson.body.id}/script`);
  assert.equal(readScript.status, 200);
  assert.match(readScript.body.script, /^# Plan/);
  // Editing the lesson's title/summary keeps the script
  assert.equal((await admin(`/lessons/${lesson.body.id}`, { method: 'PUT', json: { title: 'Intro', description: '' } })).status, 200);
  assert.match((await admin(`/lessons/${lesson.body.id}/script`)).body.script, /^# Plan/);
  // Optimistic concurrency on the script's own stamp: stale → 409, current → 200, and a title edit
  // in between does not count as a conflict (lessons.updated_at moves, script_updated_at does not)
  const stale = await admin(`/lessons/${lesson.body.id}/script`, { method: 'PUT', json: { script: '# Older', expected_script_updated_at: '2000-01-01T00:00:00.000Z' } });
  assert.equal(stale.status, 409);
  assert.ok(stale.body.script_updated_at);
  const stamp = (await admin(`/lessons/${lesson.body.id}/script`)).body.script_updated_at;
  assert.equal((await admin(`/lessons/${lesson.body.id}`, { method: 'PUT', json: { title: 'Intro', description: 'edited meanwhile' } })).status, 200);
  const fresh = await admin(`/lessons/${lesson.body.id}/script`, { method: 'PUT', json: { script: '# Plan v2', expected_script_updated_at: stamp } });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.ok(fresh.body.script_updated_at);
  assert.equal((await admin(`/lessons/${lesson.body.id}/script`, { method: 'PUT', json: { script: 'x', expected_script_updated_at: 'yesterday' } })).status, 400);
  // The check and the write are one statement: two saves racing with the same stamp → exactly one wins
  const racers = await Promise.all(['# A', '# B'].map((s) => admin(`/lessons/${lesson.body.id}/script`, { method: 'PUT', json: { script: s, expected_script_updated_at: fresh.body.script_updated_at } })));
  assert.deepEqual(racers.map((r) => r.status).sort(), [200, 409]);
  // A lesson that never had a script: the expectation "null" is accepted once, then conflicts
  const neverSaved = await admin(`/lessons/${second.body.id}/script`);
  assert.equal(neverSaved.body.script_updated_at, null);
  assert.equal((await admin(`/lessons/${second.body.id}/script`, { method: 'PUT', json: { script: 'first', expected_script_updated_at: null } })).status, 200);
  assert.equal((await admin(`/lessons/${second.body.id}/script`, { method: 'PUT', json: { script: 'second', expected_script_updated_at: null } })).status, 409);
  assert.equal((await admin(`/lessons/${lesson.body.id}/script`, { method: 'PUT', json: { script: '# Plan\n\n| step | min |\n|---|---|\n| intro | 10 |' } })).status, 200);
  assert.equal((await admin('/lessons/999999/script')).status, 404);
  assert.equal((await admin(`/lessons/${lesson.body.id}/script`, { method: 'PUT', json: { script: 'x'.repeat(200001) } })).status, 400);
  const gone = await admin(`/lessons/${second.body.id}`, { method: 'DELETE' });
  assert.equal(gone.status, 200);

  // Student session: cannot touch admin routes, can view + submit, sees only own submissions
  const stud = await loginAs('student@example.test', 'StudentPass1!');
  const forbidden = await stud('/lessons', { method: 'POST', json: { pathId: 1, title: 'x', order: 2 } });
  assert.equal(forbidden.status, 403);
  const addStars = await stud(`/admin/users/${student.id}/add-stars`, { method: 'POST', json: { stars: 100 } });
  assert.equal(addStars.status, 403);

  assert.equal((await stud(`/lessons/${lesson.body.id}/script`)).status, 403);
  assert.equal((await stud(`/lessons/${lesson.body.id}/script`, { method: 'PUT', json: { script: 'x' } })).status, 403);
  const detailsNoScript = await stud(`/paths/${paths.body[0].id}/details`);
  assert.equal(detailsNoScript.body[0].script, undefined);
  assert.equal(JSON.stringify(detailsNoScript.body).includes('# Plan'), false);
  // …nor through the course road, for anyone (admins read it only via the dedicated endpoint)
  for (const who of [stud, admin, anon]) {
    const road = await who(`/courses/${course.body.id}`);
    assert.equal(road.status, 200);
    assert.equal(JSON.stringify(road.body).includes('# Plan'), false);
    assert.equal(road.body.phases[0].lessons[0].script, undefined);
    for (const key of ['id', 'path_id', 'title', 'description', 'order_index', 'position_x', 'position_y', 'created_at', 'updated_at', 'completed', 'tasks']) {
      assert.ok(key in road.body.phases[0].lessons[0], `road lesson is missing ${key}`);
    }
  }
  assert.equal((await admin('/lessons/abc/script')).status, 404);
  const viewed = await stud(`/tasks/${task.body.id}/mark-viewed`, { method: 'POST' });
  assert.equal(viewed.status, 200);
  const viewedAgain = await stud(`/tasks/${task.body.id}/mark-viewed`, { method: 'POST' }); // upsert path
  assert.equal(viewedAgain.status, 200);

  // Phase gating is server-side: without enrolment the submission is refused (and the upload dropped)
  const earlyForm = new FormData();
  earlyForm.append('file', new Blob(['x'], { type: 'text/plain' }), 'early.txt');
  const early = await stud(`/tasks/${task.body.id}/submit`, { method: 'POST', body: earlyForm });
  assert.equal(early.status, 403, JSON.stringify(early.body));
  assert.deepEqual(early.body.lockReasons, ['enroll']);
  await eventually(() => uploadedFiles(uploadsDir).length === 0, 'the refused upload was not removed');
  const firstEnrol = await stud(`/courses/${course.body.id}/enroll`, { method: 'POST' });
  assert.equal(firstEnrol.status, 200);

  const form = new FormData();
  form.append('file', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), '../evil name.html');
  const submit = await stud(`/tasks/${task.body.id}/submit`, { method: 'POST', body: form });
  assert.equal(submit.status, 201, JSON.stringify(submit.body));
  const stored = uploadedFiles(uploadsDir);
  assert.equal(stored.length, 1);
  assert.match(stored[0], /-evil_name\.html$/); // sanitised basename, no traversal

  // A submission can also be a comment only (PR link / Jira ticket), or a comment with a file
  const empty = await stud(`/tasks/${task.body.id}/submit`, { method: 'POST', body: new FormData() });
  assert.equal(empty.status, 400);
  const commentForm = new FormData();
  commentForm.append('comment', 'PR: https://github.com/example/repo/pull/12 — ready for review');
  const commentOnly = await stud(`/tasks/${task.body.id}/submit`, { method: 'POST', body: commentForm });
  assert.equal(commentOnly.status, 201, JSON.stringify(commentOnly.body));
  assert.equal(commentOnly.body.fileName, null);
  const noFile = await stud(`/submissions/download/${commentOnly.body.id}`);
  assert.equal(noFile.status, 404);
  const bothForm = new FormData();
  bothForm.append('comment', 'see attached');
  bothForm.append('file', new Blob(['notes'], { type: 'text/plain' }), 'notes.txt');
  const both = await stud(`/tasks/${task.body.id}/submit`, { method: 'POST', body: bothForm });
  assert.equal(both.status, 201);
  const mine = await stud(`/tasks/${task.body.id}/submissions`);
  assert.equal(mine.body.length, 3);
  assert.deepEqual(mine.body.map((x) => [x.comment, x.file_name]).sort(), [
    ['PR: https://github.com/example/repo/pull/12 — ready for review', null],
    ['see attached', 'notes.txt'],
    [null, 'evil name.html'],
  ].sort());
  const tooLong = new FormData();
  tooLong.append('comment', 'x'.repeat(4001));
  assert.equal((await stud(`/tasks/${task.body.id}/submit`, { method: 'POST', body: tooLong })).status, 400);
  const atLimit = new FormData();
  atLimit.append('comment', 'y'.repeat(4000));
  const limitOk = await stud(`/tasks/${task.body.id}/submit`, { method: 'POST', body: atLimit });
  assert.equal(limitOk.status, 201);
  assert.equal((await stud(`/submissions/${limitOk.body.id}`, { method: 'DELETE' })).status, 200);
  const blank = new FormData();
  blank.append('comment', '   \n\t ');
  assert.equal((await stud(`/tasks/${task.body.id}/submit`, { method: 'POST', body: blank })).status, 400);
  for (const sid of [commentOnly.body.id, both.body.id]) assert.equal((await stud(`/submissions/${sid}`, { method: 'DELETE' })).status, 200);
  await eventually(() => uploadedFiles(uploadsDir).length === 1, 'deleted submission files were not removed');

  // Admin review inbox: every submission with its place in the course and a deep-link target
  assert.equal((await stud('/admin/submissions')).status, 403);
  assert.equal((await anon('/admin/submissions')).status, 401);
  assert.equal((await anon(`/lessons/${lesson.body.id}/script`)).status, 401);
  assert.equal((await anon(`/lessons/${lesson.body.id}/script`, { method: 'PUT', json: { script: 'x' } })).status, 401);
  const inbox = await admin('/admin/submissions');
  assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
  assert.equal(inbox.body.counts.pending, 1);
  assert.equal(inbox.body.submissions.length, 1);
  const row = inbox.body.submissions[0];
  assert.equal(row.user_name, 'Student');
  assert.equal(row.task_id, task.body.id);
  assert.equal(row.lesson_id, lesson.body.id);
  assert.equal(row.course_id, course.body.id);
  assert.equal(row.path_name, 'Phase 1');
  assert.equal(row.status, 'pending');
  assert.equal((await admin('/admin/submissions?status=approved')).body.submissions.length, 0);
  assert.equal((await admin('/admin/submissions?status=rejected')).body.submissions.length, 0);
  assert.equal((await admin('/admin/submissions?status=all')).body.submissions.length, 1);
  assert.strictEqual(inbox.body.counts.pending, 1); // numeric, not a bigint string
  assert.equal(inbox.body.has_more, false);
  assert.equal(inbox.body.next_cursor, null);
  assert.equal((await admin('/admin/submissions?limit=1')).body.has_more, false); // exactly one row, page of one → no extra empty page
  // Cursor paging: newest first, `before=next_cursor` walks to older rows without gaps or repeats
  for (const n of [1, 2, 3]) {
    const f = new FormData();
    f.append('comment', `page test ${n}`);
    assert.equal((await stud(`/tasks/${task.body.id}/submit`, { method: 'POST', body: f })).status, 201);
  }
  const seen = [];
  let cursor = null;
  for (let guard = 0; guard < 10; guard++) {
    const page = await admin(`/admin/submissions?status=all&limit=2${cursor ? `&before=${cursor}` : ''}`);
    assert.equal(page.status, 200);
    page.body.submissions.forEach((s) => seen.push(s.id));
    if (!page.body.has_more) break;
    assert.equal(page.body.next_cursor, page.body.submissions[page.body.submissions.length - 1].id);
    cursor = page.body.next_cursor;
  }
  assert.equal(seen.length, 4);
  assert.deepEqual([...seen].sort((a, b) => b - a), seen); // strictly newest → oldest
  assert.equal(new Set(seen).size, 4);
  // Status filter combined with the cursor: the pending page walks the same ids, counts stay global
  const pendingFirst = await admin('/admin/submissions?status=pending&limit=3');
  assert.equal(pendingFirst.body.submissions.length, 3);
  assert.equal(pendingFirst.body.has_more, true);
  assert.deepEqual(pendingFirst.body.submissions.map((s) => s.id), seen.slice(0, 3));
  const pendingRest = await admin(`/admin/submissions?status=pending&limit=3&before=${pendingFirst.body.next_cursor}`);
  assert.deepEqual(pendingRest.body.submissions.map((s) => s.id), seen.slice(3));
  assert.equal(pendingRest.body.has_more, false);
  assert.strictEqual(pendingFirst.body.counts.pending, 4);
  assert.equal(pendingRest.body.counts, null);
  const exact = await admin('/admin/submissions?status=all&limit=4'); // total is an exact multiple of the page size
  assert.equal(exact.body.submissions.length, 4);
  assert.equal(exact.body.has_more, false);
  assert.equal(exact.body.next_cursor, null);
  assert.equal((await admin('/admin/submissions?before=abc')).status, 400); // malformed cursor → error, never "start over"
  assert.equal((await admin('/admin/submissions?before=12345678901')).status, 400);
  assert.equal((await admin(`/admin/submissions?status=all&limit=2&before=${seen[1]}`)).body.counts, null); // totals only on the first page
  const extra = (await admin('/admin/submissions?status=all')).body.submissions.filter((s) => (s.comment || '').startsWith('page test'));
  for (const s of extra) assert.equal((await stud(`/submissions/${s.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await admin('/admin/submissions?status=bogus&limit=99999')).status, 200); // falls back to pending, clamps limit
  assert.equal((await admin('/admin/submissions?limit=abc')).body.submissions.length, 1);

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
  const inboxAfter = await admin('/admin/submissions?status=approved');
  assert.equal(inboxAfter.body.submissions.length, 1);
  assert.equal(inboxAfter.body.submissions[0].status, 'approved');
  assert.strictEqual(inboxAfter.body.counts.approved, 1);
  assert.strictEqual(inboxAfter.body.counts.pending, 0);
  // Submission + review notifications open the task on its course road (in the app and by email)
  const taskDeepLink = `/courses/${course.body.id}?lesson=${lesson.body.id}&task=${task.body.id}`;
  const studNotifs = (await stud('/notifications')).body;
  assert.equal(studNotifs.find((n) => n.type === 'account_approved').link, '/courses');
  assert.equal(studNotifs.find((n) => n.type === 'submission_approved').link, taskDeepLink);
  assert.equal((await admin('/notifications')).body.find((n) => n.type === 'task_submission').link, taskDeepLink);
  await waitForOutput(child, new RegExp(`to=student@example\\.test subject="Task Approved! ✅" link=\\S+${taskDeepLink.replace(/[?]/g, '\\?')}`));
  // Stars: in-app + email, linking to the leaderboard
  const stars = await admin(`/admin/users/${student.id}/add-stars`, { method: 'POST', json: { stars: 5 } });
  assert.equal(stars.status, 200);
  assert.equal((await stud('/notifications')).body.find((n) => n.type === 'stars_received').link, '/users');
  await waitForOutput(child, /to=student@example\.test subject="⭐ \+5 Stars Received!" link=\S+\/users/);
  // Approving / promoting from the admin user editor notifies too (it used to be silent)
  const lateReg = await anon('/register', { method: 'POST', json: { name: 'Late', email: 'late@example.test', password: 'LatePass123!' } });
  assert.equal(lateReg.status, 201);
  const editForm = new FormData();
  editForm.append('is_approved', 'true');
  editForm.append('role', 'admin');
  const editedUser = await admin(`/admin/users/${lateReg.body.userId}`, { method: 'PUT', body: editForm });
  assert.equal(editedUser.status, 200, JSON.stringify(editedUser.body));
  await waitForOutput(child, /to=late@example\.test subject="Account Approved! 🎉"/);
  // An email already used by another account (any letter case) is refused, not a 500
  const dupForm = new FormData();
  dupForm.append('email', 'STUDENT@example.test');
  assert.equal((await admin(`/admin/users/${lateReg.body.userId}`, { method: 'PUT', body: dupForm })).status, 409);
  await waitForOutput(child, /to=late@example\.test subject="You are now an administrator 🛠️"/);
  const late = await loginAs('late@example.test', 'LatePass123!');
  assert.deepEqual((await late('/notifications')).body.map((n) => [n.type, n.link]).sort(), [['account_approved', '/courses'], ['role_changed', '/courses']]);
  assert.equal((await admin(`/admin/users/${lateReg.body.userId}`, { method: 'DELETE' })).status, 200);
  // Every notification created so far has a link
  assert.ok([...studNotifs, ...(await admin('/notifications')).body].every((n) => typeof n.link === 'string' && n.link.startsWith('/')));

  // The course road: enrolment gates everything for a student, then the sequence gates phase 2
  const phase2Lesson = await admin('/lessons', { method: 'POST', json: { pathId: phase2.body.id, title: 'P2 L1', description: 'What phase 2 covers', order: 1 } });
  assert.equal(phase2Lesson.status, 201);
  const phase2Task = await admin('/tasks', { method: 'POST', json: { lessonId: phase2Lesson.body.id, title: 'P2 T1', type: 'mandatory', xp: 10, deadline: '2030-01-01' } });
  assert.equal(phase2Task.status, 201);
  const describe = await admin(`/tasks/${phase2Task.body.id}`, { method: 'PUT', json: { title: 'P2 T1', type: 'mandatory', xp: 10, deadline: '2030-01-01', description: 'secret brief' } });
  assert.equal(describe.status, 200);
  const leaveFirst = await stud(`/courses/${course.body.id}/enroll`, { method: 'DELETE' });
  assert.equal(leaveFirst.status, 200);
  const roadBefore = await stud(`/courses/${course.body.id}`);
  assert.equal(roadBefore.status, 200);
  assert.equal(roadBefore.body.enrolled, false);
  assert.deepEqual(roadBefore.body.phases.map((p) => p.lockReasons), [['enroll'], ['enroll']]);
  // Locked phases keep lesson titles + summaries and task titles; only task briefs are held back
  assert.equal(roadBefore.body.phases[1].lessons[0].title, 'P2 L1');
  assert.equal(roadBefore.body.phases[1].lessons[0].description, 'What phase 2 covers');
  assert.equal(roadBefore.body.phases[1].lessons[0].tasks[0].title, 'P2 T1');
  assert.equal(roadBefore.body.phases[1].lessons[0].tasks[0].description, '');
  // …and the server refuses submissions to a phase the student has not reached
  const lockedForm = new FormData();
  lockedForm.append('file', new Blob(['x'], { type: 'text/plain' }), 'early.txt');
  const lockedSubmit = await stud(`/tasks/${phase2Task.body.id}/submit`, { method: 'POST', body: lockedForm });
  assert.equal(lockedSubmit.status, 403, JSON.stringify(lockedSubmit.body));
  assert.deepEqual(lockedSubmit.body.lockReasons, ['enroll']);
  await eventually(() => uploadedFiles(uploadsDir).length === 1, 'the rejected upload was not removed');
  // The legacy read routes apply the same rule
  const legacyDetails = await anon(`/paths/${phase2.body.id}/details`);
  assert.equal(legacyDetails.status, 200);
  assert.equal(legacyDetails.body[0].description, 'What phase 2 covers');
  assert.equal(legacyDetails.body[0].tasks[0].description, '');
  const legacyTask = await stud(`/tasks/${phase2Task.body.id}`);
  assert.equal(legacyTask.status, 200);
  assert.equal(legacyTask.body.description, '');
  const adminLegacyTask = await admin(`/tasks/${phase2Task.body.id}`);
  assert.equal(adminLegacyTask.body.description, 'secret brief');
  const enrol = await stud(`/courses/${course.body.id}/enroll`, { method: 'POST' });
  assert.equal(enrol.status, 200);
  const unicodeForm = new FormData();
  unicodeForm.append('file', new Blob(['tema'], { type: 'text/plain' }), 'Temă – Ștefan.txt');
  const unicodeSubmit = await stud(`/tasks/${task.body.id}/submit`, { method: 'POST', body: unicodeForm });
  assert.equal(unicodeSubmit.status, 201, JSON.stringify(unicodeSubmit.body));
  assert.equal(unicodeSubmit.body.fileName, 'Temă – Ștefan.txt'); // not latin1-garbled
  assert.equal((await stud(`/submissions/${unicodeSubmit.body.id}`, { method: 'DELETE' })).status, 200);
  const enrolAgain = await stud(`/courses/${course.body.id}/enroll`, { method: 'POST' }); // idempotent
  assert.equal(enrolAgain.status, 200);
  const catalogue = await stud('/courses');
  assert.equal(catalogue.body[0].enrolled, true);
  assert.equal(catalogue.body[0].phaseCount, 2);
  assert.equal(catalogue.body[0].studentCount, 1);
  assert.deepEqual(catalogue.body[0].progress, { total: 2, done: 1 });
  const roadAfter = await stud(`/courses/${course.body.id}`);
  assert.equal(roadAfter.body.enrolled, true);
  // Phase 1's only mandatory task was approved above → phase 1 done, phase 2 reachable
  assert.deepEqual(roadAfter.body.phases.map((p) => p.locked), [false, false]);
  assert.equal(roadAfter.body.phases[0].lessons[0].completed, true);
  assert.equal(roadAfter.body.phases[0].lessons[0].tasks[0].completed, true);
  assert.equal(roadAfter.body.phases[1].lessons[0].tasks[0].is_new, true);
  assert.equal(roadAfter.body.phases[1].lessons[0].tasks[0].description, 'secret brief'); // reached → full content
  assert.equal((await stud(`/tasks/${phase2Task.body.id}`)).body.description, 'secret brief');
  // Study sets (quizzes + flashcards) under a lesson: admin-managed, students practise
  const anonSet = await anon('/study-sets', { method: 'POST', json: {} });
  assert.equal(anonSet.status, 401);
  const studSet = await stud('/study-sets', { method: 'POST', json: { lessonId: phase2Lesson.body.id, kind: 'quiz', title: 'x', items: [] } });
  assert.equal(studSet.status, 403);
  const badSet = await admin('/study-sets', { method: 'POST', json: { lessonId: phase2Lesson.body.id, kind: 'quiz', title: 'Q', items: [{ question: 'q', options: ['a'], correct: 3 }] } });
  assert.equal(badSet.status, 400);
  assert.ok(badSet.body.details.some((d) => /options/.test(d)), JSON.stringify(badSet.body));
  const ghostLessonSet = await admin('/study-sets', { method: 'POST', json: { lessonId: 999999, kind: 'flashcards', title: 'F', items: [] } });
  assert.equal(ghostLessonSet.status, 404);
  // Lesson materials: teachers attach Word / PowerPoint / PDF / TXT / MD files to a lesson
  const pdfBytes = '%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n';
  const filesForm = (entries) => {
    const f = new FormData();
    for (const [name, content, type] of entries) f.append('files', new Blob([content], { type: type || 'application/octet-stream' }), name);
    return f;
  };
  assert.equal((await stud(`/lessons/${phase2Lesson.body.id}/files`, { method: 'POST', body: filesForm([['a.pdf', pdfBytes]]) })).status, 403);
  assert.equal((await admin(`/lessons/${phase2Lesson.body.id}/files`, { method: 'POST', body: filesForm([['virus.exe', 'MZ']]) })).status, 400);
  const fakePdf = await admin(`/lessons/${phase2Lesson.body.id}/files`, { method: 'POST', body: filesForm([['page.pdf', '<html><script>alert(1)</script></html>']]) });
  assert.equal(fakePdf.status, 400, 'an HTML file renamed to .pdf is refused');
  await eventually(() => lessonFileCount(uploadsDir) === 0, 'refused uploads leave no bytes behind'); // unlink runs after the reply
  const uploaded = await admin(`/lessons/${phase2Lesson.body.id}/files`, { method: 'POST', body: filesForm([
    ['Curs 1 – introducere.pdf', pdfBytes, 'application/pdf'],
    ['notes.md', '# Week 2\n\n- **HTTP** basics\n- <script>alert(1)</script>', 'text/markdown'],
    ['slides.pptx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])],
  ]) });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  assert.deepEqual(uploaded.body.map((f) => [f.ext, f.viewable, f.view_as]), [['pdf', true, 'pdf'], ['md', true, 'markdown'], ['pptx', false, null]]);
  const [p2Pdf, p2Md, p2Pptx] = uploaded.body;
  assert.equal(p2Pdf.name, 'Curs 1 – introducere.pdf');
  // On the road (names only) and readable by an enrolled student who reached the phase
  const roadFiles = (await stud(`/courses/${course.body.id}`)).body.phases[1].lessons[0].files;
  assert.deepEqual(roadFiles.map((f) => f.name), ['Curs 1 – introducere.pdf', 'notes.md', 'slides.pptx']);
  const pdfView = await fetch(`${BASE}/lesson-files/${p2Pdf.id}/view`, { headers: { cookie: stud.cookie() } });
  assert.equal(pdfView.status, 200);
  assert.equal(pdfView.headers.get('content-type'), 'application/pdf');
  assert.match(pdfView.headers.get('content-disposition'), /^inline;/);
  assert.match(pdfView.headers.get('content-disposition'), /filename\*=UTF-8''Curs%201%20%E2%80%93%20introducere\.pdf/);
  assert.equal(await pdfView.text(), pdfBytes);
  const mdView = await fetch(`${BASE}/lesson-files/${p2Md.id}/view`, { headers: { cookie: stud.cookie() } });
  assert.equal(mdView.headers.get('content-type'), 'text/plain; charset=utf-8'); // never HTML on this origin
  assert.match(mdView.headers.get('content-security-policy'), /sandbox/);
  assert.equal(mdView.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await mdView.text(), /# Week 2/);
  assert.equal((await stud(`/lesson-files/${p2Pptx.id}/view`)).status, 415, 'PowerPoint is download-only');
  const pptxDl = await fetch(`${BASE}/lesson-files/${p2Pptx.id}/download`, { headers: { cookie: stud.cookie() } });
  assert.equal(pptxDl.status, 200);
  assert.match(pptxDl.headers.get('content-disposition'), /^attachment; filename="slides\.pptx"/);
  assert.equal((await anon(`/lesson-files/${p2Pdf.id}/view`)).status, 401);
  // A stored file that cannot be read (here: replaced by a directory, so the existence check
  // passes) is a clean 500, not an unhandled stream error that takes the server down
  const [{ stored_name: pptxStored }] = await dbQuery('SELECT stored_name FROM lesson_files WHERE id = $1', [p2Pptx.id]);
  const pptxPath = path.join(uploadsDir, 'lesson-files', pptxStored);
  fs.renameSync(pptxPath, `${pptxPath}.bak`);
  fs.mkdirSync(pptxPath);
  const brokenDl = await fetch(`${BASE}/lesson-files/${p2Pptx.id}/download`, { headers: { cookie: stud.cookie() } });
  assert.equal(brokenDl.status, 500);
  assert.equal(brokenDl.headers.get('content-disposition'), null);
  const brokenView = await fetch(`${BASE}/lesson-files/${p2Pptx.id}/view`, { headers: { cookie: stud.cookie() } });
  assert.equal(brokenView.status, 415); // pptx has no view; the error path is shared with download
  fs.rmdirSync(pptxPath);
  fs.renameSync(`${pptxPath}.bak`, pptxPath);
  assert.equal((await fetch(`${BASE}/lesson-files/${p2Pptx.id}/download`, { headers: { cookie: stud.cookie() } })).status, 200, 'the server survived the read error');
  // The public uploads route never serves lesson materials (they follow the lesson's lock rules)
  const storedName = fs.readdirSync(path.join(uploadsDir, 'lesson-files')).find((f) => !f.startsWith('.'));
  assert.equal((await anon(`/uploads/lesson-files/${storedName}`)).status, 404);
  // Rename, delete (bytes removed)
  assert.equal((await admin(`/lesson-files/${p2Md.id}`, { method: 'PUT', json: { order: 2147483648 } })).status, 400);
  assert.equal((await admin(`/lesson-files/${p2Md.id}`, { method: 'PUT', json: { name: '  ' } })).status, 400);
  assert.equal((await admin('/study-sets', { method: 'POST', json: { lessonId: phase2Lesson.body.id, kind: 'flashcards', title: 'x', items: [], order: 2147483648 } })).status, 400);
  const bidiName = await admin(`/lesson-files/${p2Md.id}`, { method: 'PUT', json: { name: 'report\u202Efdp.exe' } });
  assert.equal(bidiName.body.name, 'reportfdp.exe.md', 'bidi overrides are stripped; the extension is kept');
  const renamedFile = await admin(`/lesson-files/${p2Md.id}`, { method: 'PUT', json: { name: 'Week 2 notes.md' } });
  assert.equal(renamedFile.body.name, 'Week 2 notes.md');
  const tmp = await admin(`/lessons/${phase2Lesson.body.id}/files`, { method: 'POST', body: filesForm([['tmp.txt', 'temporary']]) });
  assert.equal(lessonFileCount(uploadsDir), 4);
  assert.equal((await stud(`/lesson-files/${tmp.body[0].id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await admin(`/lesson-files/${tmp.body[0].id}`, { method: 'DELETE' })).status, 200);
  await eventually(() => lessonFileCount(uploadsDir) === 3, 'deleted lesson file bytes were not removed');

  const quiz = await admin('/study-sets', { method: 'POST', json: {
    lessonId: phase2Lesson.body.id, kind: 'quiz', title: 'Phase 2 check', items: [
      { question: 'Which HTTP status means Not Found?', options: ['200', '404', '500'], correct: 1, explanation: '4xx = client error' },
      { question: 'Pick the HTTP verbs', options: ['GET', 'FETCH', 'POST'], correct: [2, 0] },
    ] } });
  assert.equal(quiz.status, 201, JSON.stringify(quiz.body));
  assert.deepEqual(quiz.body.items[1].correct, [0, 2]); // normalised
  const deck = await admin('/study-sets', { method: 'POST', json: {
    lessonId: phase2Lesson.body.id, kind: 'flashcards', title: 'Terms', items: [{ front: 'SUT', back: 'System under test' }, { front: 'CI', back: 'Continuous integration' }] } });
  assert.equal(deck.status, 201, JSON.stringify(deck.body));
  assert.equal(deck.body.order_index, 2);
  // Students get the questions without the answers
  const studQuiz = await stud(`/study-sets/${quiz.body.id}`);
  assert.equal(studQuiz.status, 200);
  assert.equal(studQuiz.body.items[0].correct, undefined);
  assert.equal(studQuiz.body.items[0].explanation, undefined);
  assert.equal(studQuiz.body.items[1].multiple, true);
  assert.equal((await admin(`/study-sets/${quiz.body.id}`)).body.items[0].explanation, '4xx = client error');
  const lessonSets = await stud(`/lessons/${phase2Lesson.body.id}/study-sets`);
  assert.deepEqual(lessonSets.body.map((x) => x.kind), ['quiz', 'flashcards']);
  // The lesson listing hides the answers from students too
  assert.equal(/"correct"|"explanation"/.test(JSON.stringify(lessonSets.body)), false);
  assert.equal(lessonSets.body[0].items[1].multiple, true);
  // Grading happens on the server
  const badAttempt = await stud(`/study-sets/${quiz.body.id}/attempts`, { method: 'POST', json: { answers: [1] } });
  assert.equal(badAttempt.status, 400);
  // Answers must be option indexes of their question, at most one per option
  for (const answers of [[7, [0]], [1, [-1]], [1, [0, 1, 2, 0, 1, 2]], [1, ['0']], [1, [0, 0]]]) {
    assert.equal((await stud(`/study-sets/${quiz.body.id}/attempts`, { method: 'POST', json: { answers } })).status, 400, JSON.stringify(answers));
  }
  const attempt1 = await stud(`/study-sets/${quiz.body.id}/attempts`, { method: 'POST', json: { answers: [1, [0]] } });
  assert.equal(attempt1.status, 200, JSON.stringify(attempt1.body));
  assert.equal(attempt1.body.score, 1);
  assert.deepEqual(attempt1.body.results.map((r) => r.correct), [true, false]);
  assert.deepEqual(attempt1.body.results[1].correct_options, [0, 2]);
  const attempt2 = await stud(`/study-sets/${quiz.body.id}/attempts`, { method: 'POST', json: { answers: [0, [2, 0]] } });
  assert.deepEqual(attempt2.body.progress, { best_score: 1, last_score: 1, total: 2, attempts: 2 });
  const cards = await stud(`/study-sets/${deck.body.id}/attempts`, { method: 'POST', json: { known: 2 } });
  assert.equal(cards.status, 200);
  assert.equal((await stud(`/study-sets/${deck.body.id}/attempts`, { method: 'POST', json: { known: 3 } })).status, 400);
  // The road carries titles, sizes and the caller's progress (never the items)
  const roadSets = await stud(`/courses/${course.body.id}`);
  const p2Sets = roadSets.body.phases[1].lessons[0].study_sets;
  assert.deepEqual(p2Sets.map((x) => [x.kind, x.item_count]), [['quiz', 2], ['flashcards', 2]]);
  assert.equal(p2Sets[0].items, undefined);
  assert.equal(p2Sets[1].progress.best_score, 2);
  // Editing: items replace the list; kind is fixed
  const editKind = await admin(`/study-sets/${deck.body.id}`, { method: 'PUT', json: { kind: 'quiz' } });
  assert.equal(editKind.status, 400);
  const edited = await admin(`/study-sets/${deck.body.id}`, { method: 'PUT', json: { title: 'Key terms', items: [{ front: 'QA', back: 'Quality assurance' }] } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.item_count, 1);
  // New questions = new results: the student's best score on the old deck is gone
  assert.equal((await stud(`/study-sets/${deck.body.id}`)).body.progress, null);
  // Renaming alone keeps results — also when the editor re-sends the unchanged items (the stored
  // jsonb has its keys reordered, so this must be a semantic comparison)
  await stud(`/study-sets/${deck.body.id}/attempts`, { method: 'POST', json: { known: 1 } });
  await admin(`/study-sets/${deck.body.id}`, { method: 'PUT', json: { title: 'Key terms (v2)' } });
  assert.equal((await stud(`/study-sets/${deck.body.id}`)).body.progress.best_score, 1);
  await admin(`/study-sets/${deck.body.id}`, { method: 'PUT', json: { title: 'Key terms (v3)', items: [{ front: 'QA', back: 'Quality assurance' }] } });
  assert.equal((await stud(`/study-sets/${deck.body.id}`)).body.progress.best_score, 1);
  const quizBefore = (await admin(`/study-sets/${quiz.body.id}`)).body;
  await stud(`/study-sets/${quiz.body.id}/attempts`, { method: 'POST', json: { answers: [1, [0, 2]] } });
  await admin(`/study-sets/${quiz.body.id}`, { method: 'PUT', json: { title: quizBefore.title, items: quizBefore.items } });
  assert.equal((await stud(`/study-sets/${quiz.body.id}`)).body.progress.best_score, 2);
  // A third phase behind the unfinished phase 2 is locked for the 'previous' reason
  const phase3 = await admin('/paths', { method: 'POST', json: { name: 'Phase 3', course_id: course.body.id } });
  assert.equal(phase3.body.order_index, 3);
  const phase3Lesson = await admin('/lessons', { method: 'POST', json: { pathId: phase3.body.id, title: 'P3 L1', order: 1 } });
  const phase3Task = await admin('/tasks', { method: 'POST', json: { lessonId: phase3Lesson.body.id, title: 'P3 T1', type: 'mandatory', xp: 10, deadline: '2030-01-01' } });
  const roadThree = await stud(`/courses/${course.body.id}`);
  assert.deepEqual(roadThree.body.phases.map((p) => p.lockReasons), [[], [], ['previous']]);
  const previousForm = new FormData();
  previousForm.append('file', new Blob(['x'], { type: 'text/plain' }), 'early.txt');
  const previousSubmit = await stud(`/tasks/${phase3Task.body.id}/submit`, { method: 'POST', body: previousForm });
  assert.equal(previousSubmit.status, 403);
  assert.deepEqual(previousSubmit.body.lockReasons, ['previous']);
  // Untick "requires previous" on phase 3 → reachable without finishing phase 2
  const freePhase = await admin(`/paths/${phase3.body.id}`, { method: 'PUT', json: { name: 'Phase 3', requires_previous: false } });
  assert.equal(freePhase.status, 200);
  assert.deepEqual((await stud(`/courses/${course.body.id}`)).body.phases[2].lockReasons, []);
  // A previous phase without lessons (or without mandatory tasks) never blocks: the batched road
  // and the per-request submit check agree on that
  const phase4 = await admin('/paths', { method: 'POST', json: { name: 'Phase 4 (empty)', course_id: course.body.id, requires_previous: false } });
  const phase5 = await admin('/paths', { method: 'POST', json: { name: 'Phase 5', course_id: course.body.id } });
  const phase5Lesson = await admin('/lessons', { method: 'POST', json: { pathId: phase5.body.id, title: 'P5 L1', order: 1 } });
  const phase5Task = await admin('/tasks', { method: 'POST', json: { lessonId: phase5Lesson.body.id, title: 'P5 T1', type: 'mandatory', xp: 10, deadline: '2030-01-01' } });
  const roadFive = await stud(`/courses/${course.body.id}`);
  assert.deepEqual(roadFive.body.phases.map((p) => [p.order_index, p.lockReasons]), [[1, []], [2, []], [3, []], [4, []], [5, []]]);
  const fiveForm = new FormData();
  fiveForm.append('file', new Blob(['x'], { type: 'text/plain' }), 'p5.txt');
  const fiveSubmit = await stud(`/tasks/${phase5Task.body.id}/submit`, { method: 'POST', body: fiveForm });
  assert.equal(fiveSubmit.status, 201, JSON.stringify(fiveSubmit.body));
  for (const p of [phase4, phase5]) assert.equal((await admin(`/paths/${p.body.id}`, { method: 'DELETE' })).status, 200);
  // Deleting the phase closes the gap in the numbering
  const dropPhase3 = await admin(`/paths/${phase3.body.id}`, { method: 'DELETE' });
  assert.equal(dropPhase3.status, 200);
  assert.equal((await admin('/courses/abc')).status, 404);
  // Lesson-file routes share the id guard: non-numeric or out-of-range ids are a 404, never a 500
  assert.equal((await admin('/lessons/abc/files')).status, 404);
  assert.equal((await admin('/lesson-files/abc/view')).status, 404);
  assert.equal((await admin('/lesson-files/99999999999/download')).status, 404);
  assert.equal((await admin('/lesson-files/abc', { method: 'DELETE' })).status, 404);
  assert.equal((await admin('/study-sets/99999999999')).status, 404);
  assert.equal((await admin('/lessons/99999999999/study-sets')).status, 404);
  for (const userId of [1.5, '1e2', 99999999999, 'abc']) {
    assert.equal((await anon('/verify-code', { method: 'POST', json: { userId, code: '123456' } })).status, 400, String(userId));
  }
  assert.equal((await admin('/courses/abc', { method: 'DELETE' })).status, 404);
  assert.equal((await anon('/paths/abc/details')).status, 404);
  assert.equal((await stud('/tasks/abc')).status, 404);
  const ghostForm = new FormData();
  ghostForm.append('file', new Blob(['x'], { type: 'text/plain' }), 'ghost.txt');
  const ghostSubmit = await stud('/tasks/999999/submit', { method: 'POST', body: ghostForm });
  assert.equal(ghostSubmit.status, 404);
  await eventually(() => !uploadedFiles(uploadsDir).some((f) => f.endsWith('ghost.txt')), 'the ghost upload was not removed');
  assert.equal((await admin('/paths/999999', { method: 'DELETE' })).status, 404);
  // Add a star gate on phase 2 that the student (10 stars) does not meet
  const gate = await admin(`/paths/${phase2.body.id}`, { method: 'PUT', json: { name: 'Phase 2', stars_required: 500 } });
  assert.equal(gate.status, 200);
  const roadGated = await stud(`/courses/${course.body.id}`);
  assert.deepEqual(roadGated.body.phases[1].lockReasons, ['stars']);
  // …and so are its lesson materials (the list is visible, the content is not)
  assert.equal((await stud(`/lesson-files/${p2Pdf.id}/view`)).status, 403);
  assert.equal((await stud(`/lesson-files/${p2Pdf.id}/download`)).status, 403);
  assert.equal((await stud(`/lessons/${phase2Lesson.body.id}/files`)).body.length, 3);
  assert.equal((await admin(`/lesson-files/${p2Pdf.id}/view`)).status, 200);
  // …and its study sets are closed too
  const lockedSet = await stud(`/study-sets/${quiz.body.id}`);
  assert.equal(lockedSet.status, 403);
  assert.deepEqual(lockedSet.body.lockReasons, ['stars']);
  assert.equal((await stud(`/study-sets/${quiz.body.id}/attempts`, { method: 'POST', json: { answers: [1, [0, 2]] } })).status, 403);
  assert.equal((await admin(`/study-sets/${quiz.body.id}`)).status, 200);
  const starsForm = new FormData();
  starsForm.append('file', new Blob(['x'], { type: 'text/plain' }), 'early.txt');
  const starsSubmit = await stud(`/tasks/${phase2Task.body.id}/submit`, { method: 'POST', body: starsForm });
  assert.equal(starsSubmit.status, 403);
  assert.deepEqual(starsSubmit.body.lockReasons, ['stars']);
  // Admins are never gated
  const adminForm = new FormData();
  adminForm.append('file', new Blob(['x'], { type: 'text/plain' }), 'admin.txt');
  const adminSubmit = await admin(`/tasks/${phase2Task.body.id}/submit`, { method: 'POST', body: adminForm });
  assert.equal(adminSubmit.status, 201);
  // Admin never sees locks and gets unviewed-submission counts instead of NEW badges
  const adminRoad = await admin(`/courses/${course.body.id}`);
  assert.deepEqual(adminRoad.body.phases.map((p) => p.locked), [false, false]);
  assert.equal(typeof adminRoad.body.phases[0].lessons[0].tasks[0].unviewed_count, 'number');
  const adminUsers = await admin('/admin/users');
  assert.deepEqual(adminUsers.body.find((u) => u.id === student.id).courses, [{ id: course.body.id, name: 'QA Automation Engineer' }]);
  // Users directory: everyone logged in, no emails
  const dirAnon = await anon('/users/directory');
  assert.equal(dirAnon.status, 401);
  const dir = await stud('/users/directory');
  assert.equal(dir.status, 200);
  assert.equal(dir.body[0].role, 'admin');
  assert.equal(dir.body[0].email, undefined);
  // Leaving the course and deleting it leaves the phases in place (unassigned)
  const leave = await stud(`/courses/${course.body.id}/enroll`, { method: 'DELETE' });
  assert.equal(leave.status, 200);
  const missingCourse = await admin('/courses/999999');
  assert.equal(missingCourse.status, 404);
  const course2 = await admin('/courses', { method: 'POST', json: { name: 'Temp' } });
  const movePhase = await admin(`/paths/${phase2.body.id}`, { method: 'PUT', json: { name: 'Phase 2', stars_required: 0, course_id: course2.body.id, order_index: 1 } });
  assert.equal(movePhase.status, 200);
  // Both courses are renumbered 1..n after a move
  assert.deepEqual((await admin(`/courses/${course.body.id}`)).body.phases.map((p) => [p.name, p.order_index]), [['Phase 1', 1]]);
  assert.deepEqual((await admin(`/courses/${course2.body.id}`)).body.phases.map((p) => [p.name, p.order_index]), [['Phase 2', 1]]);
  const dropCourse = await admin(`/courses/${course2.body.id}`, { method: 'DELETE' });
  assert.equal(dropCourse.status, 200);
  const orphan = (await admin('/paths')).body.find((p) => p.id === String(phase2.body.id));
  assert.equal(orphan.course_id, null);
  // An unassigned phase is an admin workspace: students cannot read its briefs or submit to it
  const orphanDetails = await stud(`/paths/${phase2.body.id}/details`);
  assert.equal(orphanDetails.body[0].tasks[0].description, '');
  const orphanForm = new FormData();
  orphanForm.append('file', new Blob(['x'], { type: 'text/plain' }), 'orphan.txt');
  const orphanSubmit = await stud(`/tasks/${phase2Task.body.id}/submit`, { method: 'POST', body: orphanForm });
  assert.equal(orphanSubmit.status, 403);
  assert.deepEqual(orphanSubmit.body.lockReasons, ['unpublished']);
  assert.equal((await stud(`/lessons/${phase2Lesson.body.id}/files`)).status, 404, 'unpublished phase file names stay hidden');
  assert.equal((await admin(`/lessons/${phase2Lesson.body.id}/files`)).status, 200);
  assert.equal((await admin(`/paths/${phase2.body.id}/details`)).body[0].tasks[0].description, 'secret brief');
  const reattach = await admin(`/paths/${phase2.body.id}`, { method: 'PUT', json: { name: 'Phase 2', stars_required: 0, course_id: course.body.id, order_index: 2 } });
  assert.equal(reattach.status, 200);
  // Phases of a course are always numbered 1..n: moving one re-sequences the others
  const phaseOrder = async () => (await admin(`/courses/${course.body.id}`)).body.phases.map((p) => [p.name, p.order_index]);
  assert.deepEqual(await phaseOrder(), [['Phase 1', 1], ['Phase 2', 2]]);
  const toFront = await admin(`/paths/${phase2.body.id}`, { method: 'PUT', json: { name: 'Phase 2', stars_required: 0, order_index: 1 } });
  assert.equal(toFront.status, 200);
  assert.deepEqual(await phaseOrder(), [['Phase 2', 1], ['Phase 1', 2]]);
  const backAgain = await admin(`/paths/${phase2.body.id}`, { method: 'PUT', json: { name: 'Phase 2', stars_required: 0, order_index: 9 } }); // beyond the end → last
  assert.equal(backAgain.status, 200);
  assert.deepEqual(await phaseOrder(), [['Phase 1', 1], ['Phase 2', 2]]);
  // Now that the phase 2 gate is gone and phase 1 is done, the student can submit
  const openForm = new FormData();
  openForm.append('file', new Blob(['x'], { type: 'text/plain' }), 'ok.txt');
  await stud(`/courses/${course.body.id}/enroll`, { method: 'POST' });
  const openSubmit = await stud(`/tasks/${phase2Task.body.id}/submit`, { method: 'POST', body: openForm });
  assert.equal(openSubmit.status, 201, JSON.stringify(openSubmit.body));

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
    courseId: course.body.id,
    requires_previous: false,
    lessons: [
      { title: 'L1', description: 'first', tasks: [{ title: 'T1', xp: 5 }, { title: 'T2', type: 'optional', deadline: '2031-05-01' }] },
      { title: 'L2', tasks: [{ title: 'T3' }], study_sets: [
        { kind: 'quiz', title: 'L2 quiz', items: [{ question: 'Q?', options: ['a', 'b'], correct: 0 }] },
        { kind: 'flashcards', title: 'L2 cards', items: [{ front: 'f', back: 'b' }] },
      ] },
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
  assert.equal(impBody.counts.study_sets, 2);
  const badSetImport = await fetch(`${BASE}/admin/paths/import`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', lessons: [{ title: 'L', study_sets: [{ kind: 'poll', title: 'x', items: [] }] }] }) });
  assert.equal(badSetImport.status, 400);
  // The API key manages study sets like an admin session
  const keySet = await fetch(`${BASE}/study-sets`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ lessonId: impBody.lessons[0].id, kind: 'flashcards', title: 'Via key', items: [{ front: 'a', back: 'b' }] }) });
  const keySetBody = await keySet.json();
  assert.equal(keySet.status, 201, JSON.stringify(keySetBody));
  const keyRead = await fetch(`${BASE}/lessons/${impBody.lessons[1].id}/study-sets`, { headers: bearer });
  const keyReadBody = await keyRead.json();
  assert.equal(keyReadBody[0].items[0].correct[0], 0); // admin view includes the answers
  assert.equal((await fetch(`${BASE}/study-sets/${keySetBody.id}`, { method: 'DELETE', headers: bearer })).status, 200);
  const importedPhase = (await admin('/paths')).body.find((p) => p.id === String(impBody.path.id));
  assert.equal(importedPhase.course_id, course.body.id);
  assert.equal(importedPhase.order_index, 3);
  assert.equal(importedPhase.requires_previous, false);
  const missingCourseImport = await fetch(`${BASE}/admin/paths/import`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', courseId: 999999, lessons: [{ title: 'L' }] }) });
  assert.equal(missingCourseImport.status, 404);
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

  // ---- Password security ----------------------------------------------------
  // Weak, common, name-based and over-long (bcrypt reads only 72 bytes) passwords are refused
  for (const [password, re] of [['Password123', /too common/], ['Pwtest2024', /based on your (name|email)/], ['a'.repeat(257), /too long/], ['zzzzzzzzzz', /too easy/]]) {
    const r = await anon('/register', { method: 'POST', json: { name: 'Pwtest', email: 'pwtest@example.test', password } });
    assert.equal(r.status, 400, password);
    assert.match(r.body.error, re);
  }
  const pwReg = await anon('/register', { method: 'POST', json: { name: 'Pwtest', email: 'pwtest@example.test', password: 'Blue-Kettle-Morning-7' } });
  assert.equal(pwReg.status, 201, JSON.stringify(pwReg.body));
  assert.equal((await admin(`/users/${pwReg.body.userId}/approve`, { method: 'POST' })).status, 200);
  // Stored sealed (scrypt hash encrypted with PASSWORD_PEPPER); the emailed code only as an HMAC
  const [pwRow] = await dbQuery('SELECT password, login_code FROM users WHERE id = $1', [pwReg.body.userId]);
  assert.match(pwRow.password, /^\$sealed\$v1\$[0-9a-f]{8}\$/);
  assert.equal(/scrypt|\$2b\$/.test(pwRow.password), false);
  // Every account in the database is sealed, including those created before this release
  assert.deepEqual(await dbQuery("SELECT id FROM users WHERE password NOT LIKE '$sealed$v1$%'"), []);
  const pw1 = await loginAs('PWTEST@Example.test', 'Blue-Kettle-Morning-7'); // email is case-insensitive
  const pwOther = await loginAs('pwtest@example.test', 'Blue-Kettle-Morning-7'); // a second device
  await anon('/login', { method: 'POST', json: { email: 'pwtest@example.test', password: 'Blue-Kettle-Morning-7' } });
  const [codeRow] = await dbQuery('SELECT login_code FROM users WHERE id = $1', [pwReg.body.userId]);
  assert.match(codeRow.login_code, /^[0-9a-f]{64}$/);
  assert.notEqual(codeRow.login_code, await readLoginCode('pwtest@example.test'));
  // Unknown email and wrong password answer the same way
  const unknown = await anon('/login', { method: 'POST', json: { email: 'nobody@example.test', password: 'Whatever-123' } });
  const wrong = await anon('/login', { method: 'POST', json: { email: 'pwtest@example.test', password: 'Whatever-123' } });
  assert.deepEqual([unknown.status, unknown.body], [wrong.status, wrong.body]);
  // Changing the password: needs the current one, applies the policy, signs out other devices
  const badCurrent = await pw1('/me/password', { method: 'PUT', json: { current_password: 'nope-nope-1', new_password: 'Green-Lamp-Evening-8' } });
  assert.equal(badCurrent.status, 400);
  const weakNew = await pw1('/me/password', { method: 'PUT', json: { current_password: 'Blue-Kettle-Morning-7', new_password: 'password1' } });
  assert.equal(weakNew.status, 400);
  const changed = await pw1('/me/password', { method: 'PUT', json: { current_password: 'Blue-Kettle-Morning-7', new_password: 'Green-Lamp-Evening-8' } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal((await pw1('/me')).status, 200);           // this device got a fresh cookie
  assert.equal((await pwOther('/me')).status, 401);       // the other device is signed out
  assert.equal((await pwOther('/notifications')).status, 401);
  await waitForOutput(child, /to=pwtest@example\.test subject="Your password was changed 🔐"/);
  assert.equal((await anon('/login', { method: 'POST', json: { email: 'pwtest@example.test', password: 'Blue-Kettle-Morning-7' } })).status, 401);
  await loginAs('pwtest@example.test', 'Green-Lamp-Evening-8');
  // Two concurrent changes from the same current password: exactly one wins, the other is refused
  // (409, or 400 if it ran after the pwWinner) instead of silently overwriting it
  const pwRacers = ['Teal-Door-Summer-31', 'Plum-Road-Winter-42'];
  const pwRaced = await Promise.all(pwRacers.map((p) => pw1('/me/password', { method: 'PUT', json: { current_password: 'Green-Lamp-Evening-8', new_password: p } })));
  const pwWinners = pwRaced.filter((r) => r.status === 200);
  assert.equal(pwWinners.length, 1, JSON.stringify(pwRaced.map((r) => [r.status, r.body])));
  assert.ok([400, 409].includes(pwRaced.find((r) => r.status !== 200).status));
  const pwWinner = pwRacers[pwRaced.indexOf(pwWinners[0])];
  await loginAs('pwtest@example.test', pwWinner);
  assert.equal((await pw1('/me/password', { method: 'PUT', json: { current_password: pwWinner, new_password: 'Green-Lamp-Evening-8' } })).status, 200);
  // 10 wrong passwords lock the account for 15 minutes, even for the right password
  for (let i = 0; i < 10; i++) {
    assert.equal((await anon('/login', { method: 'POST', json: { email: 'pwtest@example.test', password: `Wrong-guess-${i}` } })).status, 401);
  }
  // …and the lock answers exactly like a wrong password / unknown email (no account or guess is
  // revealed); the owner is told by email
  const locked = await anon('/login', { method: 'POST', json: { email: 'pwtest@example.test', password: 'Green-Lamp-Evening-8' } });
  assert.deepEqual([locked.status, locked.body], [unknown.status, unknown.body]);
  await waitForOutput(child, /to=pwtest@example\.test subject="Your account was locked for 15 minutes 🔒"/);
  // An admin can lift the lock early (students cannot)
  assert.equal((await stud(`/users/${pwReg.body.userId}/unlock`, { method: 'POST' })).status, 403);
  assert.equal((await admin('/users/999999/unlock', { method: 'POST' })).status, 404);
  assert.equal((await admin(`/users/${pwReg.body.userId}/unlock`, { method: 'POST' })).status, 200);
  // A legacy bcrypt hash (as left by older releases) still logs in and is upgraded to sealed scrypt
  const bcrypt = require('bcrypt');
  await dbQuery('UPDATE users SET password = $1 WHERE id = $2', [bcrypt.hashSync('Green-Lamp-Evening-8', 10), pwReg.body.userId]);
  await loginAs('pwtest@example.test', 'Green-Lamp-Evening-8');
  const [rehashed] = await dbQuery('SELECT password, failed_login_attempts, locked_until FROM users WHERE id = $1', [pwReg.body.userId]);
  assert.match(rehashed.password, /^\$sealed\$v1\$/);
  assert.equal(rehashed.failed_login_attempts, 0);
  assert.equal(rehashed.locked_until, null);
  // Guessing the current password through "change password" (e.g. with a stolen session) counts
  // toward the same lock, and a login code sent before the lock stops working
  const pending2fa = session();
  const started = await pending2fa('/login', { method: 'POST', json: { email: 'pwtest@example.test', password: 'Green-Lamp-Evening-8' } });
  assert.equal(started.status, 200);
  const earlyCode = await readLoginCode('pwtest@example.test');
  for (let i = 0; i < 9; i++) {
    assert.equal((await pw1('/me/password', { method: 'PUT', json: { current_password: `nope-${i}-wrong`, new_password: 'Red-Clock-Night-99' } })).status, 400);
  }
  assert.equal((await pw1('/me/password', { method: 'PUT', json: { current_password: 'nope-9-wrong', new_password: 'Red-Clock-Night-99' } })).status, 429);
  assert.equal((await pw1('/me/password', { method: 'PUT', json: { current_password: 'Green-Lamp-Evening-8', new_password: 'Red-Clock-Night-99' } })).status, 429);
  assert.equal((await pending2fa('/verify-code', { method: 'POST', json: { userId: started.body.userId, code: earlyCode } })).status, 400);
  assert.equal((await anon('/login', { method: 'POST', json: { email: 'pwtest@example.test', password: 'Green-Lamp-Evening-8' } })).status, 401);
  await dbQuery('UPDATE users SET locked_until = NULL, failed_login_attempts = 0 WHERE id = $1', [pwReg.body.userId]);

  // A hash the server cannot open (sealed with another key) is a server problem: 503, not
  // "your current password is incorrect", and it does not count toward the lock
  const passwords = require('../passwords');
  passwords.configure({ PASSWORD_PEPPER: require('node:crypto').randomBytes(32).toString('base64') });
  const [beforeKeyMix] = await dbQuery('SELECT password FROM users WHERE id = $1', [pwReg.body.userId]);
  await dbQuery('UPDATE users SET password = $1 WHERE id = $2', [await passwords.hashPassword('Green-Lamp-Evening-8'), pwReg.body.userId]);
  const unreadable = await pw1('/me/password', { method: 'PUT', json: { current_password: 'Green-Lamp-Evening-8', new_password: 'Red-Clock-Night-99' } });
  assert.equal(unreadable.status, 503, JSON.stringify(unreadable.body));
  assert.equal((await dbQuery('SELECT failed_login_attempts FROM users WHERE id = $1', [pwReg.body.userId]))[0].failed_login_attempts, 0);
  await dbQuery('UPDATE users SET password = $1 WHERE id = $2', [beforeKeyMix.password, pwReg.body.userId]);

  // Un-approved between /login and /verify-code: no session
  const unapproving = session();
  const startedLogin = await unapproving('/login', { method: 'POST', json: { email: 'pwtest@example.test', password: 'Green-Lamp-Evening-8' } });
  assert.equal(startedLogin.status, 200);
  const pendingCode = await readLoginCode('pwtest@example.test');
  await dbQuery('UPDATE users SET is_approved = FALSE WHERE id = $1', [pwReg.body.userId]);
  assert.equal((await unapproving('/verify-code', { method: 'POST', json: { userId: startedLogin.body.userId, code: pendingCode } })).status, 403);
  await dbQuery('UPDATE users SET is_approved = TRUE WHERE id = $1', [pwReg.body.userId]);

  // Parallel wrong codes cannot exceed the 5 tries per code, and the code is then void
  const racer = session();
  const raceLogin = await racer('/login', { method: 'POST', json: { email: 'pwtest@example.test', password: 'Green-Lamp-Evening-8' } });
  assert.equal(raceLogin.status, 200);
  const raceCode = await readLoginCode('pwtest@example.test');
  const wrongCode = raceCode === '000000' ? '111111' : '000000';
  const raced = await Promise.all(Array.from({ length: 12 }, () => racer('/verify-code', { method: 'POST', json: { userId: raceLogin.body.userId, code: wrongCode } })));
  assert.ok(raced.filter((r) => r.body.error === 'Incorrect code.').length <= 4, JSON.stringify(raced.map((r) => r.body.error)));
  assert.equal((await racer('/verify-code', { method: 'POST', json: { userId: raceLogin.body.userId, code: raceCode } })).status, 400);

  // No API response ever carries a password hash
  for (const r of [await admin('/admin/users'), await admin('/users/directory'), await anon('/users'), await pw1('/me')]) {
    assert.equal(/\$2b\$|\$sealed\$|scrypt/.test(JSON.stringify(r.body)), false);
  }

  // Logout clears the session
  await stud('/logout', { method: 'POST' });
  const afterLogout = await stud('/me');
  assert.equal(afterLogout.status, 401);
});
