// ---------------------------------------------------------------------------
// Notebooks: Java notebooks with code and text cells, run in the sandbox runner.
//
// Who sees what
//   - The owner reads, edits and runs their notebook.
//   - Admins (teachers) read every notebook; student notebooks are read-only for them.
//   - Students read a teacher's notebook only when it is published. One attached to a lesson
//     also follows the lesson's phase gates (locked → 403, unpublished phase → 404).
//   - A student works on a copy ("Copy" → their own notebook pointing back at the original).
//
//   GET    /notebooks?scope=mine|teacher|students&q=&kind=lesson|playground&lessonId=&ownerId=
//   POST   /notebooks                     {title, description?, lessonId?, published?, cells?}
//   GET    /notebooks/:id                 full notebook (+ can_edit, can_run)
//   PUT    /notebooks/:id                 owner: {title?, description?, cells?, baseRevision, lessonId?, published?}
//   DELETE /notebooks/:id                 owner or admin
//   POST   /notebooks/:id/copy            your own copy
//   GET    /notebooks/:id/copies          admin, owner of the original: the students' copies
//   POST   /notebooks/:id/run             owner: {cells: [{id, kind, source}], upTo, requestId}
//   GET    /notebooks/queue/:requestId    {position} while a run waits for a free sandbox
//   GET    /notebooks/session             admin: live session status (one per teacher, tied to a notebook)
//   POST   /notebooks/:id/session/run     admin owner: {cellId, source} in the live session
//   DELETE /notebooks/session             admin: end the live session
//   POST   /notebooks/:id/clear-outputs   owner: {cellIds?} (all when omitted)
//   POST   /notebooks/:id/files           owner: multipart "file" (image) → {id, url}
//   GET    /notebook-files/:id            the image, if you can read its notebook
//   POST   /notebooks/import              multipart: "notebook" (.md) or field "markdown", "files" (images),
//                                         title?, lessonId? (admin), published? (admin)
//   PUT    /notebooks/:id/markdown        owner: same multipart, replaces the cells (baseRevision? guards)
//   GET    /notebooks/:id/export          Markdown (text/markdown)
//   GET    /lessons/:id/notebooks         teacher notebooks of a lesson + the caller's copies of them
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { parseNotebookMarkdown, notebookToMarkdown } = require('./notebookMarkdown');
const { RunnerError } = require('./runnerClient');

const MAX_CELLS = 300;
const MAX_CELL_CHARS = 20000;
const MAX_NOTEBOOK_CHARS = 600000;
const MAX_FILES_PER_NOTEBOOK = 200;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const RUNS_PER_MINUTE = Math.max(1, parseInt(process.env.NOTEBOOK_RUNS_PER_MINUTE || '10', 10));
const RUNS_PER_DAY = Math.max(1, parseInt(process.env.NOTEBOOK_RUNS_PER_DAY || '200', 10));
// Students only (teachers are trusted with their own server): notebooks and image bytes per user
const MAX_NOTEBOOKS_PER_STUDENT = Math.max(1, parseInt(process.env.NOTEBOOK_MAX_PER_STUDENT || '100', 10));
const MAX_IMAGE_MB_PER_STUDENT = Math.max(1, parseInt(process.env.NOTEBOOK_IMAGE_MB_PER_STUDENT || '50', 10));
// Ids in paths are plain integers; anything else is a 404 rather than a database error
const validId = (v) => /^\d{1,9}$/.test(String(v));
const CELL_ID = /^[A-Za-z0-9_-]{1,40}$/;
const FILE_URL = /\/api\/notebook-files\/(\d{1,9})/g;

const IMAGE_TYPES = {
  '.png': { mime: 'image/png', ok: (h) => h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  '.jpg': { mime: 'image/jpeg', ok: (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff },
  '.jpeg': { mime: 'image/jpeg', ok: (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff },
  '.gif': { mime: 'image/gif', ok: (h) => h.subarray(0, 4).toString('latin1') === 'GIF8' },
  '.webp': { mime: 'image/webp', ok: (h) => h.subarray(0, 4).toString('latin1') === 'RIFF' && h.subarray(8, 12).toString('latin1') === 'WEBP' },
  '.svg': { mime: 'image/svg+xml', ok: (h) => !h.includes(0) && /<svg[\s>]/i.test(h.toString('utf8')) },
};

const extOf = (name) => path.extname(name || '').toLowerCase();
const newCellId = () => crypto.randomBytes(6).toString('base64url');
const httpError = (status, message, extra) => Object.assign(new Error(message), { status, extra });

// Validate + normalise the cells of a save. Returns cells [{id, kind, source}].
function normalizeCells(cells) {
  if (!Array.isArray(cells)) throw httpError(400, 'cells must be an array');
  if (cells.length > MAX_CELLS) throw httpError(400, `A notebook can hold at most ${MAX_CELLS} cells`);
  const seen = new Set();
  let total = 0;
  return cells.map((c, i) => {
    if (!c || typeof c !== 'object') throw httpError(400, `cells[${i}] must be an object`);
    if (c.kind !== 'code' && c.kind !== 'text') throw httpError(400, `cells[${i}].kind must be "code" or "text"`);
    if (typeof c.source !== 'string' || c.source.length > MAX_CELL_CHARS) throw httpError(400, `cells[${i}].source must be text of at most ${MAX_CELL_CHARS} characters`);
    let id = typeof c.id === 'string' && CELL_ID.test(c.id) ? c.id : newCellId();
    while (seen.has(id)) id = newCellId();
    seen.add(id);
    total += c.source.length;
    if (total > MAX_NOTEBOOK_CHARS) throw httpError(400, 'This notebook is too large');
    return { id, kind: c.kind, source: c.source };
  });
}

const contentSignature = (cells) => crypto.createHash('sha256').update(JSON.stringify(cells.map((c) => [c.kind, c.source]))).digest('hex');

// Outputs kept for cells that still exist ("$count" is the execution counter)
function pruneOutputs(outputs, cells) {
  const ids = new Set(cells.map((c) => c.id));
  const out = {};
  for (const [k, v] of Object.entries(outputs || {})) if (k === '$count' || ids.has(k)) out[k] = v;
  return out;
}

const trimText = (s, max) => (typeof s === 'string' && s.length > max ? `${s.slice(0, max)}\n… (output cut)` : s || '');
function storedOutput(r, executionCount) {
  return {
    status: r.status,
    stdout: trimText(r.stdout, 64 * 1024),
    stderr: trimText(r.stderr, 16 * 1024),
    value: typeof r.value === 'string' ? trimText(r.value, 16 * 1024) : null,
    error: r.error || null,
    truncated: Boolean(r.truncated),
    durationMs: r.durationMs || 0,
    executionCount: r.status === 'not_run' ? null : executionCount,
    ranAt: new Date().toISOString(),
  };
}

function registerNotebookRoutes({ api, db, authenticateToken, requireAdmin, phaseLockReasons, uploadsDir, runner }) {
  const dir = path.join(uploadsDir, 'notebook-files');
  fs.mkdirSync(dir, { recursive: true });
  const isAdmin = (req) => req.user && req.user.role === 'admin';

  // -------------------------------------------------------------------------
  // Loading and access
  // -------------------------------------------------------------------------
  const SUMMARY_SQL = `
    SELECT n.*, u.name AS owner_name, u.role AS owner_role,
           l.title AS lesson_title, l.path_id AS lesson_path_id, p.course_id AS lesson_course_id, c.name AS course_name,
           src.title AS source_title, src.version AS source_version, su.name AS source_owner_name,
           (SELECT COUNT(*) FROM notebooks cp WHERE cp.copied_from_id = n.id) AS copies_count
      FROM notebooks n
      JOIN users u ON u.id = n.owner_id
      LEFT JOIN lessons l ON l.id = n.lesson_id
      LEFT JOIN paths p ON p.id = l.path_id
      LEFT JOIN courses c ON c.id = p.course_id
      LEFT JOIN notebooks src ON src.id = n.copied_from_id
      LEFT JOIN users su ON su.id = src.owner_id`;

  async function loadRow(id) {
    if (!validId(id)) return null;
    const [rows] = await db.query(`${SUMMARY_SQL} WHERE n.id = ?`, [id]);
    return rows[0] || null;
  }

  // {read, edit, run, locked, reasons} for the caller; read=false with notFound when it must stay hidden
  async function accessOf(req, row) {
    const own = row.owner_id === req.user.id;
    if (own) return { read: true, edit: true, run: true };
    if (isAdmin(req)) return { read: true, edit: false, run: false };
    if (row.owner_role !== 'admin' || !row.published) return { read: false, notFound: true };
    if (row.lesson_id) {
      const reasons = row.lesson_path_id ? await phaseLockReasons(db, req.user.id, row.lesson_path_id) : [];
      if (reasons.includes('unpublished')) return { read: false, notFound: true };
      if (reasons.length) return { read: false, locked: true, reasons };
    }
    return { read: true, edit: false, run: false };
  }

  // Loads the notebook and applies access; sends the error response itself and returns null.
  async function load(req, res, need = 'read') {
    const row = await loadRow(req.params.id);
    if (!row) { res.status(404).json({ error: 'Notebook not found' }); return null; }
    const access = await accessOf(req, row);
    if (access.notFound) { res.status(404).json({ error: 'Notebook not found' }); return null; }
    if (access.locked) { res.status(403).json({ error: 'This lesson is locked', lockReasons: access.reasons }); return null; }
    if (!access[need]) {
      res.status(403).json({ error: need === 'run' ? 'Copy this notebook to run it.' : 'Only the owner can change this notebook. Copy it to make your own.' });
      return null;
    }
    return { row, access };
  }

  async function assertNotebookQuota(req) {
    if (isAdmin(req)) return;
    const [rows] = await db.query('SELECT COUNT(*) AS n FROM notebooks WHERE owner_id = ?', [req.user.id]);
    if (rows[0].n >= MAX_NOTEBOOKS_PER_STUDENT) {
      throw httpError(400, `You can keep at most ${MAX_NOTEBOOKS_PER_STUDENT} notebooks. Delete some you no longer need.`, { code: 'notebook_limit' });
    }
  }

  // Bytes are counted once per stored file, so copies of your own notebooks do not count twice
  async function assertImageQuota(req, addBytes) {
    if (isAdmin(req) || addBytes <= 0) return;
    const [rows] = await db.query(
      `SELECT COALESCE(SUM(size_bytes), 0)::bigint AS used
         FROM (SELECT DISTINCT stored_name, size_bytes FROM notebook_files WHERE uploaded_by = ?) f`,
      [req.user.id]
    );
    if (Number(rows[0].used) + addBytes > MAX_IMAGE_MB_PER_STUDENT * 1024 * 1024) {
      throw httpError(400, `Your notebook images can use at most ${MAX_IMAGE_MB_PER_STUDENT} MB. Delete some first.`, { code: 'image_limit' });
    }
  }

  function summary(row, extra = {}) {
    const cells = row.cells || [];
    return {
      id: row.id,
      title: row.title,
      description: row.description || '',
      owner: { id: row.owner_id, name: row.owner_name, is_teacher: row.owner_role === 'admin' },
      kind: row.lesson_id ? 'lesson' : 'playground',
      lesson: row.lesson_id ? {
        id: row.lesson_id, title: row.lesson_title, path_id: row.lesson_path_id, course_id: row.lesson_course_id, course_name: row.course_name,
      } : null,
      published: Boolean(row.published),
      copied_from: row.copied_at ? (row.copied_from_id ? {
        id: row.copied_from_id,
        title: row.source_title,
        owner_name: row.source_owner_name,
        updated_since_copy: (row.source_version || 0) > (row.copied_from_version || 0),
        removed: false,
      } : { id: null, title: null, owner_name: null, updated_since_copy: false, removed: true }) : null,
      cell_count: cells.length,
      code_cell_count: cells.filter((c) => c.kind === 'code').length,
      copies_count: row.owner_role === 'admin' ? row.copies_count : undefined,
      last_run_at: row.last_run_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      ...extra,
    };
  }

  const full = (row, access) => summary(row, {
    cells: row.cells || [],
    outputs: row.outputs || {},
    version: row.version,
    revision: row.revision,
    can_edit: Boolean(access.edit),
    can_run: Boolean(access.run),
    runner_configured: runner.configured,
  });

  async function validLessonId(lessonId) {
    if (lessonId === null || lessonId === undefined) return null;
    if (!Number.isInteger(lessonId) || lessonId < 1) throw httpError(400, 'lessonId must be a lesson id or null');
    const [rows] = await db.query('SELECT id FROM lessons WHERE id = ?', [lessonId]);
    if (rows.length === 0) throw httpError(400, 'No such lesson');
    return lessonId;
  }

  const fail = (res, err, label) => {
    if (err.status) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    if (err instanceof RunnerError) return res.status(err.status).json({ error: err.message, code: err.code });
    console.error(`[${label}] Error:`, err);
    res.status(500).json({ error: 'Something went wrong with the notebook' });
  };

  // -------------------------------------------------------------------------
  // Files (images in text cells)
  // -------------------------------------------------------------------------
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, dir),
      filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${extOf(file.originalname)}`),
    }),
    limits: { fileSize: MAX_IMAGE_BYTES, files: 50, fieldSize: MAX_NOTEBOOK_CHARS * 2 },
    fileFilter: (req, file, cb) => {
      if (file.fieldname === 'notebook') return cb(null, ['.md', '.markdown', '.txt'].includes(extOf(file.originalname)));
      if (IMAGE_TYPES[extOf(file.originalname)]) return cb(null, true);
      cb(httpError(400, 'Images must be PNG, JPEG, GIF, WebP or SVG'));
    },
  });
  const removeTemp = (files) => (files || []).forEach((f) => fs.unlink(f.path, () => {}));

  function checkImage(f) {
    const fd = fs.openSync(f.path, 'r');
    const head = Buffer.alloc(4096);
    const n = fs.readSync(fd, head, 0, 4096, 0);
    fs.closeSync(fd);
    const type = IMAGE_TYPES[extOf(f.originalname)];
    return type && type.ok(head.subarray(0, n));
  }

  // Bytes are shared between copies: delete them only when no row points at them any more.
  async function removeUnreferenced(storedNames) {
    for (const name of new Set(storedNames)) {
      const [rows] = await db.query('SELECT 1 FROM notebook_files WHERE stored_name = ? LIMIT 1', [name]);
      if (rows.length === 0) fs.unlink(path.join(dir, path.basename(name)), () => {});
    }
  }

  async function insertFile(tx, notebookId, f, userId) {
    const original = path.basename(String(f.originalname || 'image')).replace(/[\u0000-\u001f\u007f\\]/g, '').slice(0, 255) || 'image';
    const [rows] = await tx.query(
      `INSERT INTO notebook_files (notebook_id, original_name, stored_name, ext, size_bytes, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      [notebookId, original, f.filename, extOf(f.originalname), f.size, userId]
    );
    return rows[0].id;
  }

  // The file rows a notebook's cells point at are duplicated for another notebook (copy, import)
  // and the URLs in the cells rewritten to the new ids. Ids the caller may not read are dropped.
  async function cloneFiles(tx, cells, toNotebookId, canRead) {
    const ids = new Set();
    for (const c of cells) for (const m of c.source.matchAll(FILE_URL)) ids.add(Number(m[1]));
    if (ids.size === 0) return cells;
    const [rows] = await tx.query(`SELECT * FROM notebook_files WHERE id IN (${[...ids].map(() => '?').join(',')})`, [...ids]);
    const map = new Map();
    for (const f of rows) {
      if (!(await canRead(f.notebook_id))) continue;
      const [inserted] = await tx.query(
        `INSERT INTO notebook_files (notebook_id, original_name, stored_name, ext, size_bytes, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
        [toNotebookId, f.original_name, f.stored_name, f.ext, f.size_bytes, f.uploaded_by]
      );
      map.set(f.id, inserted[0].id);
    }
    return cells.map((c) => ({
      ...c,
      source: c.source.replace(FILE_URL, (whole, id) => (map.has(Number(id)) ? `/api/notebook-files/${map.get(Number(id))}` : whole)),
    }));
  }

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------
  api.get('/notebooks', authenticateToken, async (req, res) => {
    try {
      const scope = ['mine', 'teacher', 'students'].includes(req.query.scope) ? req.query.scope : 'mine';
      if (scope === 'students' && !isAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
      const where = [];
      const params = [];
      if (scope === 'mine') { where.push('n.owner_id = ?'); params.push(req.user.id); }
      if (scope === 'teacher') {
        where.push("u.role = 'admin'");
        if (!isAdmin(req)) where.push('n.published = TRUE');
      }
      if (scope === 'students') where.push("u.role <> 'admin'");
      if (req.query.kind === 'lesson') where.push('n.lesson_id IS NOT NULL');
      if (req.query.kind === 'playground') where.push('n.lesson_id IS NULL');
      if (/^\d{1,9}$/.test(String(req.query.lessonId || ''))) { where.push('n.lesson_id = ?'); params.push(Number(req.query.lessonId)); }
      if (scope === 'students' && /^\d{1,9}$/.test(String(req.query.ownerId || ''))) { where.push('n.owner_id = ?'); params.push(Number(req.query.ownerId)); }
      const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
      if (q) {
        where.push("(n.title ILIKE ? OR n.description ILIKE ? OR COALESCE(l.title, '') ILIKE ? OR COALESCE(c.name, '') ILIKE ? OR u.name ILIKE ?)");
        const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
        params.push(like, like, like, like, like);
      }
      const [rows] = await db.query(
        `${SUMMARY_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY COALESCE(n.last_run_at, n.updated_at) DESC, n.id DESC LIMIT 500`,
        params
      );
      // Students: teacher notebooks follow their lesson's gates (locked ones are listed as locked)
      const out = [];
      const gateCache = new Map();
      for (const row of rows) {
        let locked = false;
        if (!isAdmin(req) && row.owner_id !== req.user.id && row.lesson_id && row.lesson_path_id) {
          if (!gateCache.has(row.lesson_path_id)) gateCache.set(row.lesson_path_id, await phaseLockReasons(db, req.user.id, row.lesson_path_id));
          const reasons = gateCache.get(row.lesson_path_id);
          if (reasons.includes('unpublished')) continue;
          locked = reasons.length > 0;
        }
        out.push(summary(row, { locked }));
      }
      res.json(out);
    } catch (err) {
      fail(res, err, 'GET /notebooks');
    }
  });

  api.get('/lessons/:id/notebooks', authenticateToken, async (req, res) => {
    try {
      if (!validId(req.params.id)) return res.status(404).json({ error: 'Lesson not found' });
      const [lessons] = await db.query('SELECT id, path_id FROM lessons WHERE id = ?', [req.params.id]);
      if (lessons.length === 0) return res.status(404).json({ error: 'Lesson not found' });
      const reasons = isAdmin(req) ? [] : await phaseLockReasons(db, req.user.id, lessons[0].path_id);
      if (reasons.includes('unpublished')) return res.status(404).json({ error: 'Lesson not found' });
      const [rows] = await db.query(
        `${SUMMARY_SQL} WHERE n.lesson_id = ? AND (u.role = 'admin' ${isAdmin(req) ? '' : 'AND n.published = TRUE'})
         ORDER BY n.order_index ASC, n.id ASC`,
        [req.params.id]
      );
      const [copies] = await db.query(
        'SELECT id, copied_from_id, updated_at FROM notebooks WHERE owner_id = ? AND copied_from_id IS NOT NULL ORDER BY updated_at DESC',
        [req.user.id]
      );
      const copyOf = new Map();
      for (const c of copies) if (!copyOf.has(c.copied_from_id)) copyOf.set(c.copied_from_id, c.id);
      res.json(rows.map((r) => summary(r, { locked: reasons.length > 0, my_copy_id: copyOf.get(r.id) || null })));
    } catch (err) {
      fail(res, err, 'GET /lessons/:id/notebooks');
    }
  });

  // -------------------------------------------------------------------------
  // Create / read / update / delete
  // -------------------------------------------------------------------------
  api.post('/notebooks', authenticateToken, async (req, res) => {
    try {
      const b = req.body || {};
      const title = typeof b.title === 'string' ? b.title.trim() : '';
      if (!title || title.length > 255) throw httpError(400, 'title is required (max 255 characters)');
      if (b.description !== undefined && (typeof b.description !== 'string' || b.description.length > 4000)) throw httpError(400, 'description must be text (max 4000 characters)');
      if (!isAdmin(req) && (b.lessonId !== undefined && b.lessonId !== null)) throw httpError(403, 'Only teachers attach notebooks to lessons. Copy a lesson notebook instead.');
      await assertNotebookQuota(req);
      const lessonId = await validLessonId(b.lessonId);
      const cells = b.cells === undefined
        ? [{ id: newCellId(), kind: 'text', source: `# ${title}` }, { id: newCellId(), kind: 'code', source: '' }]
        : normalizeCells(b.cells);
      const [rows] = await db.query(
        `INSERT INTO notebooks (owner_id, title, description, lesson_id, published, cells)
         VALUES (?, ?, ?, ?, ?, ?::jsonb) RETURNING id`,
        [req.user.id, title, b.description || '', lessonId, isAdmin(req) && b.published === true, JSON.stringify(cells)]
      );
      const row = await loadRow(rows[0].id);
      res.status(201).json(full(row, { read: true, edit: true, run: true }));
    } catch (err) {
      fail(res, err, 'POST /notebooks');
    }
  });

  api.get('/notebooks/session', authenticateToken, requireAdmin, async (req, res) => {
    try {
      if (!runner.configured) return res.json({ active: false, configured: false });
      const [mine] = await teacherSessions(req.user.id);
      res.json(mine ? { active: true, configured: true, notebookId: Number(String(mine.owner).split(':nb')[1]), ...mine } : { active: false, configured: true });
    } catch (err) {
      fail(res, err, 'GET /notebooks/session');
    }
  });

  api.delete('/notebooks/session', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const mine = await teacherSessions(req.user.id);
      for (const s of mine) await runner.closeSession(s.id, s.owner);
      res.json({ closed: mine.length > 0 });
    } catch (err) {
      fail(res, err, 'DELETE /notebooks/session');
    }
  });

  api.get('/notebooks/queue/:requestId', authenticateToken, async (req, res) => {
    try {
      const id = String(req.params.requestId || '');
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return res.status(400).json({ error: 'Invalid request id' });
      const r = await runner.queue(`${req.user.id}:${id}`);
      res.json({ position: r.position || 0 });
    } catch (err) {
      if (err instanceof RunnerError) return res.json({ position: 0 });
      fail(res, err, 'GET /notebooks/queue');
    }
  });

  api.get('/notebooks/:id', authenticateToken, async (req, res) => {
    try {
      const r = await load(req, res);
      if (!r) return;
      res.json(full(r.row, r.access));
    } catch (err) {
      fail(res, err, 'GET /notebooks/:id');
    }
  });

  api.put('/notebooks/:id', authenticateToken, async (req, res) => {
    try {
      const r = await load(req, res, 'edit');
      if (!r) return;
      const b = req.body || {};
      const sets = [];
      const params = [];
      if (b.title !== undefined) {
        if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 255) throw httpError(400, 'title must be 1-255 characters');
        sets.push('title = ?'); params.push(b.title.trim());
      }
      if (b.description !== undefined) {
        if (typeof b.description !== 'string' || b.description.length > 4000) throw httpError(400, 'description must be text (max 4000 characters)');
        sets.push('description = ?'); params.push(b.description);
      }
      if (b.lessonId !== undefined) {
        if (!isAdmin(req)) throw httpError(403, 'Only teachers attach notebooks to lessons');
        sets.push('lesson_id = ?'); params.push(await validLessonId(b.lessonId));
      }
      if (b.published !== undefined) {
        if (!isAdmin(req)) throw httpError(403, 'Only teachers publish notebooks');
        if (typeof b.published !== 'boolean') throw httpError(400, 'published must be true or false');
        sets.push('published = ?'); params.push(b.published);
      }
      let cells = null;
      if (b.cells !== undefined) {
        if (!Number.isInteger(b.baseRevision)) throw httpError(400, 'baseRevision is required when saving cells');
        cells = normalizeCells(b.cells);
      }
      if (sets.length === 0 && !cells) throw httpError(400, 'Nothing to update');
      const updated = await db.transaction(async (tx) => {
        const [locked] = await tx.query('SELECT cells, outputs, revision, version FROM notebooks WHERE id = ? FOR UPDATE', [r.row.id]);
        const cur = locked[0];
        if (cells) {
          if (b.baseRevision !== cur.revision) {
            throw httpError(409, 'This notebook was changed somewhere else (another tab?). Reload to get the latest version.', { revision: cur.revision });
          }
          const changed = contentSignature(cells) !== contentSignature(cur.cells || []);
          sets.push('cells = ?::jsonb'); params.push(JSON.stringify(cells));
          sets.push('outputs = ?::jsonb'); params.push(JSON.stringify(pruneOutputs(cur.outputs, cells)));
          if (changed) sets.push('version = version + 1');
        }
        sets.push('revision = revision + 1');
        const [rows] = await tx.query(`UPDATE notebooks SET ${sets.join(', ')} WHERE id = ? RETURNING revision, version, updated_at`, [...params, r.row.id]);
        return rows[0];
      });
      res.json(updated);
    } catch (err) {
      fail(res, err, 'PUT /notebooks/:id');
    }
  });

  api.delete('/notebooks/:id', authenticateToken, async (req, res) => {
    try {
      const row = await loadRow(req.params.id);
      if (!row) return res.status(404).json({ error: 'Notebook not found' });
      if (row.owner_id !== req.user.id && !isAdmin(req)) return res.status(403).json({ error: 'Only the owner can delete this notebook' });
      const [files] = await db.query('SELECT stored_name FROM notebook_files WHERE notebook_id = ?', [row.id]);
      await db.query('DELETE FROM notebooks WHERE id = ?', [row.id]);
      await removeUnreferenced(files.map((f) => f.stored_name));
      closeNotebookSession(row.owner_id, row.id); // a live session would otherwise idle out
      res.json({ success: true });
    } catch (err) {
      fail(res, err, 'DELETE /notebooks/:id');
    }
  });

  // -------------------------------------------------------------------------
  // Copy
  // -------------------------------------------------------------------------
  async function canReadNotebook(req, notebookId) {
    const row = await loadRow(notebookId);
    return Boolean(row && (await accessOf(req, row)).read);
  }

  api.post('/notebooks/:id/copy', authenticateToken, async (req, res) => {
    try {
      const r = await load(req, res);
      if (!r) return;
      const src = r.row;
      const own = src.owner_id === req.user.id;
      await assertNotebookQuota(req);
      const id = await db.transaction(async (tx) => {
        const title = (own ? `Copy of ${src.title}` : src.title).slice(0, 255);
        const [rows] = await tx.query(
          `INSERT INTO notebooks (owner_id, title, description, lesson_id, published, copied_from_id, copied_from_version, copied_at, cells)
           VALUES (?, ?, ?, ?, FALSE, ?, ?, NOW(), '[]'::jsonb) RETURNING id`,
          [req.user.id, title, src.description || '', src.lesson_id, src.id, src.version]
        );
        const newId = rows[0].id;
        const cells = await cloneFiles(tx, src.cells || [], newId, async (nid) => nid === src.id || canReadNotebook(req, nid));
        await tx.query('UPDATE notebooks SET cells = ?::jsonb WHERE id = ?', [JSON.stringify(cells), newId]);
        return newId;
      });
      const row = await loadRow(id);
      res.status(201).json(full(row, { read: true, edit: true, run: true }));
    } catch (err) {
      fail(res, err, 'POST /notebooks/:id/copy');
    }
  });

  api.get('/notebooks/:id/copies', authenticateToken, requireAdmin, async (req, res) => {
    try {
      if (!validId(req.params.id)) return res.status(404).json({ error: 'Notebook not found' });
      const [rows] = await db.query(`${SUMMARY_SQL} WHERE n.copied_from_id = ? ORDER BY COALESCE(n.last_run_at, n.updated_at) DESC`, [req.params.id]);
      res.json(rows.map((r) => summary(r)));
    } catch (err) {
      fail(res, err, 'GET /notebooks/:id/copies');
    }
  });

  // -------------------------------------------------------------------------
  // Running
  // -------------------------------------------------------------------------
  const inFlight = new Set();
  const recent = new Map(); // userId -> [timestamps] in the last minute

  // The in-memory checks and the slot are taken before the first await, so two requests from one
  // user can never both pass; a refusal after that gives the slot back.
  async function admitRun(userId) {
    if (inFlight.has(userId)) throw httpError(429, 'A run is already in progress. Wait for it to finish.', { code: 'in_flight' });
    const now = Date.now();
    const list = (recent.get(userId) || []).filter((t) => now - t < 60000);
    if (list.length >= RUNS_PER_MINUTE) throw httpError(429, `At most ${RUNS_PER_MINUTE} runs a minute. Wait a few seconds and run again.`, { code: 'rate_limited' });
    inFlight.add(userId);
    list.push(now);
    recent.set(userId, list);
    try {
      const [day] = await db.query("SELECT COUNT(*) AS n FROM notebook_runs WHERE user_id = ? AND created_at > NOW() - INTERVAL '1 day'", [userId]);
      if (day[0].n >= RUNS_PER_DAY) throw httpError(429, `You have reached today's limit of ${RUNS_PER_DAY} runs.`, { code: 'daily_limit' });
    } catch (err) {
      inFlight.delete(userId);
      throw err;
    }
  }

  async function saveOutputs(notebookId, newOutputs, count) {
    // Merged inside the database so a concurrent autosave of the cells is never overwritten
    await db.query(
      `UPDATE notebooks SET outputs = (outputs || ?::jsonb) || jsonb_build_object('$count', ?::int), last_run_at = NOW() WHERE id = ?`,
      [JSON.stringify(newOutputs), count, notebookId]
    );
  }

  async function nextCount(notebookId, by) {
    const [rows] = await db.query(
      `UPDATE notebooks SET outputs = jsonb_set(outputs, '{$count}', to_jsonb(COALESCE((outputs->>'$count')::int, 0) + ?)) WHERE id = ?
       RETURNING (outputs->>'$count')::int AS count`,
      [by, notebookId]
    );
    return rows[0] ? rows[0].count : by;
  }

  api.post('/notebooks/:id/run', authenticateToken, async (req, res) => {
    let admitted = false;
    try {
      const r = await load(req, res, 'run');
      if (!r) return;
      const b = req.body || {};
      const cells = normalizeCells(b.cells === undefined ? r.row.cells : b.cells);
      const upTo = b.upTo === undefined || b.upTo === null ? cells.length - 1 : cells.findIndex((c) => c.id === b.upTo);
      if (upTo < 0) throw httpError(400, 'upTo must be the id of a cell in the notebook');
      const code = cells.slice(0, upTo + 1).filter((c) => c.kind === 'code');
      if (code.length === 0) return res.json({ status: 'ok', outputs: {}, durationMs: 0 });
      const requestId = typeof b.requestId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(b.requestId) ? b.requestId : crypto.randomUUID();
      await admitRun(req.user.id);
      admitted = true;
      const started = Date.now();
      let result;
      try {
        result = await runner.run(code.map((c) => c.source), `${req.user.id}:${requestId}`);
      } finally {
        db.query('INSERT INTO notebook_runs (user_id, notebook_id, mode, cell_count, status, duration_ms) VALUES (?, ?, ?, ?, ?, ?)',
          [req.user.id, r.row.id, 'run', code.length, result ? result.status : 'failed', Date.now() - started]).catch(() => {});
      }
      const ran = result.cells.filter((c) => c.status !== 'not_run').length;
      const last = await nextCount(r.row.id, ran);
      let n = last - ran;
      const outputs = {};
      result.cells.forEach((c, i) => {
        if (c.status !== 'not_run') n += 1;
        outputs[code[i].id] = storedOutput(c, n);
      });
      await saveOutputs(r.row.id, outputs, last);
      res.json({ status: result.status, outputs, durationMs: result.durationMs, queuedMs: result.queuedMs, warm: result.warm, executionCount: last });
    } catch (err) {
      fail(res, err, 'POST /notebooks/:id/run');
    } finally {
      if (admitted) inFlight.delete(req.user.id);
    }
  });

  // Teacher live session: a JShell that keeps state between cells. It belongs to one teacher AND
  // one notebook (owner "<user>:nb<notebook>"), so variables never leak from one notebook into
  // another; opening it on a notebook ends that teacher's session on any other notebook.
  const sessionOwner = (userId, notebookId) => `${userId}:nb${notebookId}`;
  function closeNotebookSession(userId, notebookId) {
    const owner = sessionOwner(userId, notebookId);
    runner.stats()
      .then((s) => Promise.all((s.sessions || []).filter((x) => x.owner === owner).map((x) => runner.closeSession(x.id, owner))))
      .catch(() => {}); // runner not configured or down: the session idles out on its own
  }

  async function teacherSessions(userId) {
    const list = await runner.stats().then((s) => s.sessions || []);
    return list.filter((s) => String(s.owner).startsWith(`${userId}:nb`));
  }

  api.post('/notebooks/:id/session/run', authenticateToken, requireAdmin, async (req, res) => {
    let admitted = false;
    try {
      const r = await load(req, res, 'run');
      if (!r) return;
      const { cellId, source } = req.body || {};
      if (typeof cellId !== 'string' || !CELL_ID.test(cellId)) throw httpError(400, 'cellId is required');
      if (typeof source !== 'string' || source.length > MAX_CELL_CHARS) throw httpError(400, 'source must be text');
      await admitRun(req.user.id);
      admitted = true;
      const owner = sessionOwner(req.user.id, r.row.id);
      for (const s of await teacherSessions(req.user.id)) {
        if (s.owner !== owner) await runner.closeSession(s.id, s.owner).catch(() => {});
      }
      let session = await runner.openSession(owner);
      let restarted = false;
      let result;
      try {
        result = await runner.runInSession(session.id, owner, source);
      } catch (err) {
        if (!(err instanceof RunnerError) || err.code !== 'no_session') throw err;
        session = await runner.openSession(owner); // idle-closed or runner restarted: start again
        restarted = true;
        result = await runner.runInSession(session.id, owner, source);
      }
      db.query('INSERT INTO notebook_runs (user_id, notebook_id, mode, cell_count, status, duration_ms) VALUES (?, ?, ?, ?, ?, ?)',
        [req.user.id, r.row.id, 'session', 1, result.status, result.durationMs || 0]).catch(() => {});
      // The notebook's own counter, shared with batch runs (the session's restarts at 1)
      const count = await nextCount(r.row.id, 1);
      const output = storedOutput(result, count);
      await saveOutputs(r.row.id, { [cellId]: output }, count);
      res.json({ output, sessionEnded: Boolean(result.sessionEnded), sessionRestarted: restarted || session.executionCount === 0 });
    } catch (err) {
      fail(res, err, 'POST /notebooks/:id/session/run');
    } finally {
      if (admitted) inFlight.delete(req.user.id);
    }
  });

  // Clearing outputs never touches the cells, so it does not bump the revision
  api.post('/notebooks/:id/clear-outputs', authenticateToken, async (req, res) => {
    try {
      const r = await load(req, res, 'edit');
      if (!r) return;
      const ids = (req.body || {}).cellIds;
      if (ids !== undefined && (!Array.isArray(ids) || ids.length > MAX_CELLS || ids.some((x) => typeof x !== 'string' || !CELL_ID.test(x)))) {
        throw httpError(400, 'cellIds must be a list of cell ids');
      }
      if (ids === undefined) await db.query(`UPDATE notebooks SET outputs = '{}'::jsonb WHERE id = ?`, [r.row.id]);
      else await db.query('UPDATE notebooks SET outputs = outputs - ?::text[] WHERE id = ?', [ids, r.row.id]);
      res.json({ success: true });
    } catch (err) {
      fail(res, err, 'POST /notebooks/:id/clear-outputs');
    }
  });

  // -------------------------------------------------------------------------
  // Images
  // -------------------------------------------------------------------------
  api.post('/notebooks/:id/files', authenticateToken, async (req, res) => {
    try {
      const r = await load(req, res, 'edit');
      if (!r) return;
      upload.single('file')(req, res, async (uploadErr) => {
        const files = req.file ? [req.file] : [];
        try {
          if (uploadErr) {
            const tooBig = uploadErr.code === 'LIMIT_FILE_SIZE';
            throw httpError(tooBig ? 413 : 400, tooBig ? 'Images can be at most 5 MB' : uploadErr.message);
          }
          if (!req.file) throw httpError(400, 'Attach an image in the "file" field');
          if (!checkImage(req.file)) throw httpError(400, 'This file does not look like the image type its name says');
          const [count] = await db.query('SELECT COUNT(*) AS n FROM notebook_files WHERE notebook_id = ?', [r.row.id]);
          if (count[0].n >= MAX_FILES_PER_NOTEBOOK) throw httpError(400, `A notebook can hold at most ${MAX_FILES_PER_NOTEBOOK} images`);
          await assertImageQuota(req, req.file.size);
          const id = await insertFile(db, r.row.id, req.file, req.user.id);
          res.status(201).json({ id, url: `/api/notebook-files/${id}` });
        } catch (err) {
          removeTemp(files);
          fail(res, err, 'POST /notebooks/:id/files');
        }
      });
    } catch (err) {
      fail(res, err, 'POST /notebooks/:id/files');
    }
  });

  api.get('/notebook-files/:id', authenticateToken, async (req, res) => {
    try {
      if (!validId(req.params.id)) return res.status(404).json({ error: 'File not found' });
      const [rows] = await db.query('SELECT * FROM notebook_files WHERE id = ?', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'File not found' });
      const row = await loadRow(rows[0].notebook_id);
      if (!row || !(await accessOf(req, row)).read) return res.status(404).json({ error: 'File not found' });
      const type = IMAGE_TYPES[rows[0].ext];
      const filePath = path.join(dir, path.basename(rows[0].stored_name));
      if (!type || !fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
      res.setHeader('Content-Type', type.mime);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      res.setHeader('Cache-Control', 'private, max-age=3600');
      const stream = fs.createReadStream(filePath);
      stream.on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); });
      stream.pipe(res);
    } catch (err) {
      fail(res, err, 'GET /notebook-files/:id');
    }
  });

  // -------------------------------------------------------------------------
  // Markdown import / export
  // -------------------------------------------------------------------------
  function readMarkdown(req) {
    const file = (req.files || []).find((f) => f.fieldname === 'notebook');
    if (file) return fs.readFileSync(file.path, 'utf8');
    if (typeof req.body.markdown === 'string') return req.body.markdown;
    throw httpError(400, 'Send the notebook as a "notebook" .md file or a "markdown" field');
  }

  // Relative image paths in the Markdown (img/x.png) are matched to the uploaded "files" by
  // their name as sent, then by basename; matches become notebook files.
  async function attachImages(tx, cells, notebookId, req) {
    const images = (req.files || []).filter((f) => f.fieldname === 'files');
    if (images.length === 0) return cells;
    for (const f of images) if (!checkImage(f)) throw httpError(400, `"${f.originalname}" does not look like the image type its name says`);
    await assertImageQuota(req, images.reduce((n, f) => n + f.size, 0));
    const byName = new Map();
    for (const f of images) {
      const id = await insertFile(tx, notebookId, f, req.user.id);
      byName.set(f.originalname, id);
      byName.set(path.basename(f.originalname), id);
    }
    return cells.map((c) => (c.kind !== 'text' ? c : {
      ...c,
      source: c.source.replace(/(!\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g, (whole, open, target, close) => {
        const clean = target.replace(/^\.\//, '');
        const id = byName.get(clean) || byName.get(path.basename(clean));
        return id ? `${open}/api/notebook-files/${id}${close}` : whole;
      }),
    }));
  }

  const importUpload = upload.fields([{ name: 'notebook', maxCount: 1 }, { name: 'files', maxCount: 50 }]);
  const withImport = (handler) => (req, res) => importUpload(req, res, async (uploadErr) => {
    const files = Object.values(req.files || {}).flat();
    req.files = files;
    try {
      if (uploadErr) {
        const tooBig = uploadErr.code === 'LIMIT_FILE_SIZE';
        throw httpError(tooBig ? 413 : 400, tooBig ? 'Images can be at most 5 MB' : uploadErr.message);
      }
      await handler(req, res);
      // The notebook file itself is never kept; images are kept only when the import succeeded
      removeTemp(res.statusCode >= 400 ? files : files.filter((f) => f.fieldname === 'notebook'));
    } catch (err) {
      removeTemp(files);
      fail(res, err, `${req.method} ${req.path}`);
    }
  });

  const parseFormBool = (v) => v === true || v === 'true' || v === '1';
  const parseFormInt = (v) => (v === undefined || v === '' || v === null || v === 'null' ? null : Number(v));

  api.post('/notebooks/import', authenticateToken, withImport(async (req, res) => {
    const { title: parsedTitle, cells: parsed } = parseNotebookMarkdown(readMarkdown(req));
    const cells = normalizeCells(parsed);
    const title = (typeof req.body.title === 'string' && req.body.title.trim()) || parsedTitle || 'Imported notebook';
    const lessonId = parseFormInt(req.body.lessonId);
    if (lessonId !== null && !isAdmin(req)) throw httpError(403, 'Only teachers attach notebooks to lessons');
    await validLessonId(lessonId);
    const published = isAdmin(req) && parseFormBool(req.body.published);
    await assertNotebookQuota(req);
    const id = await db.transaction(async (tx) => {
      const [rows] = await tx.query(
        `INSERT INTO notebooks (owner_id, title, description, lesson_id, published, cells) VALUES (?, ?, ?, ?, ?, '[]'::jsonb) RETURNING id`,
        [req.user.id, title.slice(0, 255), typeof req.body.description === 'string' ? req.body.description.slice(0, 4000) : '', lessonId, published]
      );
      let withFiles = await attachImages(tx, cells, rows[0].id, req);
      withFiles = await cloneFiles(tx, withFiles, rows[0].id, (nid) => canReadNotebook(req, nid));
      await tx.query('UPDATE notebooks SET cells = ?::jsonb WHERE id = ?', [JSON.stringify(withFiles), rows[0].id]);
      return rows[0].id;
    });
    const row = await loadRow(id);
    res.status(201).json(full(row, { read: true, edit: true, run: true }));
  }));

  api.put('/notebooks/:id/markdown', authenticateToken, withImport(async (req, res) => {
    const r = await load(req, res, 'edit');
    if (!r) return;
    const { cells: parsed } = parseNotebookMarkdown(readMarkdown(req));
    const cells = normalizeCells(parsed);
    const baseRevision = parseFormInt(req.body.baseRevision);
    const updated = await db.transaction(async (tx) => {
      const [locked] = await tx.query('SELECT revision, cells FROM notebooks WHERE id = ? FOR UPDATE', [r.row.id]);
      if (baseRevision !== null && baseRevision !== locked[0].revision) {
        throw httpError(409, 'The notebook changed since you read it. Fetch it again before replacing it.', { revision: locked[0].revision });
      }
      let withFiles = await attachImages(tx, cells, r.row.id, req);
      withFiles = await cloneFiles(tx, withFiles, r.row.id, (nid) => nid === r.row.id || canReadNotebook(req, nid));
      // Files that pointed into this notebook keep their ids, so rows already used stay valid
      const changed = contentSignature(withFiles) !== contentSignature(locked[0].cells || []);
      const sets = ['cells = ?::jsonb', "outputs = '{}'::jsonb", 'revision = revision + 1'];
      if (changed) sets.push('version = version + 1');
      const params = [JSON.stringify(withFiles)];
      if (typeof req.body.title === 'string' && req.body.title.trim()) { sets.push('title = ?'); params.push(req.body.title.trim().slice(0, 255)); }
      const [rows] = await tx.query(`UPDATE notebooks SET ${sets.join(', ')} WHERE id = ? RETURNING revision, version, updated_at`, [...params, r.row.id]);
      return rows[0];
    });
    res.json(updated);
  }));

  api.get('/notebooks/:id/export', authenticateToken, async (req, res) => {
    try {
      const r = await load(req, res);
      if (!r) return;
      const name = `${r.row.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 80) || 'notebook'}.md`;
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      res.send(notebookToMarkdown(r.row.cells || []));
    } catch (err) {
      fail(res, err, 'GET /notebooks/:id/export');
    }
  });
}

module.exports = { registerNotebookRoutes, normalizeCells, pruneOutputs, contentSignature };
