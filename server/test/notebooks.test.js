// Notebooks: Markdown format (unit) and the API against PostgreSQL with a fake runner.
//   DB_HOST=localhost DB_NAME=learning_test DB_USER=learning DB_PASSWORD=learning npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseNotebookMarkdown, notebookToMarkdown } = require('../notebookMarkdown');
const { normalizeCells, pruneOutputs } = require('../notebooks');
const { dbReachable, resetDb, startServer, waitForHealth, session, loginHelpers } = require('./support/server');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

test('Markdown: code fences, text cells, title, round trip', () => {
  const md = [
    '# Streams: filter, map',
    '',
    '> **Goal** turn a loop into a pipeline.',
    '',
    '```java',
    'int notRun = 1; // highlighted only',
    '```',
    '',
    '```java run',
    'var xs = List.of(1, 2, 3);',
    '```',
    '',
    'Now filter.',
    '<!-- cell -->',
    'A second text cell.',
    '',
    '````java run',
    'String s = """',
    '```',
    '""";',
    '````',
  ].join('\n');
  const { title, cells } = parseNotebookMarkdown(md);
  assert.equal(title, 'Streams: filter, map');
  assert.deepEqual(cells.map((c) => c.kind), ['text', 'code', 'text', 'text', 'code']);
  assert.match(cells[0].source, /```java\nint notRun/);
  assert.equal(cells[1].source, 'var xs = List.of(1, 2, 3);');
  assert.equal(cells[4].source, 'String s = """\n```\n""";');
  const again = parseNotebookMarkdown(notebookToMarkdown(cells)).cells;
  assert.deepEqual(again.map((c) => [c.kind, c.source]), cells.map((c) => [c.kind, c.source]));
});

test('cells are validated and outputs follow the cells', () => {
  assert.throws(() => normalizeCells([{ kind: 'shell', source: '' }]), /kind/);
  assert.throws(() => normalizeCells([{ kind: 'code', source: 'x'.repeat(20001) }]), /at most/);
  const cells = normalizeCells([{ id: 'a', kind: 'code', source: '1' }, { id: 'a', kind: 'text', source: 'dup id' }, { kind: 'code', source: '' }]);
  assert.equal(new Set(cells.map((c) => c.id)).size, 3);
  assert.equal(cells[0].id, 'a');
  assert.deepEqual(Object.keys(pruneOutputs({ a: {}, gone: {}, $count: 3 }, cells)).sort(), ['$count', 'a']);
});

// The fake runner answers like runner/src/runner.js: each cell echoes its source as the value
function fakeRunner() {
  const calls = [];
  const sessions = new Map();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      calls.push({ method: req.method, url: req.url, json, auth: req.headers.authorization });
      const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.headers.authorization !== 'Bearer runner-token-for-tests-0123456789') return send(401, { error: 'unauthorized' });
      if (req.url === '/run') {
        const failAt = json.cells.findIndex((c) => c.includes('FAIL'));
        const cells = json.cells.map((src, index) => {
          if (failAt !== -1 && index > failAt) return { index, status: 'not_run', stdout: '', stderr: '', value: null, error: null, durationMs: 0 };
          if (index === failAt) return { index, status: 'error', stdout: '', stderr: '', value: null, error: { kind: 'compile', message: 'nope', line: 1 }, durationMs: 1 };
          return { index, status: 'ok', stdout: `ran ${index}\n`, stderr: '', value: src, error: null, durationMs: 1 };
        });
        return send(200, { status: failAt === -1 ? 'ok' : 'error', cells, durationMs: 5, warm: true, queuedMs: 0 });
      }
      if (req.url.startsWith('/queue/')) return send(200, { position: 0 });
      if (req.url === '/stats') return send(200, { pool: {}, sessions: [...sessions.values()] });
      if (req.url === '/sessions' && req.method === 'POST') {
        const s = [...sessions.values()].find((x) => x.owner === json.owner) || { id: `s${sessions.size + 1}`, owner: json.owner, executionCount: 0 };
        sessions.set(s.id, s);
        return send(201, s);
      }
      const del = req.method === 'DELETE' && req.url.match(/^\/sessions\/([^/?]+)\?owner=(.+)$/);
      if (del) { sessions.delete(del[1]); return send(200, { closed: true }); }
      const m = req.url.match(/^\/sessions\/([^/?]+)\/cells$/);
      if (m) {
        const s = sessions.get(m[1]);
        if (!s) return send(404, { error: 'ended', code: 'no_session' });
        s.executionCount += 1;
        return send(200, { index: s.executionCount, status: 'ok', stdout: '', stderr: '', value: json.source, error: null, executionCount: s.executionCount, sessionEnded: false, durationMs: 1 });
      }
      send(404, { error: 'not found' });
    });
  });
  return { server, calls, sessions };
}

test('notebooks API', { timeout: 120000 }, async (t) => {
  if (!(await dbReachable())) { t.skip('no PostgreSQL reachable'); return; }
  await resetDb();
  const runner = fakeRunner();
  await new Promise((r) => runner.server.listen(0, '127.0.0.1', r));
  const port = 4000 + Math.floor(Math.random() * 100);
  const base = `http://127.0.0.1:${port}/api`;
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-nb-'));
  const child = startServer({
    port, uploadsDir, adminEmail: 'teacher@example.test',
    env: { RUNNER_URL: `http://127.0.0.1:${runner.server.address().port}`, RUNNER_TOKEN: 'runner-token-for-tests-0123456789', NOTEBOOK_RUNS_PER_MINUTE: '50' },
  });
  t.after(() => { child.kill('SIGTERM'); runner.server.close(); fs.rmSync(uploadsDir, { recursive: true, force: true }); });
  await waitForHealth(child, base);
  const { loginAs } = loginHelpers(child, base);
  const anon = session(base);

  await anon('/register', { method: 'POST', json: { name: 'Teacher', email: 'teacher@example.test', password: 'TeacherPass123!' } });
  const reg = await anon('/register', { method: 'POST', json: { name: 'Stu Dent', email: 'stu@example.test', password: 'StudentPass1!' } });
  const admin = await loginAs('teacher@example.test', 'TeacherPass123!');
  const users = await admin('/admin/users');
  const studentId = users.body.find((u) => u.email === 'stu@example.test').id;
  assert.equal((await admin(`/users/${studentId}/approve`, { method: 'POST' })).status, 200);
  assert.ok(reg.status === 201);
  const stud = await loginAs('stu@example.test', 'StudentPass1!');

  const course = await admin('/courses', { method: 'POST', json: { name: 'Java', description: '' } });
  const p1 = await admin('/paths', { method: 'POST', json: { name: 'Phase 1', stars_required: 0, course_id: course.body.id } });
  const p2 = await admin('/paths', { method: 'POST', json: { name: 'Phase 2', stars_required: 0, course_id: course.body.id } });
  await admin(`/paths/${p2.body.id}`, { method: 'PUT', json: { name: 'Phase 2', stars_required: 50 } });
  const l1 = await admin('/lessons', { method: 'POST', json: { pathId: p1.body.id, title: 'Streams', order: 1 } });
  const l2 = await admin('/lessons', { method: 'POST', json: { pathId: p2.body.id, title: 'Later', order: 1 } });
  assert.equal((await stud(`/courses/${course.body.id}/enroll`, { method: 'POST' })).status, 200);

  // Anonymous: nothing
  assert.equal((await anon('/notebooks')).status, 401);

  // Teacher creates a lesson notebook; students cannot see it until it is published
  const created = await admin('/notebooks', { method: 'POST', json: {
    title: 'Streams intro', lessonId: l1.body.id,
    cells: [{ id: 'intro', kind: 'text', source: '# Streams' }, { id: 'c1', kind: 'code', source: 'int x = 1;' }, { id: 'c2', kind: 'code', source: 'x + 1' }],
  } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const nb = created.body;
  assert.equal(nb.kind, 'lesson');
  assert.equal(nb.lesson.title, 'Streams');
  assert.equal(nb.can_edit, true);
  assert.equal((await stud(`/notebooks/${nb.id}`)).status, 404);
  assert.equal((await admin(`/notebooks/${nb.id}`, { method: 'PUT', json: { published: true } })).status, 200);

  // Students: read, but neither edit nor run the teacher's notebook
  const seen = await stud(`/notebooks/${nb.id}`);
  assert.equal(seen.status, 200);
  assert.equal(seen.body.can_edit, false);
  assert.equal((await stud(`/notebooks/${nb.id}`, { method: 'PUT', json: { title: 'mine now' } })).status, 403);
  assert.equal((await stud(`/notebooks/${nb.id}/run`, { method: 'POST', json: {} })).status, 403);
  assert.equal((await stud('/notebooks', { method: 'POST', json: { title: 'x', lessonId: l1.body.id } })).status, 403);
  const teacherList = await stud('/notebooks?scope=teacher');
  assert.deepEqual(teacherList.body.map((n) => n.id), [nb.id]);
  assert.equal((await stud('/notebooks?scope=students')).status, 403);

  // A published notebook in a locked phase is listed as locked and cannot be opened
  const locked = await admin('/notebooks', { method: 'POST', json: { title: 'Later notebook', lessonId: l2.body.id, published: true } });
  const lockedSeen = await stud(`/notebooks/${locked.body.id}`);
  assert.equal(lockedSeen.status, 403);
  assert.ok(lockedSeen.body.lockReasons.length > 0);
  assert.equal((await stud(`/notebooks/${locked.body.id}/copy`, { method: 'POST' })).status, 403);
  assert.equal((await stud('/notebooks?scope=teacher')).body.find((n) => n.id === locked.body.id).locked, true);

  // The teacher's notebook gets an image; a copy gets its own file rows on the same bytes
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'dot.png');
  const img = await admin(`/notebooks/${nb.id}/files`, { method: 'POST', form });
  assert.equal(img.status, 201, JSON.stringify(img.body));
  const fake = new FormData();
  fake.append('file', new Blob(['<html>'], { type: 'image/png' }), 'evil.png');
  assert.equal((await admin(`/notebooks/${nb.id}/files`, { method: 'POST', form: fake })).status, 400);
  const withImage = (await admin(`/notebooks/${nb.id}`)).body;
  const cellsWithImage = [{ ...withImage.cells[0], source: `# Streams\n\n![dot](${img.body.url})` }, ...withImage.cells.slice(1)];
  assert.equal((await admin(`/notebooks/${nb.id}`, { method: 'PUT', json: { cells: cellsWithImage, baseRevision: withImage.revision } })).status, 200);
  assert.equal((await stud(img.body.url.replace('/api', ''))).status, 200);
  assert.equal((await anon(img.body.url.replace('/api', ''))).status, 401);
  const stored = fs.readdirSync(path.join(uploadsDir, 'notebook-files'))[0];
  assert.equal((await anon(`/uploads/notebook-files/${stored}`)).status, 404);

  // Copy: the student's own notebook, pointing back at the original
  const copy = await stud(`/notebooks/${nb.id}/copy`, { method: 'POST' });
  assert.equal(copy.status, 201, JSON.stringify(copy.body));
  assert.equal(copy.body.owner.id, studentId);
  assert.equal(copy.body.copied_from.id, nb.id);
  assert.equal(copy.body.copied_from.updated_since_copy, false);
  assert.equal(copy.body.lesson.id, l1.body.id);
  const copiedUrl = copy.body.cells[0].source.match(/\/api\/notebook-files\/\d+/)[0];
  assert.notEqual(copiedUrl, img.body.url);
  assert.equal((await stud(copiedUrl.replace('/api', ''))).status, 200);
  const lessonList = await stud(`/lessons/${l1.body.id}/notebooks`);
  assert.equal(lessonList.body[0].my_copy_id, copy.body.id);

  // Saving needs the current revision (two tabs cannot overwrite each other)
  const edited = [...copy.body.cells, { id: 'c3', kind: 'code', source: 'FAIL here' }, { id: 'c4', kind: 'code', source: 'after' }];
  const stale = await stud(`/notebooks/${copy.body.id}`, { method: 'PUT', json: { cells: edited, baseRevision: copy.body.revision - 1 } });
  assert.equal(stale.status, 409);
  const saved = await stud(`/notebooks/${copy.body.id}`, { method: 'PUT', json: { cells: edited, baseRevision: copy.body.revision } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.revision, copy.body.revision + 1);

  // Run to here: only code cells up to the chosen cell go to the runner
  runner.calls.length = 0;
  const run = await stud(`/notebooks/${copy.body.id}/run`, { method: 'POST', json: { upTo: 'c2', requestId: 'req-12345678' } });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const sent = runner.calls.find((c) => c.url === '/run');
  assert.deepEqual(sent.json.cells, ['int x = 1;', 'x + 1']);
  assert.equal(sent.json.requestId, `${studentId}:req-12345678`);
  assert.equal(run.body.outputs.c2.value, 'x + 1');
  assert.deepEqual([run.body.outputs.c1.executionCount, run.body.outputs.c2.executionCount], [1, 2]);

  // A failing cell stops the run; later cells are marked not run; outputs are stored
  const all = await stud(`/notebooks/${copy.body.id}/run`, { method: 'POST', json: {} });
  assert.equal(all.body.status, 'error');
  assert.equal(all.body.outputs.c3.status, 'error');
  assert.equal(all.body.outputs.c4.status, 'not_run');
  const reread = await stud(`/notebooks/${copy.body.id}`);
  assert.equal(reread.body.outputs.c3.error.message, 'nope');
  assert.equal(reread.body.outputs.c1.executionCount, 3);
  assert.equal((await stud(`/notebooks/${copy.body.id}/clear-outputs`, { method: 'POST', json: { cellIds: ['c3'] } })).status, 200);
  const cleared = await stud(`/notebooks/${copy.body.id}`);
  assert.equal(cleared.body.outputs.c3, undefined);
  assert.ok(cleared.body.outputs.c1);
  assert.equal(cleared.body.revision, reread.body.revision, 'clearing outputs does not bump the revision');

  // The teacher sees the copy, read-only, and the original lists it
  const copies = await admin(`/notebooks/${nb.id}/copies`);
  assert.deepEqual(copies.body.map((c) => c.id), [copy.body.id]);
  const asTeacher = await admin(`/notebooks/${copy.body.id}`);
  assert.equal(asTeacher.body.can_edit, false);
  assert.equal((await admin(`/notebooks/${copy.body.id}/run`, { method: 'POST', json: {} })).status, 403);
  assert.ok((await admin('/notebooks?scope=students&q=stu')).body.some((n) => n.id === copy.body.id));

  // The teacher changes the original: the copy says so
  const orig = (await admin(`/notebooks/${nb.id}`)).body;
  await admin(`/notebooks/${nb.id}`, { method: 'PUT', json: { cells: [...orig.cells, { kind: 'text', source: 'More' }], baseRevision: orig.revision } });
  assert.equal((await stud(`/notebooks/${copy.body.id}`)).body.copied_from.updated_since_copy, true);

  // Teacher live session keeps state through the runner session
  const s1 = await admin(`/notebooks/${nb.id}/session/run`, { method: 'POST', json: { cellId: 'c1', source: 'int y = 2;' } });
  assert.equal(s1.status, 200, JSON.stringify(s1.body));
  const s2 = await admin(`/notebooks/${nb.id}/session/run`, { method: 'POST', json: { cellId: 'c2', source: 'y' } });
  assert.equal(s2.body.output.executionCount, 2);
  const status = await admin('/notebooks/session');
  assert.equal(status.body.active, true);
  assert.equal(status.body.notebookId, nb.id);
  const adminId = (await admin('/me')).body.user.id;
  assert.deepEqual([...runner.sessions.values()].map((x) => x.owner), [`${adminId}:nb${nb.id}`]);
  // A live session on another notebook replaces the first one: variables never cross notebooks
  const other = await admin('/notebooks', { method: 'POST', json: { title: 'Other', cells: [{ id: 'o1', kind: 'code', source: '' }] } });
  const s3 = await admin(`/notebooks/${other.body.id}/session/run`, { method: 'POST', json: { cellId: 'o1', source: 'y' } });
  assert.equal(s3.body.output.executionCount, 1);
  assert.equal(s3.body.sessionRestarted, true);
  assert.deepEqual([...runner.sessions.values()].map((x) => x.owner), [`${adminId}:nb${other.body.id}`]);
  assert.equal((await admin('/notebooks/session', { method: 'DELETE' })).body.closed, true);
  assert.equal(runner.sessions.size, 0);
  assert.equal((await stud(`/notebooks/${copy.body.id}/session/run`, { method: 'POST', json: { cellId: 'c1', source: '1' } })).status, 403);

  // Import from Markdown with an image, and export back
  const md = '# Imported lesson\n\n![pic](img/dot.png)\n\n```java run\nSystem.out.println("hi");\n```\n';
  const imp = new FormData();
  imp.append('notebook', new Blob([md], { type: 'text/markdown' }), 'lesson.md');
  imp.append('files', new Blob([PNG], { type: 'image/png' }), 'img/dot.png');
  imp.append('lessonId', String(l1.body.id));
  const imported = await admin('/notebooks/import', { method: 'POST', form: imp });
  assert.equal(imported.status, 201, JSON.stringify(imported.body));
  assert.equal(imported.body.title, 'Imported lesson');
  assert.match(imported.body.cells[0].source, /!\[pic\]\(\/api\/notebook-files\/\d+\)/);
  const exported = await admin(`/notebooks/${imported.body.id}/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.body.toString('utf8'), /```java run\nSystem\.out\.println\("hi"\);\n```/);
  const replace = new FormData();
  replace.append('markdown', '# Imported lesson\n\n```java run\n1 + 1\n```\n');
  replace.append('baseRevision', '0');
  assert.equal((await admin(`/notebooks/${imported.body.id}/markdown`, { method: 'PUT', form: replace })).status, 409);
  const replace2 = new FormData();
  replace2.append('markdown', '# Imported lesson\n\n```java run\n1 + 1\n```\n');
  const replaced = await admin(`/notebooks/${imported.body.id}/markdown`, { method: 'PUT', form: replace2 });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.equal((await admin(`/notebooks/${imported.body.id}`)).body.cells.length, 2);
  const studentImport = new FormData();
  studentImport.append('markdown', '# Mine');
  studentImport.append('lessonId', String(l1.body.id));
  assert.equal((await stud('/notebooks/import', { method: 'POST', form: studentImport })).status, 403);

  // A playground of the student's own; deleting the original keeps the copy and its image
  const play = await stud('/notebooks', { method: 'POST', json: { title: 'Scratch' } });
  assert.equal(play.body.kind, 'playground');
  assert.equal((await admin(`/notebooks/${nb.id}`, { method: 'DELETE' })).status, 200);
  const orphan = await stud(`/notebooks/${copy.body.id}`);
  assert.equal(orphan.body.copied_from.removed, true);
  assert.equal((await stud(copiedUrl.replace('/api', ''))).status, 200);
  assert.equal((await stud(`/notebooks/${play.body.id}`, { method: 'DELETE' })).status, 200);
});
