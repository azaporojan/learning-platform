// ---------------------------------------------------------------------------
// Study sets: quizzes and flashcard decks attached to a lesson (prep material — they never gate
// the road and grant no stars). Admins and API keys manage them; students practise.
//
//   GET    /lessons/:id/study-sets      sets of a lesson (full items; quiz answers only for admins)
//   POST   /study-sets                  admin: {lessonId, kind, title, description?, items, order?}
//   GET    /study-sets/:id              one set (quiz answers only for admins)
//   PUT    /study-sets/:id              admin: {title?, description?, items?, order?} (items replaces the list)
//   DELETE /study-sets/:id              admin
//   POST   /study-sets/:id/attempts     quiz: {answers: [[index..] | index | null, …]} → graded result
//                                       flashcards: {known} → recorded result
//
// Items (Markdown is allowed in every text field; the UI renders it without raw HTML):
//   quiz        {question, options: [2..10 strings], correct: index | [index..], explanation?}
//               one correct index = single choice, several = "select all that apply"
//   flashcards  {front, back}
// ---------------------------------------------------------------------------

const KINDS = new Set(['quiz', 'flashcards']);
const MAX_ITEMS = 300;
const MAX_TEXT = 4000;
const MAX_OPTION = 1000;
const MAX_OPTIONS = 10;
const MAX_SETS_PER_LESSON = 20;

const isOptionalString = (v) => v === undefined || v === null || typeof v === 'string';
const text = (v) => (typeof v === 'string' ? v.trim() : '');

// Validate + normalise the items of a set. Returns { errors, items }.
function normalizeItems(kind, items, prefix = 'items') {
  const errors = [];
  const out = [];
  if (!Array.isArray(items)) return { errors: [`${prefix} must be an array`], items: out };
  if (items.length > MAX_ITEMS) return { errors: [`${prefix}: at most ${MAX_ITEMS} items`], items: out };
  items.forEach((item, i) => {
    const p = `${prefix}[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`${p} must be an object`); return; }
    if (kind === 'quiz') {
      const question = text(item.question);
      if (!question || question.length > MAX_TEXT) errors.push(`${p}.question is required (max ${MAX_TEXT} chars)`);
      if (!isOptionalString(item.explanation) || (item.explanation || '').length > MAX_TEXT) errors.push(`${p}.explanation must be a string (max ${MAX_TEXT} chars)`);
      const options = Array.isArray(item.options) ? item.options : null;
      if (!options || options.length < 2 || options.length > MAX_OPTIONS) {
        errors.push(`${p}.options must be an array of 2-${MAX_OPTIONS} answers`);
        return;
      }
      options.forEach((o, j) => {
        if (typeof o !== 'string' || !o.trim() || o.length > MAX_OPTION) errors.push(`${p}.options[${j}] must be a non-empty string (max ${MAX_OPTION} chars)`);
      });
      const correct = Array.isArray(item.correct) ? item.correct : [item.correct];
      const valid = correct.length > 0 && correct.every((c) => Number.isInteger(c) && c >= 0 && c < options.length);
      if (!valid) errors.push(`${p}.correct must be an index (or array of indexes) into options, 0-based`);
      out.push({
        question,
        options: options.map((o) => (typeof o === 'string' ? o.trim() : o)),
        correct: valid ? [...new Set(correct)].sort((a, b) => a - b) : [],
        explanation: text(item.explanation),
      });
    } else {
      const front = text(item.front);
      const back = text(item.back);
      if (!front || front.length > MAX_TEXT) errors.push(`${p}.front is required (max ${MAX_TEXT} chars)`);
      if (!back || back.length > MAX_TEXT) errors.push(`${p}.back is required (max ${MAX_TEXT} chars)`);
      out.push({ front, back });
    }
  });
  return { errors, items: out };
}

// Validate a whole set document (POST body, or one entry of the path import).
// partial = PUT: every field is optional, kind cannot change.
function validateStudySet(body, { prefix = '', partial = false, kind: fixedKind } = {}) {
  const b = body || {};
  const errors = [];
  const at = (f) => (prefix ? `${prefix}.${f}` : f);
  const kind = fixedKind || b.kind;
  if (!fixedKind && !KINDS.has(kind)) errors.push(`${at('kind')} must be "quiz" or "flashcards"`);
  if (!partial || b.title !== undefined) {
    if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 255) errors.push(`${at('title')} is required (max 255 chars)`);
  }
  if (!isOptionalString(b.description) || (b.description || '').length > MAX_TEXT) errors.push(`${at('description')} must be a string (max ${MAX_TEXT} chars)`);
  if (b.order !== undefined && (!Number.isInteger(b.order) || b.order < 1)) errors.push(`${at('order')} must be a positive integer`);
  let items;
  if (KINDS.has(kind) && (!partial || b.items !== undefined)) {
    const r = normalizeItems(kind, b.items === undefined ? [] : b.items, at('items'));
    errors.push(...r.errors);
    items = r.items;
  }
  return { errors, kind, items };
}

// What a student may see of a set: quiz answers and explanations stay on the server until graded.
function publicItems(kind, items, isAdmin) {
  if (isAdmin || kind !== 'quiz') return items;
  return items.map((q) => ({ question: q.question, options: q.options, multiple: q.correct.length > 1 }));
}

function serialize(row, isAdmin, progress) {
  return {
    id: row.id,
    lesson_id: row.lesson_id,
    kind: row.kind,
    title: row.title,
    description: row.description || '',
    order_index: row.order_index,
    item_count: row.items.length,
    items: publicItems(row.kind, row.items, isAdmin),
    progress: progress || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const progressOf = (p) => (p ? { best_score: p.best_score, last_score: p.last_score, total: p.total, attempts: p.attempts } : null);

const sameAnswer = (given, correct) => {
  const g = [...new Set(given)].sort((a, b) => a - b);
  return g.length === correct.length && g.every((v, i) => v === correct[i]);
};

function registerStudySetRoutes({ api, db, io, authenticateToken, requireAdmin, phaseLockReasons }) {
  async function isAdminUser(userId) {
    const [rows] = await db.query('SELECT role FROM users WHERE id = ?', [userId]);
    return rows.length > 0 && rows[0].role === 'admin';
  }

  // null = lesson not found; [] = accessible
  async function lessonLockReasons(userId, lessonId) {
    const [rows] = await db.query('SELECT path_id FROM lessons WHERE id = ?', [lessonId]);
    if (rows.length === 0) return null;
    return phaseLockReasons(db, userId, rows[0].path_id);
  }

  async function loadSet(id) {
    if (!/^\d+$/.test(String(id))) return null;
    const [rows] = await db.query('SELECT * FROM study_sets WHERE id = ?', [id]);
    return rows.length > 0 ? rows[0] : null;
  }

  api.get('/lessons/:id/study-sets', authenticateToken, async (req, res) => {
    try {
      if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Lesson not found' });
      const reasons = await lessonLockReasons(req.user.id, req.params.id);
      if (reasons === null) return res.status(404).json({ error: 'Lesson not found' });
      if (reasons.length > 0) return res.status(403).json({ error: 'This lesson is locked', lockReasons: reasons });
      const admin = await isAdminUser(req.user.id);
      const [sets] = await db.query('SELECT * FROM study_sets WHERE lesson_id = ? ORDER BY order_index ASC, id ASC', [req.params.id]);
      const [prog] = sets.length > 0
        ? await db.query('SELECT * FROM study_set_progress WHERE user_id = ? AND study_set_id = ANY(?)', [req.user.id, sets.map((s) => s.id)])
        : [[]];
      const byId = new Map(prog.map((p) => [p.study_set_id, p]));
      res.json(sets.map((s) => serialize(s, admin, progressOf(byId.get(s.id)))));
    } catch (err) {
      console.error('[GET /lessons/:id/study-sets] Error:', err);
      res.status(500).json({ error: 'Failed to fetch study sets' });
    }
  });

  api.post('/study-sets', authenticateToken, requireAdmin, async (req, res) => {
    const b = req.body || {};
    const { errors, kind, items } = validateStudySet(b);
    if (!Number.isInteger(b.lessonId) || b.lessonId < 1) errors.unshift('lessonId must be a positive integer');
    if (errors.length > 0) return res.status(400).json({ error: 'Invalid study set', details: errors });
    try {
      const created = await db.transaction(async (tx) => {
        // Lock the lesson so concurrent creates get distinct order_index values
        const [lessons] = await tx.query('SELECT id FROM lessons WHERE id = ? FOR UPDATE', [b.lessonId]);
        if (lessons.length === 0) return null;
        const [count] = await tx.query('SELECT COUNT(*) AS n, COALESCE(MAX(order_index), 0) AS max FROM study_sets WHERE lesson_id = ?', [b.lessonId]);
        if (count[0].n >= MAX_SETS_PER_LESSON) { const err = new Error(`A lesson can hold at most ${MAX_SETS_PER_LESSON} study sets`); err.status = 400; throw err; }
        const [rows] = await tx.query(
          'INSERT INTO study_sets (lesson_id, kind, title, description, order_index, items) VALUES (?, ?, ?, ?, ?, ?::jsonb) RETURNING *',
          [b.lessonId, kind, b.title.trim(), text(b.description), b.order ?? count[0].max + 1, JSON.stringify(items)]
        );
        return rows[0];
      });
      if (!created) return res.status(404).json({ error: 'Lesson not found' });
      io.emit('study_set:created', { studySetId: created.id, lessonId: created.lesson_id });
      res.status(201).json(serialize(created, true, null));
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ error: err.message });
      console.error('[POST /study-sets] Error:', err);
      res.status(500).json({ error: 'Failed to create study set' });
    }
  });

  api.get('/study-sets/:id', authenticateToken, async (req, res) => {
    try {
      const set = await loadSet(req.params.id);
      if (!set) return res.status(404).json({ error: 'Study set not found' });
      const reasons = (await lessonLockReasons(req.user.id, set.lesson_id)) || [];
      if (reasons.length > 0) return res.status(403).json({ error: 'This lesson is locked', lockReasons: reasons });
      const admin = await isAdminUser(req.user.id);
      const [prog] = await db.query('SELECT * FROM study_set_progress WHERE user_id = ? AND study_set_id = ?', [req.user.id, set.id]);
      res.json(serialize(set, admin, progressOf(prog[0])));
    } catch (err) {
      console.error('[GET /study-sets/:id] Error:', err);
      res.status(500).json({ error: 'Failed to fetch study set' });
    }
  });

  api.put('/study-sets/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const set = await loadSet(req.params.id);
      if (!set) return res.status(404).json({ error: 'Study set not found' });
      const b = req.body || {};
      if (b.kind !== undefined && b.kind !== set.kind) return res.status(400).json({ error: 'kind cannot be changed; create a new set instead' });
      const { errors, items } = validateStudySet(b, { partial: true, kind: set.kind });
      if (errors.length > 0) return res.status(400).json({ error: 'Invalid study set', details: errors });
      const sets = [];
      const params = [];
      if (b.title !== undefined) { sets.push('title = ?'); params.push(b.title.trim()); }
      if (b.description !== undefined) { sets.push('description = ?'); params.push(text(b.description)); }
      if (b.order !== undefined) { sets.push('order_index = ?'); params.push(b.order); }
      if (items !== undefined) { sets.push('items = ?::jsonb'); params.push(JSON.stringify(items)); }
      if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
      params.push(set.id);
      const [rows] = await db.query(`UPDATE study_sets SET ${sets.join(', ')} WHERE id = ? RETURNING *`, params);
      if (rows.length === 0) return res.status(404).json({ error: 'Study set not found' });
      // New content = new results: a best score earned on the old questions no longer counts
      if (items !== undefined && JSON.stringify(items) !== JSON.stringify(set.items)) {
        await db.query('DELETE FROM study_set_progress WHERE study_set_id = ?', [set.id]);
      }
      io.emit('study_set:updated', { studySetId: set.id, lessonId: set.lesson_id });
      res.json(serialize(rows[0], true, null));
    } catch (err) {
      console.error('[PUT /study-sets/:id] Error:', err);
      res.status(500).json({ error: 'Failed to update study set' });
    }
  });

  api.delete('/study-sets/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const set = await loadSet(req.params.id);
      if (!set) return res.status(404).json({ error: 'Study set not found' });
      await db.query('DELETE FROM study_sets WHERE id = ?', [set.id]);
      io.emit('study_set:deleted', { studySetId: set.id, lessonId: set.lesson_id });
      res.json({ success: true });
    } catch (err) {
      console.error('[DELETE /study-sets/:id] Error:', err);
      res.status(500).json({ error: 'Failed to delete study set' });
    }
  });

  api.post('/study-sets/:id/attempts', authenticateToken, async (req, res) => {
    try {
      const set = await loadSet(req.params.id);
      if (!set) return res.status(404).json({ error: 'Study set not found' });
      const reasons = (await lessonLockReasons(req.user.id, set.lesson_id)) || [];
      if (reasons.length > 0) return res.status(403).json({ error: 'This lesson is locked', lockReasons: reasons });
      const b = req.body || {};
      const total = set.items.length;
      if (total === 0) return res.status(400).json({ error: 'This study set has no items yet' });

      let score;
      let results;
      if (set.kind === 'quiz') {
        if (!Array.isArray(b.answers) || b.answers.length !== total) {
          return res.status(400).json({ error: `answers must be an array with one entry per question (${total})` });
        }
        const answers = b.answers.map((a) => (a === null || a === undefined ? [] : Array.isArray(a) ? a : [a]));
        if (!answers.every((a) => a.every((v) => Number.isInteger(v)))) return res.status(400).json({ error: 'each answer must be an option index, an array of indexes, or null' });
        results = set.items.map((q, i) => ({
          correct: sameAnswer(answers[i], q.correct),
          selected: answers[i],
          correct_options: q.correct,
          explanation: q.explanation || '',
        }));
        score = results.filter((r) => r.correct).length;
      } else {
        if (!Number.isInteger(b.known) || b.known < 0 || b.known > total) return res.status(400).json({ error: `known must be an integer between 0 and ${total}` });
        score = b.known;
      }

      const [rows] = await db.query(
        `INSERT INTO study_set_progress (user_id, study_set_id, best_score, last_score, total, attempts, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, NOW())
         ON CONFLICT (user_id, study_set_id) DO UPDATE SET
           best_score = CASE WHEN study_set_progress.total = EXCLUDED.total
                             THEN GREATEST(study_set_progress.best_score, EXCLUDED.best_score)
                             ELSE EXCLUDED.best_score END,
           last_score = EXCLUDED.last_score, total = EXCLUDED.total,
           attempts = study_set_progress.attempts + 1, updated_at = NOW()
         RETURNING *`,
        [req.user.id, set.id, score, score, total]
      );
      res.json({ score, total, results, progress: progressOf(rows[0]) });
    } catch (err) {
      console.error('[POST /study-sets/:id/attempts] Error:', err);
      res.status(500).json({ error: 'Failed to record attempt' });
    }
  });
}

module.exports = { registerStudySetRoutes, validateStudySet, MAX_SETS_PER_LESSON };
