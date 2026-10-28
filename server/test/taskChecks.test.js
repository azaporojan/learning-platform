// Auto-checked tasks against PostgreSQL with a fake runner.
//   DB_HOST=localhost DB_NAME=learning_test DB_USER=learning DB_PASSWORD=learning npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeFiles, studentView, testsForClass } = require('../taskChecks');
const { dbReachable, resetDb, dbQuery, startServer, waitForHealth, session, loginHelpers } = require('./support/server');

test('files are validated', () => {
  assert.throws(() => normalizeFiles([], 'files'), /1-40/);
  assert.throws(() => normalizeFiles([{ path: '../x.java', content: '' }], 'files'), /path/);
  assert.throws(() => normalizeFiles([{ path: 'A.java', content: '' }, { path: 'A.java', content: '' }], 'files'), /twice/);
  assert.deepEqual(normalizeFiles([{ path: ' shop/A.java ', content: 'x' }], 'files'), [{ path: 'shop/A.java', content: 'x' }]);
  assert.deepEqual(normalizeFiles([], 'starter', { allowEmpty: true }), []);
});

test('students never get the checker stdout', () => {
  assert.deepEqual(Object.keys(studentView({ status: 'failed', summary: 's', tests: {}, stdout: 'secret', diagnostics: null, durationMs: 3 })).sort(),
    ['diagnostics', 'durationMs', 'status', 'summary', 'tests']);
});

test('a try can be limited to the hidden tests of one class', () => {
  const tests = ['BubbleSortTest.java', 'shop/CartTests.java', 'TestPalindrome.java', 'BinarySearchTest.java'].map((path) => ({ path, content: '' }));
  assert.deepEqual(testsForClass(tests, 'BubbleSort').map((t) => t.path), ['BubbleSortTest.java']);
  assert.deepEqual(testsForClass(tests, 'Cart').map((t) => t.path), ['shop/CartTests.java']);
  assert.deepEqual(testsForClass(tests, 'Palindrome').map((t) => t.path), ['TestPalindrome.java']);
  assert.throws(() => testsForClass(tests, 'Binary'), (e) => e.status === 400 && /no hidden tests just for Binary/.test(e.message));
  assert.throws(() => testsForClass(tests, '../x'), (e) => e.status === 400);
  assert.throws(() => testsForClass(tests, 42), (e) => e.status === 400);
});

test('studentView keeps which class a try was limited to', () => {
  assert.equal(studentView({ status: 'passed', summary: 's', tests: {}, only: 'BubbleSort' }).only, 'BubbleSort');
});

// The fake runner: passes when every student file contains "// correct", fails otherwise
function fakeRunner() {
  const calls = [];
  let release = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const json = body ? JSON.parse(body) : {};
      calls.push({ url: req.url, json });
      const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.url !== '/check') return send(404, { error: 'not found' });
      if (json.files.some((f) => f.content.includes('// slow'))) await new Promise((r) => { release = r; });
      const ok = json.files.every((f) => f.content.includes('// correct'));
      send(200, ok
        ? { status: 'passed', summary: '2 of 2 tests passed.', tests: { total: 2, passed: 2, failed: [] }, stdout: 'debug output', durationMs: 900 }
        : { status: 'failed', summary: '1 of 2 tests passed.', tests: { total: 2, passed: 1, failed: [{ name: 'CalcTest.adds', message: 'expected: 5 but was: 4' }] }, stdout: 'debug output', durationMs: 900 });
    });
  });
  return { server, calls, release: () => release && release() };
}

async function eventually(fn, message) {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(message);
}

test('auto-checked tasks API', { timeout: 120000 }, async (t) => {
  if (!(await dbReachable())) { t.skip('no PostgreSQL reachable'); return; }
  await resetDb();
  const runner = fakeRunner();
  await new Promise((r) => runner.server.listen(0, '127.0.0.1', r));
  const port = 4100 + Math.floor(Math.random() * 100);
  const base = `http://127.0.0.1:${port}/api`;
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-chk-'));
  const child = startServer({
    port, uploadsDir, adminEmail: 'teacher@example.test',
    env: { RUNNER_URL: `http://127.0.0.1:${runner.server.address().port}`, RUNNER_TOKEN: 'runner-token-for-tests-0123456789', CHECK_TRIES_PER_MINUTE: '50', CHECK_SUBMITS_PER_MINUTE: '4' },
  });
  t.after(() => { child.kill('SIGTERM'); runner.server.close(); fs.rmSync(uploadsDir, { recursive: true, force: true }); });
  await waitForHealth(child, base);
  const { loginAs } = loginHelpers(child, base);
  const anon = session(base);
  await anon('/register', { method: 'POST', json: { name: 'Teacher', email: 'teacher@example.test', password: 'TeacherPass123!' } });
  await anon('/register', { method: 'POST', json: { name: 'Stu', email: 'stu@example.test', password: 'StudentPass1!' } });
  const admin = await loginAs('teacher@example.test', 'TeacherPass123!');
  const studentId = (await admin('/admin/users')).body.find((u) => u.email === 'stu@example.test').id;
  await admin(`/users/${studentId}/approve`, { method: 'POST' });
  const stud = await loginAs('stu@example.test', 'StudentPass1!');

  const course = await admin('/courses', { method: 'POST', json: { name: 'Java', description: '' } });
  const phase = await admin('/paths', { method: 'POST', json: { name: 'Phase 1', stars_required: 0, course_id: course.body.id } });
  const lesson = await admin('/lessons', { method: 'POST', json: { pathId: phase.body.id, title: 'Methods', order: 1 } });
  const task = await admin('/tasks', { method: 'POST', json: { lessonId: lesson.body.id, title: 'Calculator', type: 'mandatory', xp: 10, deadline: '2030-01-01' } });
  const taskId = task.body.id;
  const tests = [{ path: 'shop/CalcTest.java', content: 'package shop; class CalcTest { /* hidden */ }' }];
  const starter = [{ path: 'shop/Calc.java', content: 'package shop;\npublic class Calc {\n}\n' }];

  // Admin-only configuration
  assert.equal((await stud(`/tasks/${taskId}/check`, { method: 'PUT', json: { tests } })).status, 403);
  assert.equal((await admin(`/tasks/${taskId}/check`, { method: 'PUT', json: { tests: [{ path: '/etc/passwd', content: '' }] } })).status, 400);
  const put = await admin(`/tasks/${taskId}/check`, { method: 'PUT', json: { tests, starter, timeoutS: 20, autoApprove: false } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.timeout_s, 20);

  // A student who has not enrolled cannot use it; after enrolling they see no tests
  assert.equal((await stud(`/tasks/${taskId}/check`)).status, 403);
  await stud(`/courses/${course.body.id}/enroll`, { method: 'POST' });
  const seen = await stud(`/tasks/${taskId}/check`);
  assert.equal(seen.status, 200);
  assert.equal(seen.body.enabled, true);
  assert.deepEqual(seen.body.starter, starter);
  assert.equal(seen.body.tests, undefined);
  assert.equal(JSON.stringify(seen.body).includes('hidden'), false, 'hidden test sources never reach a student');

  // Try: result now, nothing saved; the student does not get the checker stdout
  const tried = await stud(`/tasks/${taskId}/check/try`, { method: 'POST', json: { files: [{ path: 'shop/Calc.java', content: 'wrong' }] } });
  assert.equal(tried.status, 200, JSON.stringify(tried.body));
  assert.equal(tried.body.status, 'failed');
  assert.equal(tried.body.stdout, undefined);
  assert.equal(tried.body.tests.failed[0].name, 'CalcTest.adds');
  const sent = runner.calls.find((c) => c.url === '/check');
  assert.deepEqual(sent.json.tests, tests);
  assert.equal(sent.json.timeoutMs, 20000);
  assert.equal((await dbQuery('SELECT COUNT(*)::int AS n FROM task_submissions')).at(0).n, 0);
  // Only one class: just its hidden test files go to the runner
  const calcOnly = await stud(`/tasks/${taskId}/check/try`, { method: 'POST', json: { files: [{ path: 'shop/Calc.java', content: 'wrong' }], only: 'Calc' } });
  assert.equal(calcOnly.status, 200, JSON.stringify(calcOnly.body));
  assert.equal(calcOnly.body.only, 'Calc');
  assert.deepEqual(runner.calls.filter((c) => c.url === '/check').at(-1).json.tests, tests);
  const calls = runner.calls.length;
  const noTests = await stud(`/tasks/${taskId}/check/try`, { method: 'POST', json: { files: [{ path: 'shop/Calc.java', content: 'wrong' }], only: 'Cart' } });
  assert.equal(noTests.status, 400);
  assert.equal(runner.calls.length, calls, 'nothing runs when the class has no hidden tests');
  const adminTry = await admin(`/tasks/${taskId}/check/try`, { method: 'POST', json: { files: [{ path: 'shop/Calc.java', content: '// correct' }] } });
  assert.equal(adminTry.body.stdout, 'debug output');

  // Submit: answered at once, checked in the background, result next to the submission
  const sub = await stud(`/tasks/${taskId}/submit-code`, { method: 'POST', json: { files: [{ path: 'shop/Calc.java', content: 'almost' }], comment: 'first try' } });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.equal(sub.body.check.status, 'running');
  const done = await eventually(async () => {
    const r = await stud(`/submissions/${sub.body.id}/check`);
    return r.body.status !== 'running' && r.body;
  }, 'the check never finished');
  assert.equal(done.status, 'failed');
  assert.deepEqual([done.passed, done.total], [1, 2]);
  assert.equal(done.files[0].content, 'almost');
  assert.equal(done.result.stdout, undefined);
  assert.equal((await admin(`/submissions/${sub.body.id}/check`)).body.result.stdout, 'debug output');
  const list = await admin(`/tasks/${taskId}/submissions`);
  assert.equal(list.body[0].check_status, 'failed');
  assert.equal(list.body[0].check_passed, 1);
  const inbox = await admin('/admin/submissions?status=pending');
  assert.equal(inbox.body.submissions[0].check_total, 2);
  assert.equal(inbox.body.submissions[0].status, 'pending', 'no auto-approve without the flag');

  // Another student's check is not visible
  await anon('/register', { method: 'POST', json: { name: 'Other', email: 'other@example.test', password: 'OtherPass12!' } });
  const otherId = (await admin('/admin/users')).body.find((u) => u.email === 'other@example.test').id;
  await admin(`/users/${otherId}/approve`, { method: 'POST' });
  const other = await loginAs('other@example.test', 'OtherPass12!');
  assert.equal((await other(`/submissions/${sub.body.id}/check`)).status, 404);

  // Auto-approve: a passing submission is approved and the task counts as done
  await admin(`/tasks/${taskId}/check`, { method: 'PUT', json: { tests, starter, timeoutS: 20, autoApprove: true } });
  const good = await stud(`/tasks/${taskId}/submit-code`, { method: 'POST', json: { files: [{ path: 'shop/Calc.java', content: '// correct' }] } });
  await eventually(async () => (await dbQuery("SELECT status FROM task_submissions WHERE id = $1", [good.body.id]))[0].status === 'approved', 'not auto-approved');
  // Approval sets the status first, then records progress and notifies: wait for each
  await eventually(async () => (await dbQuery("SELECT 1 FROM user_progress WHERE user_id = $1 AND entity_type = 'task' AND entity_id = $2", [studentId, taskId])).length === 1, 'no progress recorded');
  await eventually(async () => (await stud('/notifications')).body.some((n) => n.type === 'submission_approved' && /automatically/.test(n.message)), 'no approval notification');

  // Re-check runs the same files again; a check interrupted by a restart is marked as such
  assert.equal((await admin(`/submissions/${sub.body.id}/recheck`, { method: 'POST' })).status, 202);
  await eventually(async () => (await admin(`/submissions/${sub.body.id}/check`)).body.status === 'failed', 'recheck did not finish');
  assert.equal((await dbQuery('SELECT COUNT(*)::int AS n FROM submission_checks WHERE submission_id = $1', [sub.body.id]))[0].n, 2);

  // While a submission is being checked, the student cannot submit again and nobody can re-check it
  const slowSub = await stud(`/tasks/${taskId}/submit-code`, { method: 'POST', json: { files: [{ path: 'shop/Calc.java', content: '// slow' }] } });
  assert.equal(slowSub.status, 201);
  const again = await stud(`/tasks/${taskId}/submit-code`, { method: 'POST', json: { files: [{ path: 'shop/Calc.java', content: 'x' }] } });
  assert.equal(again.status, 429);
  assert.equal(again.body.code, 'in_flight');
  assert.equal((await admin(`/submissions/${slowSub.body.id}/recheck`, { method: 'POST' })).status, 409);
  await eventually(async () => { runner.release(); return (await stud(`/submissions/${slowSub.body.id}/check`)).body.status === 'failed'; }, 'slow check did not finish');
  // ...a refused attempt takes no slot, and at most CHECK_SUBMITS_PER_MINUTE (4 here) go through a minute
  const fourth = await stud(`/tasks/${taskId}/submit-code`, { method: 'POST', json: { files: [{ path: 'shop/Calc.java', content: 'x' }] } });
  assert.equal(fourth.status, 201, JSON.stringify(fourth.body));
  await eventually(async () => (await stud(`/submissions/${fourth.body.id}/check`)).body.status === 'failed', 'fourth check did not finish');
  const fifth = await stud(`/tasks/${taskId}/submit-code`, { method: 'POST', json: { files: [{ path: 'shop/Calc.java', content: 'x' }] } });
  assert.equal(fifth.status, 429);
  assert.equal(fifth.body.code, 'rate_limited');
  assert.equal((await admin('/tasks/999999/check', { method: 'DELETE' })).status, 404);

  // Tasks without a check refuse code submissions; removing the check turns it off
  assert.equal((await admin(`/tasks/${taskId}/check`, { method: 'DELETE' })).status, 200);
  assert.equal((await stud(`/tasks/${taskId}/check`)).body.enabled, false);
  assert.equal((await stud(`/tasks/${taskId}/submit-code`, { method: 'POST', json: { files: [{ path: 'shop/Calc.java', content: 'x' }] } })).status, 400);
});
