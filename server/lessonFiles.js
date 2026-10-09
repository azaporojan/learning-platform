// ---------------------------------------------------------------------------
// Lesson materials: files a teacher attaches to a lesson.
//
//   GET    /lessons/:id/files          list (any logged-in user; names only)
//   POST   /lessons/:id/files          admin: multipart, field "files" (up to 10 per request)
//   PUT    /lesson-files/:id           admin: {name?, order?}
//   DELETE /lesson-files/:id           admin
//   GET    /lesson-files/:id/view      PDF / TXT / MD shown in the browser (inline)
//   GET    /lesson-files/:id/download  any type, as an attachment
//
// Reading a file follows the lesson's phase gates (like task briefs): a student who has not
// reached the phase gets 403. The bytes live in <uploads>/lesson-files/, which the public
// /api/uploads route refuses to serve.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const LESSON_FILE_TYPES = {
  '.pdf': { mime: 'application/pdf', view: 'pdf' },
  '.txt': { mime: 'text/plain; charset=utf-8', view: 'text' },
  '.md': { mime: 'text/markdown; charset=utf-8', view: 'markdown' },
  '.doc': { mime: 'application/msword' },
  '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.ppt': { mime: 'application/vnd.ms-powerpoint' },
  '.pptx': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
};
const MAX_FILES_PER_LESSON = 50;

// Light content checks so a renamed file cannot pose as another type
const looksLike = {
  '.pdf': (head) => head.subarray(0, 5).toString('latin1') === '%PDF-',
  '.docx': (head) => head[0] === 0x50 && head[1] === 0x4b, // ZIP container
  '.pptx': (head) => head[0] === 0x50 && head[1] === 0x4b,
  '.doc': (head) => head.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])), // OLE2
  '.ppt': (head) => head.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])),
  '.txt': (head) => !head.includes(0),
  '.md': (head) => !head.includes(0),
};

const extOf = (name) => path.extname(name || '').toLowerCase();
// multer/busboy decode multipart file names as latin1: recover UTF-8 names (e.g. "Curs 1 – intro.pdf")
const utf8Name = (name) => {
  const decoded = Buffer.from(String(name || ''), 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? String(name || '') : decoded;
};
const cleanName = (name) => path.basename(String(name || 'file')).replace(/[\u0000-\u001f\u007f/\\]/g, '').trim().slice(0, 255) || 'file';
// RFC 6266 / 5987 filename for Content-Disposition (non-ASCII names survive)
const disposition = (type, name) =>
  `${type}; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;

function serialize(row) {
  const type = LESSON_FILE_TYPES[row.ext] || {};
  return {
    id: row.id,
    lesson_id: row.lesson_id,
    name: row.original_name,
    ext: row.ext.replace('.', ''),
    size: row.size_bytes,
    viewable: Boolean(type.view),
    view_as: type.view || null,
    order_index: row.order_index,
    created_at: row.created_at,
  };
}

function registerLessonFileRoutes({ api, db, io, authenticateToken, requireAdmin, phaseLockReasons, uploadsDir }) {
  const dir = path.join(uploadsDir, 'lesson-files');
  fs.mkdirSync(dir, { recursive: true });
  const maxBytes = Math.max(1, parseInt(process.env.MAX_LESSON_FILE_MB || '50', 10)) * 1024 * 1024;

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, dir),
      filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${extOf(file.originalname)}`),
    }),
    limits: { fileSize: maxBytes, files: 10 },
    fileFilter: (req, file, cb) => {
      if (LESSON_FILE_TYPES[extOf(file.originalname)]) return cb(null, true);
      const err = new Error('Allowed file types: PDF, Word (.doc/.docx), PowerPoint (.ppt/.pptx), TXT, Markdown (.md).');
      err.status = 400;
      cb(err);
    },
  });
  const removeQuietly = (files) => (files || []).forEach((f) => fs.unlink(f.path || path.join(dir, f), (err) => {
    if (err && err.code !== 'ENOENT') console.error('[lesson-files] Could not remove a file:', err.message);
  }));

  async function lessonReasons(userId, lessonId) {
    const [rows] = await db.query('SELECT path_id FROM lessons WHERE id = ?', [lessonId]);
    if (rows.length === 0) return null;
    return phaseLockReasons(db, userId, rows[0].path_id);
  }

  // Loads the file and enforces the lesson's gates; sends the error response itself.
  async function readableFile(req, res) {
    const [rows] = await db.query('SELECT * FROM lesson_files WHERE id = ?', [req.params.id]);
    if (rows.length === 0) { res.status(404).json({ error: 'File not found' }); return null; }
    const reasons = (await lessonReasons(req.user.id, rows[0].lesson_id)) || [];
    if (reasons.length > 0) { res.status(403).json({ error: 'This lesson is locked', lockReasons: reasons }); return null; }
    const filePath = path.join(dir, path.basename(rows[0].stored_name));
    if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'File is missing on the server' }); return null; }
    return { row: rows[0], filePath };
  }

  api.get('/lessons/:id/files', authenticateToken, async (req, res) => {
    try {
      const [lessons] = await db.query('SELECT id FROM lessons WHERE id = ?', [req.params.id]);
      if (lessons.length === 0) return res.status(404).json({ error: 'Lesson not found' });
      const [rows] = await db.query('SELECT * FROM lesson_files WHERE lesson_id = ? ORDER BY order_index ASC, id ASC', [req.params.id]);
      res.json(rows.map(serialize));
    } catch (err) {
      console.error('[GET /lessons/:id/files] Error:', err);
      res.status(500).json({ error: 'Failed to list lesson files' });
    }
  });

  api.post('/lessons/:id/files', authenticateToken, requireAdmin, (req, res) => {
    upload.array('files', 10)(req, res, async (uploadErr) => {
      if (uploadErr) {
        removeQuietly(req.files);
        const tooBig = uploadErr.code === 'LIMIT_FILE_SIZE';
        return res.status(tooBig ? 413 : 400).json({ error: tooBig ? `A file is larger than ${maxBytes / 1024 / 1024} MB` : uploadErr.message });
      }
      const files = req.files || [];
      try {
        if (files.length === 0) return res.status(400).json({ error: 'Attach at least one file in the "files" field' });
        // Content must match the extension (no HTML or binaries renamed to .pdf / .txt)
        for (const f of files) {
          const fd = fs.openSync(f.path, 'r');
          const head = Buffer.alloc(4096);
          const n = fs.readSync(fd, head, 0, 4096, 0);
          fs.closeSync(fd);
          if (!looksLike[extOf(f.originalname)](head.subarray(0, n))) {
            removeQuietly(files);
            return res.status(400).json({ error: `"${cleanName(utf8Name(f.originalname))}" does not look like a real ${extOf(f.originalname)} file` });
          }
        }
        const created = await db.transaction(async (tx) => {
          const [lessons] = await tx.query('SELECT id FROM lessons WHERE id = ? FOR UPDATE', [req.params.id]);
          if (lessons.length === 0) { const e = new Error('Lesson not found'); e.status = 404; throw e; }
          const [count] = await tx.query('SELECT COUNT(*) AS n, COALESCE(MAX(order_index), 0) AS max FROM lesson_files WHERE lesson_id = ?', [req.params.id]);
          if (count[0].n + files.length > MAX_FILES_PER_LESSON) { const e = new Error(`A lesson can hold at most ${MAX_FILES_PER_LESSON} files`); e.status = 400; throw e; }
          const out = [];
          let order = count[0].max;
          for (const f of files) {
            order += 1;
            const [rows] = await tx.query(
              `INSERT INTO lesson_files (lesson_id, original_name, stored_name, ext, size_bytes, uploaded_by, order_index)
               VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
              [req.params.id, cleanName(utf8Name(f.originalname)), f.filename, extOf(f.originalname), f.size, req.user.id, order]
            );
            out.push(rows[0]);
          }
          return out;
        });
        io.emit('lesson:updated', { lessonId: Number(req.params.id) });
        res.status(201).json(created.map(serialize));
      } catch (err) {
        removeQuietly(files);
        if (err.status) return res.status(err.status).json({ error: err.message });
        console.error('[POST /lessons/:id/files] Error:', err);
        res.status(500).json({ error: 'Failed to upload files' });
      }
    });
  });

  api.put('/lesson-files/:id', authenticateToken, requireAdmin, async (req, res) => {
    const { name, order } = req.body || {};
    const sets = [];
    const params = [];
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim() || name.length > 255) return res.status(400).json({ error: 'name must be 1-255 characters' });
      sets.push('original_name = ?'); params.push(cleanName(name));
    }
    if (order !== undefined) {
      if (!Number.isInteger(order) || order < 1 || order > 100000) return res.status(400).json({ error: 'order must be an integer from 1 to 100000' });
      sets.push('order_index = ?'); params.push(order);
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    try {
      params.push(req.params.id);
      const [rows] = await db.query(`UPDATE lesson_files SET ${sets.join(', ')} WHERE id = ? RETURNING *`, params);
      if (rows.length === 0) return res.status(404).json({ error: 'File not found' });
      io.emit('lesson:updated', { lessonId: rows[0].lesson_id });
      res.json(serialize(rows[0]));
    } catch (err) {
      console.error('[PUT /lesson-files/:id] Error:', err);
      res.status(500).json({ error: 'Failed to update file' });
    }
  });

  api.delete('/lesson-files/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const [rows] = await db.query('DELETE FROM lesson_files WHERE id = ? RETURNING *', [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ error: 'File not found' });
      removeQuietly([rows[0].stored_name]);
      io.emit('lesson:updated', { lessonId: rows[0].lesson_id });
      res.json({ success: true });
    } catch (err) {
      console.error('[DELETE /lesson-files/:id] Error:', err);
      res.status(500).json({ error: 'Failed to delete file' });
    }
  });

  // Streams a stored file. A read error (file gone from the volume, disk error) must never throw
  // out of the stream: answer 404/500 if nothing was sent yet, otherwise just drop the connection.
  const sendFile = (filePath, res, label) => {
    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
      console.error(`[GET /lesson-files/:id/${label}] Stream error:`, err.code || err.message);
      if (res.headersSent) return res.destroy();
      res.removeHeader('Content-Disposition');
      res.removeHeader('Cache-Control');
      res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: err.code === 'ENOENT' ? 'File not found' : 'Failed to read file' });
    });
    res.on('close', () => stream.destroy()); // client went away: release the file handle
    // pipe(), not pipeline(): pipeline would destroy res on a read error before we could answer
    stream.pipe(res);
  };

  // In-browser viewing: PDF goes to the browser's PDF viewer; TXT/MD are sent as plain text (the
  // app renders Markdown itself, without raw HTML). Never served as HTML on this origin.
  api.get('/lesson-files/:id/view', authenticateToken, async (req, res) => {
    try {
      const file = await readableFile(req, res);
      if (!file) return;
      const type = LESSON_FILE_TYPES[file.row.ext];
      if (!type || !type.view) return res.status(415).json({ error: 'This file type can only be downloaded' });
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // Revalidated on every open: a re-locked lesson must not keep serving from the browser cache
      res.setHeader('Cache-Control', 'private, no-cache');
      res.setHeader('Content-Type', type.view === 'pdf' ? 'application/pdf' : 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', disposition('inline', file.row.original_name));
      if (type.view !== 'pdf') res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      sendFile(file.filePath, res, 'view');
    } catch (err) {
      console.error('[GET /lesson-files/:id/view] Error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to open file' });
    }
  });

  api.get('/lesson-files/:id/download', authenticateToken, async (req, res) => {
    try {
      const file = await readableFile(req, res);
      if (!file) return;
      const type = LESSON_FILE_TYPES[file.row.ext] || { mime: 'application/octet-stream' };
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', type.mime);
      res.setHeader('Content-Disposition', disposition('attachment', file.row.original_name));
      sendFile(file.filePath, res, 'download');
    } catch (err) {
      console.error('[GET /lesson-files/:id/download] Error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to download file' });
    }
  });

  // At startup: files on the volume that no row points at are MOVED to lesson-files/.orphaned/,
  // never deleted. Normal deletes remove their bytes themselves (filesOf); an orphan usually means
  // the database was restored from an older backup while the volume was kept, and those files
  // must stay recoverable (move them back and re-attach them, or delete the folder by hand).
  async function quarantineOrphanFiles() {
    try {
      const [rows] = await db.query('SELECT stored_name FROM lesson_files');
      const known = new Set(rows.map((r) => r.stored_name));
      const trash = path.join(dir, '.orphaned');
      let moved = 0;
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('.') || known.has(name)) continue;
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        // a file younger than a minute may belong to an upload still in flight
        if (!stat.isFile() || Date.now() - stat.mtimeMs < 60 * 1000) continue;
        fs.mkdirSync(trash, { recursive: true });
        fs.renameSync(full, path.join(trash, name));
        moved += 1;
      }
      if (moved > 0) console.warn(`[lesson-files] ${moved} file(s) without a database row were moved to ${trash} (not deleted)`);
    } catch (err) {
      console.error('[lesson-files] Orphan check failed:', err.message || err);
    }
  }

  // Call BEFORE deleting lessons/phases: returns a function that removes those files' bytes once
  // the rows are gone (the rows themselves go with ON DELETE CASCADE).
  async function filesOf({ lessonId, pathId }) {
    const [rows] = lessonId
      ? await db.query('SELECT stored_name FROM lesson_files WHERE lesson_id = ?', [lessonId])
      : await db.query('SELECT f.stored_name FROM lesson_files f INNER JOIN lessons l ON l.id = f.lesson_id WHERE l.path_id = ?', [pathId]);
    return () => removeQuietly(rows.map((r) => r.stored_name));
  }

  return { quarantineOrphanFiles, filesOf, serialize };
}

module.exports = { registerLessonFileRoutes, serializeLessonFile: serialize, LESSON_FILE_TYPES, utf8Name };
