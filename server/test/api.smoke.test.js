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
  const gone = await admin(`/lessons/${second.body.id}`, { method: 'DELETE' });
  assert.equal(gone.status, 200);

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

  // Phase gating is server-side: without enrolment the submission is refused (and the upload dropped)
  const earlyForm = new FormData();
  earlyForm.append('file', new Blob(['x'], { type: 'text/plain' }), 'early.txt');
  const early = await stud(`/tasks/${task.body.id}/submit`, { method: 'POST', body: earlyForm });
  assert.equal(early.status, 403, JSON.stringify(early.body));
  assert.deepEqual(early.body.lockReasons, ['enroll']);
  assert.equal(fs.readdirSync(uploadsDir).length, 0);
  const firstEnrol = await stud(`/courses/${course.body.id}/enroll`, { method: 'POST' });
  assert.equal(firstEnrol.status, 200);

  const form = new FormData();
  form.append('file', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), '../evil name.html');
  const submit = await stud(`/tasks/${task.body.id}/submit`, { method: 'POST', body: form });
  assert.equal(submit.status, 201, JSON.stringify(submit.body));
  const stored = fs.readdirSync(uploadsDir);
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
  for (const sid of [commentOnly.body.id, both.body.id]) assert.equal((await stud(`/submissions/${sid}`, { method: 'DELETE' })).status, 200);
  assert.equal(fs.readdirSync(uploadsDir).length, 1);

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
  assert.equal(fs.readdirSync(uploadsDir).length, 1); // the rejected upload was removed
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
  assert.equal((await admin('/courses/abc', { method: 'DELETE' })).status, 404);
  assert.equal((await anon('/paths/abc/details')).status, 404);
  assert.equal((await stud('/tasks/abc')).status, 404);
  const ghostForm = new FormData();
  ghostForm.append('file', new Blob(['x'], { type: 'text/plain' }), 'ghost.txt');
  const ghostSubmit = await stud('/tasks/999999/submit', { method: 'POST', body: ghostForm });
  assert.equal(ghostSubmit.status, 404);
  assert.ok(!fs.readdirSync(uploadsDir).some((f) => f.endsWith('ghost.txt')));
  assert.equal((await admin('/paths/999999', { method: 'DELETE' })).status, 404);
  // Add a star gate on phase 2 that the student (10 stars) does not meet
  const gate = await admin(`/paths/${phase2.body.id}`, { method: 'PUT', json: { name: 'Phase 2', stars_required: 500 } });
  assert.equal(gate.status, 200);
  const roadGated = await stud(`/courses/${course.body.id}`);
  assert.deepEqual(roadGated.body.phases[1].lockReasons, ['stars']);
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

  // Logout clears the session
  await stud('/logout', { method: 'POST' });
  const afterLogout = await stud('/me');
  assert.equal(afterLogout.status, 401);
});
