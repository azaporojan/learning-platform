// ---------------------------------------------------------------------------
// Auto-checked tasks: a teacher gives a task hidden JUnit 5 tests; students submit Java files,
// the sandbox runner compiles them, runs the hidden tests, and the result sits next to the
// submission. Stars still come from approval: either the teacher approves, or, when the task
// says so, a submission that passes every test is approved automatically.
//
//   GET    /tasks/:id/check              admin: full config; student: what they need (no tests)
//   PUT    /tasks/:id/check              admin: {tests: [{path, content}], starter?, timeoutS?, autoApprove?, enabled?}
//   DELETE /tasks/:id/check              admin
//   POST   /tasks/:id/check/try          {files: [{path, content}], only?} → result now (not saved). Admins may
//                                        try a disabled check (to test the tests). `only: "BubbleSort"`
//                                        runs just that class's hidden tests (BubbleSortTest.java).
//   POST   /tasks/:id/submit-code        student: {files, comment?} → 201 {id, check: {status: "running"}}
//   GET    /submissions/:id/check        owner or admin: the newest check of a submission
//   POST   /submissions/:id/recheck      admin: run the hidden tests again on the same files
//
// A student sees the summary, failing test names and messages, and compile errors; test sources
// never leave the server for them, and compile errors inside hidden tests carry no line.
// ---------------------------------------------------------------------------
const { RunnerError } = require('./runnerClient');

const SAFE_PATH = /^[A-Za-z0-9_$-]+(\/[A-Za-z0-9_$-]+)*\.java$/;
const MAX_FILES = 40;
const MAX_FILE_CHARS = 100000;
const MAX_TOTAL_CHARS = 600000;
const SUBMITS_PER_MINUTE = Math.max(1, parseInt(process.env.CHECK_SUBMITS_PER_MINUTE || '3', 10));
const TRIES_PER_MINUTE = Math.max(1, parseInt(process.env.CHECK_TRIES_PER_MINUTE || '6', 10));

const httpError = (status, message, extra) => Object.assign(new Error(message), { status, extra });

function normalizeFiles(list, name, { allowEmpty = false } = {}) {
  if (!Array.isArray(list) || list.length > MAX_FILES || (!allowEmpty && list.length === 0)) {
    throw httpError(400, `${name} must be a list of 1-${MAX_FILES} files`);
  }
  const seen = new Set();
  let total = 0;
  return list.map((f, i) => {
    const p = f && typeof f.path === 'string' ? f.path.trim() : '';
    if (!SAFE_PATH.test(p)) throw httpError(400, `${name}[${i}].path must look like shop/Calculator.java`);
    if (seen.has(p)) throw httpError(400, `${name} has "${p}" twice`);
    seen.add(p);
    if (typeof f.content !== 'string' || f.content.length > MAX_FILE_CHARS) throw httpError(400, `${name}[${i}].content must be text of at most ${MAX_FILE_CHARS} characters`);
    total += f.content.length;
    if (total > MAX_TOTAL_CHARS) throw httpError(400, `${name} are too large`);
    return { path: p, content: f.content };
  });
}

// The hidden test files for one class: BubbleSort → BubbleSortTest.java, BubbleSortTests.java or
// TestBubbleSort.java, in any package. A try can run just these while the other classes are unfinished.
// Hidden files without tests of their own (helpers, fixtures) always go along, so the scoped tests compile.
const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const HAS_TESTS = /@(?:[A-Za-z_$][A-Za-z0-9_$]*\.)*(Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/;
function testsForClass(tests, className) {
  if (typeof className !== 'string' || !CLASS_NAME.test(className)) throw httpError(400, 'only must be a class name such as BubbleSort');
  const names = new Set([`${className}Test`, `${className}Tests`, `Test${className}`]);
  const hasTests = (t) => HAS_TESTS.test(t.content);
  const isFor = (t) => hasTests(t) && names.has(t.path.split('/').pop().replace(/\.java$/, ''));
  if (!tests.some(isFor)) throw httpError(400, `There are no hidden tests just for ${className}. Check all your code instead.`, { code: 'no_tests_for_class' });
  return tests.filter((t) => isFor(t) || !hasTests(t));
}

// What a student may see of a check result (admins see everything)
function studentView(result) {
  if (!result) return null;
  return {
    status: result.status,
    summary: result.summary,
    diagnostics: result.diagnostics || null,
    tests: result.tests || null,
    durationMs: result.durationMs || 0,
    ...(result.only ? { only: result.only } : {}),
  };
}

function registerTaskCheckRoutes({ api, db, io, emitToUser, authenticateToken, requireAdmin, taskLockReasons, runner, notifySubmission, approveSubmission }) {
  const isAdmin = (req) => req.user && req.user.role === 'admin';

  const fail = (res, err, label) => {
    if (err.status) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    if (err instanceof RunnerError) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error(`[${label}] Error:`, err);
    res.status(500).json({ error: 'Something went wrong with the check' });
  };

  async function loadCheck(taskId) {
    const [rows] = await db.query('SELECT * FROM task_checks WHERE task_id = ?', [taskId]);
    return rows[0] || null;
  }

  // A student may use a task's check only when the task is in a phase they have reached
  // Phase locks apply to students; a teacher only needs the task to exist
  async function studentGate(req, taskId) {
    if (isAdmin(req)) {
      const [tasks] = await db.query('SELECT id FROM tasks WHERE id = ?', [taskId]);
      if (tasks.length === 0) throw httpError(404, 'Task not found');
      return;
    }
    const reasons = await taskLockReasons(db, req.user.id, taskId);
    if (reasons === null) throw httpError(404, 'Task not found');
    if (reasons.length > 0) throw httpError(403, 'This phase is locked for you', { lockReasons: reasons });
  }

  // -------------------------------------------------------------------------
  // Config (admin)
  // -------------------------------------------------------------------------
  api.get('/tasks/:id/check', authenticateToken, async (req, res) => {
    try {
      const [tasks] = await db.query('SELECT id FROM tasks WHERE id = ?', [req.params.id]);
      if (tasks.length === 0) return res.status(404).json({ error: 'Task not found' });
      const check = await loadCheck(req.params.id);
      if (isAdmin(req)) {
        return res.json(check ? {
          enabled: check.enabled, tests: check.tests, starter: check.starter, timeout_s: check.timeout_s,
          auto_approve: check.auto_approve, updated_at: check.updated_at, runner_configured: runner.configured,
        } : { enabled: false, tests: [], starter: [], timeout_s: 30, auto_approve: false, configured: false, runner_configured: runner.configured });
      }
      await studentGate(req, req.params.id);
      if (!check || !check.enabled) return res.json({ enabled: false });
      res.json({
        enabled: true,
        starter: check.starter,
        timeout_s: check.timeout_s,
        auto_approve: check.auto_approve,
        test_files: check.tests.length,
      });
    } catch (err) {
      fail(res, err, 'GET /tasks/:id/check');
    }
  });

  api.put('/tasks/:id/check', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const [tasks] = await db.query('SELECT id FROM tasks WHERE id = ?', [req.params.id]);
      if (tasks.length === 0) return res.status(404).json({ error: 'Task not found' });
      const tests = normalizeFiles(b.tests, 'tests');
      const starter = b.starter === undefined ? [] : normalizeFiles(b.starter, 'starter', { allowEmpty: true });
      const timeoutS = b.timeoutS === undefined ? 30 : b.timeoutS;
      if (!Number.isInteger(timeoutS) || timeoutS < 5 || timeoutS > 60) throw httpError(400, 'timeoutS must be 5-60 seconds');
      for (const [k, v] of [['autoApprove', b.autoApprove], ['enabled', b.enabled]]) {
        if (v !== undefined && typeof v !== 'boolean') throw httpError(400, `${k} must be true or false`);
      }
      const [rows] = await db.query(
        `INSERT INTO task_checks (task_id, tests, starter, timeout_s, auto_approve, enabled, updated_by)
         VALUES (?, ?::jsonb, ?::jsonb, ?, ?, ?, ?)
         ON CONFLICT (task_id) DO UPDATE SET tests = EXCLUDED.tests, starter = EXCLUDED.starter, timeout_s = EXCLUDED.timeout_s,
           auto_approve = EXCLUDED.auto_approve, enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by
         RETURNING *`,
        [req.params.id, JSON.stringify(tests), JSON.stringify(starter), timeoutS, b.autoApprove === true, b.enabled !== false, req.user.id]
      );
      io.emit('task:updated', { taskId: Number(req.params.id) });
      const c = rows[0];
      res.json({ enabled: c.enabled, tests: c.tests, starter: c.starter, timeout_s: c.timeout_s, auto_approve: c.auto_approve, updated_at: c.updated_at });
    } catch (err) {
      fail(res, err, 'PUT /tasks/:id/check');
    }
  });

  api.delete('/tasks/:id/check', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const [tasks] = await db.query('SELECT id FROM tasks WHERE id = ?', [req.params.id]);
      if (tasks.length === 0) return res.status(404).json({ error: 'Task not found' });
      await db.query('DELETE FROM task_checks WHERE task_id = ?', [req.params.id]);
      io.emit('task:updated', { taskId: Number(req.params.id) });
      res.json({ success: true });
    } catch (err) {
      fail(res, err, 'DELETE /tasks/:id/check');
    }
  });

  // -------------------------------------------------------------------------
  // Trying (not saved)
  // -------------------------------------------------------------------------
  // Per-process limits: the platform runs as one instance (docs/DEPLOYMENT.md). Each minute window
  // is pruned as it is read, and idle users are dropped every few minutes.
  const inFlight = new Set();
  const recent = new Map();
  const recentSubmits = new Map();
  const submitting = new Set(); // users whose submission is being created right now
  setInterval(() => {
    const now = Date.now();
    for (const m of [recent, recentSubmits]) for (const [k, list] of m) if (!list.some((t) => now - t < 60000)) m.delete(k);
  }, 5 * 60 * 1000).unref();
  function admitTry(userId) {
    if (inFlight.has(userId)) throw httpError(429, 'A check is already running. Wait for it to finish.', { code: 'in_flight' });
    const now = Date.now();
    const list = (recent.get(userId) || []).filter((t) => now - t < 60000);
    if (list.length >= TRIES_PER_MINUTE) throw httpError(429, `At most ${TRIES_PER_MINUTE} checks a minute. Wait a few seconds.`, { code: 'rate_limited' });
    list.push(now);
    recent.set(userId, list);
    inFlight.add(userId);
  }

  api.post('/tasks/:id/check/try', authenticateToken, async (req, res) => {
    let admitted = false;
    try {
      const { files: rawFiles, only } = req.body || {};
      const files = normalizeFiles(rawFiles, 'files');
      const check = await loadCheck(req.params.id);
      if (!isAdmin(req)) {
        await studentGate(req, req.params.id);
        if (!check || !check.enabled) throw httpError(404, 'This task is not checked automatically');
      } else if (!check || check.tests.length === 0) {
        throw httpError(400, 'Save some hidden tests first');
      }
      const scoped = only === undefined || only === null || only === '' ? null : testsForClass(check.tests, only);
      admitTry(req.user.id);
      admitted = true;
      const result = await runner.check(files, scoped || check.tests, check.timeout_s * 1000);
      if (scoped) result.only = only;
      res.json(isAdmin(req) ? result : studentView(result));
    } catch (err) {
      fail(res, err, 'POST /tasks/:id/check/try');
    } finally {
      if (admitted) inFlight.delete(req.user.id);
    }
  });

  // -------------------------------------------------------------------------
  // Submitting code, and the check that follows
  // -------------------------------------------------------------------------
  async function runSubmissionCheck(checkId, submissionId, taskId, userId, files) {
    let result;
    try {
      const check = await loadCheck(taskId);
      if (!check || check.tests.length === 0) {
        result = { status: 'error', summary: 'The teacher removed the tests of this task. A teacher will review your code.' };
      } else {
        result = await runner.check(files, check.tests, check.timeout_s * 1000);
      }
      await db.query(
        `UPDATE submission_checks SET status = ?, summary = ?, passed = ?, total = ?, result = ?::jsonb, finished_at = NOW() WHERE id = ?`,
        [result.status, result.summary || '', result.tests ? result.tests.passed : null, result.tests ? result.tests.total : null, JSON.stringify(result), checkId]
      );
      // Auto-approve: only a pending submission that passed every test, when the task allows it.
      // The result is already saved, so a failure here is logged and never turns a pass into an error.
      if (check && check.auto_approve && result.status === 'passed') {
        try {
          const [subs] = await db.query("SELECT status FROM task_submissions WHERE id = ?", [submissionId]);
          if (subs.length && subs[0].status === 'pending') await approveSubmission(submissionId, { auto: true });
        } catch (err) {
          console.error('[check] auto-approve failed; a teacher can approve by hand:', err);
        }
      }
    } catch (err) {
      const unavailable = err instanceof RunnerError;
      if (!unavailable) console.error('[check] failed:', err);
      await db.query(
        `UPDATE submission_checks SET status = ?, summary = ?, finished_at = NOW() WHERE id = ?`,
        [unavailable ? 'unavailable' : 'error', unavailable ? 'The checker is not available right now. A teacher will review your code, or it can be checked again later.' : 'The check failed on the server.', checkId]
      ).catch(() => {});
    }
    // Only the student and the teachers learn about it, never every connected client
    const payload = { submissionId, taskId: Number(taskId), userId };
    emitToUser(userId, 'submission:checked', payload);
    try {
      const [admins] = await db.query("SELECT id FROM users WHERE role = 'admin'");
      for (const a of admins) if (a.id !== userId) emitToUser(a.id, 'submission:checked', payload);
    } catch (err) {
      console.error('[check] could not notify teachers:', err.message);
    }
  }

  async function insertCheck(q, submissionId, files) {
    const [rows] = await q.query(
      `INSERT INTO submission_checks (submission_id, files, status, summary) VALUES (?, ?::jsonb, 'running', 'Checking…') RETURNING id`,
      [submissionId, JSON.stringify(files)]
    );
    return rows[0].id;
  }

  async function startCheck(submissionId, taskId, userId, files) {
    const checkId = await insertCheck(db, submissionId, files);
    // Not awaited: the answer goes out now, the result arrives as a live event
    runSubmissionCheck(checkId, submissionId, taskId, userId, files).catch((err) => console.error('[check] failed:', err));
    return checkId;
  }

  // A student submits at most SUBMITS_PER_MINUTE times a minute, and never while one of their
  // submissions is still being checked: the runner queue and the teacher's inbox stay bounded.
  // The minute window is taken synchronously, so parallel requests cannot all pass.
  // The caller holds `submitting` until its submission and check row exist (release it with
  // doneSubmitting), so a parallel request sees either the slot or the running check.
  const inFlightError = () => httpError(429, 'Your last submission is still being checked. Wait for its result.', { code: 'in_flight' });
  async function admitSubmit(userId) {
    if (submitting.has(userId)) throw inFlightError();
    submitting.add(userId);
    try {
      const [running] = await db.query(
        `SELECT 1 FROM submission_checks c JOIN task_submissions s ON s.id = c.submission_id
          WHERE s.user_id = ? AND c.status = 'running' LIMIT 1`,
        [userId]
      );
      if (running.length) throw inFlightError(); // refused: takes no slot in the minute window
      // Read after the await, but `submitting` keeps this user's requests one at a time
      const now = Date.now();
      const list = (recentSubmits.get(userId) || []).filter((t) => now - t < 60000);
      if (list.length >= SUBMITS_PER_MINUTE) throw httpError(429, `At most ${SUBMITS_PER_MINUTE} submissions a minute.`, { code: 'rate_limited' });
      list.push(now);
      recentSubmits.set(userId, list);
    } catch (err) {
      submitting.delete(userId);
      throw err;
    }
  }

  api.post('/tasks/:id/submit-code', authenticateToken, async (req, res) => {
    let admitted = false;
    try {
      const b = req.body || {};
      const files = normalizeFiles(b.files, 'files');
      const comment = typeof b.comment === 'string' ? b.comment.trim() : '';
      if (comment.length > 4000) throw httpError(400, 'Comment is too long (max 4000 characters)');
      await studentGate(req, req.params.id);
      const check = await loadCheck(req.params.id);
      if (!check || !check.enabled) throw httpError(400, 'This task is not checked automatically: submit a link or a file instead');
      if (!isAdmin(req)) { await admitSubmit(req.user.id); admitted = true; }
      const label = `Code: ${files.map((f) => f.path.split('/').pop()).join(', ')}`.slice(0, 250);
      // The submission and its check row are created together, so a failure leaves neither behind
      const { submissionId, checkId } = await db.transaction(async (tx) => {
        const [result] = await tx.query(
          'INSERT INTO task_submissions (task_id, user_id, file_name, file_path, file_size, comment) VALUES (?, ?, NULL, NULL, NULL, ?) RETURNING id',
          [req.params.id, req.user.id, comment ? `${comment}\n\n${label}` : label]
        );
        return { submissionId: result[0].id, checkId: await insertCheck(tx, result[0].id, files) };
      });
      // Not awaited; a rejection is logged instead of crashing the process
      runSubmissionCheck(checkId, submissionId, req.params.id, req.user.id, files).catch((err) => console.error('[check] failed:', err));
      // Not awaited: notifySubmission logs its own failures, and the submission stands either way
      notifySubmission(req.params.id, req.user.id, submissionId, { comment: comment || label, kind: 'code' });
      res.status(201).json({ id: submissionId, check: { status: 'running' } });
    } catch (err) {
      fail(res, err, 'POST /tasks/:id/submit-code');
    } finally {
      // The check row now exists (or nothing was created): the running-check query takes over
      if (admitted) submitting.delete(req.user.id);
    }
  });

  api.get('/submissions/:id/check', authenticateToken, async (req, res) => {
    try {
      const [subs] = await db.query('SELECT id, user_id, task_id FROM task_submissions WHERE id = ?', [req.params.id]);
      if (subs.length === 0) return res.status(404).json({ error: 'Submission not found' });
      if (subs[0].user_id !== req.user.id && !isAdmin(req)) return res.status(404).json({ error: 'Submission not found' });
      const [rows] = await db.query('SELECT * FROM submission_checks WHERE submission_id = ? ORDER BY id DESC LIMIT 1', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'This submission has no code check' });
      const c = rows[0];
      res.json({
        id: c.id,
        submission_id: c.submission_id,
        status: c.status,
        summary: c.summary,
        passed: c.passed,
        total: c.total,
        files: c.files,
        result: isAdmin(req) ? c.result : studentView(c.result),
        created_at: c.created_at,
        finished_at: c.finished_at,
      });
    } catch (err) {
      fail(res, err, 'GET /submissions/:id/check');
    }
  });

  api.post('/submissions/:id/recheck', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const [rows] = await db.query(
        `SELECT c.files, s.task_id, s.user_id FROM submission_checks c JOIN task_submissions s ON s.id = c.submission_id
         WHERE c.submission_id = ? ORDER BY c.id DESC LIMIT 1`,
        [req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'This submission has no code to check' });
      const [latest] = await db.query('SELECT status FROM submission_checks WHERE submission_id = ? ORDER BY id DESC LIMIT 1', [req.params.id]);
      if (latest[0].status === 'running') return res.status(409).json({ error: 'This submission is being checked right now.', code: 'running' });
      await startCheck(Number(req.params.id), rows[0].task_id, rows[0].user_id, rows[0].files);
      res.status(202).json({ status: 'running' });
    } catch (err) {
      fail(res, err, 'POST /submissions/:id/recheck');
    }
  });

  // A check that was running when the server stopped will never finish: say so
  async function markInterrupted() {
    try {
      await db.query(
        `UPDATE submission_checks SET status = 'error', summary = 'The check was interrupted by a server restart. It can be checked again.', finished_at = NOW()
         WHERE status = 'running'`
      );
    } catch (err) {
      console.error('[check] could not mark interrupted checks:', err.message);
    }
  }

  return { markInterrupted };
}

// SQL fragment: the newest check of a submission aliased "s" (for submission lists)
const LATEST_CHECK_JOIN = `LEFT JOIN LATERAL (
  SELECT sc.status AS check_status, sc.passed AS check_passed, sc.total AS check_total
    FROM submission_checks sc WHERE sc.submission_id = s.id ORDER BY sc.id DESC LIMIT 1
) chk ON TRUE`;

module.exports = { registerTaskCheckRoutes, normalizeFiles, studentView, testsForClass, LATEST_CHECK_JOIN };
