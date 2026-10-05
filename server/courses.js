// ---------------------------------------------------------------------------
// Courses: a course groups ordered paths ("phases") into one end-to-end road.
//
//   GET    /courses                 catalogue (+ enrolled flag / progress for the caller)
//   POST   /courses                 admin: create
//   PUT    /courses/:id             admin: rename / describe
//   DELETE /courses/:id             admin: delete (its phases become unassigned)
//   POST   /courses/:id/enroll      student: enrol ("My courses")
//   DELETE /courses/:id/enroll      student: leave
//   GET    /courses/:id             the whole road: phases → lessons → tasks with the
//                                   caller's completion flags and per-phase gating
//   GET    /users/directory         everyone (approved): name, role, stars, avatar
//
// Gating for a student, per phase (admin sees everything unlocked):
//   - must be enrolled in the course
//   - requires_previous: every mandatory task of the previous phase is approved
//   - stars_required > 0: the student has at least that many stars
// ---------------------------------------------------------------------------

const isAdminRole = (role) => role === 'admin';

// Why a phase (path) is locked for a user: [] = accessible. Mirrors the per-phase logic of
// GET /courses/:id and is what the submission route enforces. Paths outside any course keep
// the legacy behaviour (no course gating). Admins are never locked.
// The single definition of "why is this phase locked": used by GET /courses/:id (batched) and
// by the per-request checks below, so the UI and the submit route can never disagree.
//   previousDone — every mandatory task of the previous phase is approved. A phase without
//   mandatory tasks (or the first phase) counts as done on purpose: there is nothing to gate on.
function phaseLockReasonsFrom({ isAdmin, enrolled, isFirst, requiresPrevious, previousDone, stars, starsRequired }) {
  if (isAdmin) return [];
  const reasons = [];
  if (!enrolled) reasons.push('enroll');
  if (!isFirst && requiresPrevious && !previousDone) reasons.push('previous');
  if (starsRequired > 0 && (stars || 0) < starsRequired) reasons.push('stars');
  return reasons;
}

// Phases of a course in road order. order_index is kept unique by placePhase; id breaks ties.
const PHASE_ORDER = 'ORDER BY order_index ASC, id ASC';

async function phaseLockReasons(db, userId, pathId) {
  const [paths] = await db.query('SELECT id, course_id, order_index, stars_required, requires_previous FROM paths WHERE id = ?', [pathId]);
  if (paths.length === 0) return [];
  const path = paths[0];
  const [users] = userId ? await db.query('SELECT role, stars FROM users WHERE id = ?', [userId]) : [[]];
  if (users.length > 0 && isAdminRole(users[0].role)) return [];
  // A path outside any course is an admin workspace (e.g. after its course was deleted or while
  // it is being prepared): students cannot reach it, whatever its gates say.
  if (path.course_id === null) return ['unpublished'];
  if (users.length === 0) return ['enroll'];

  const [enrolled] = await db.query('SELECT 1 FROM course_enrollments WHERE user_id = ? AND course_id = ?', [userId, path.course_id]);
  const [previous] = await db.query(
    `SELECT id FROM paths WHERE course_id = ? AND (order_index < ? OR (order_index = ? AND id < ?))
     ORDER BY order_index DESC, id DESC LIMIT 1`,
    [path.course_id, path.order_index, path.order_index, path.id]
  );
  let previousDone = true;
  if (previous.length > 0 && path.requires_previous) {
    const [pending] = await db.query(
      `SELECT COUNT(*) AS n FROM tasks t INNER JOIN lessons l ON l.id = t.lesson_id
       WHERE l.path_id = ? AND t.type = 'mandatory'
         AND NOT EXISTS (SELECT 1 FROM user_progress up WHERE up.user_id = ? AND up.entity_type = 'task' AND up.entity_id = t.id)`,
      [previous[0].id, userId]
    );
    previousDone = pending[0].n === 0;
  }
  return phaseLockReasonsFrom({
    isAdmin: false, enrolled: enrolled.length > 0, isFirst: previous.length === 0,
    requiresPrevious: path.requires_previous, previousDone, stars: users[0].stars, starsRequired: path.stars_required,
  });
}

// null when the task does not exist (so callers can answer 404 instead of inserting).
async function taskLockReasons(db, userId, taskId) {
  const [rows] = await db.query('SELECT l.path_id FROM tasks t INNER JOIN lessons l ON l.id = t.lesson_id WHERE t.id = ?', [taskId]);
  if (rows.length === 0) return null;
  return phaseLockReasons(db, userId, rows[0].path_id);
}

// Renumber a course's phases 1..n (by current order_index, then id).
async function renumberCourse(tx, courseId) {
  await tx.query(
    `UPDATE paths p SET order_index = o.rn
     FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY order_index ASC, id ASC) AS rn FROM paths WHERE course_id = ?) o
     WHERE p.id = o.id AND p.order_index <> o.rn`,
    [courseId]
  );
}

// Put a phase into a course at a 1-based position (null = append) and keep every phase of the
// course numbered 1..n without gaps or duplicates. Runs inside the caller's transaction and
// locks the course row, so concurrent appends cannot pick the same index.
// Lock order, everywhere a course's phases are rewritten: course rows first (ascending id), path
// rows only afterwards. Callers must not hold a path row lock when they call this.
async function lockCourses(tx, courseIds) {
  const ids = [...new Set(courseIds.filter((c) => c !== null && c !== undefined))].sort((a, b) => a - b);
  const found = new Set();
  for (const id of ids) {
    const [rows] = await tx.query('SELECT id FROM courses WHERE id = ? FOR UPDATE', [id]);
    if (rows.length > 0) found.add(id);
  }
  return found;
}

async function placePhase(tx, pathId, courseId, position) {
  // If the phase leaves a course, that course is renumbered here too, so no caller can forget it.
  const [current] = await tx.query('SELECT course_id FROM paths WHERE id = ?', [pathId]);
  const previousCourseId = current.length > 0 ? current[0].course_id : null;
  const locked = await lockCourses(tx, [previousCourseId, courseId]);
  if (courseId === null || courseId === undefined) {
    await tx.query('UPDATE paths SET course_id = NULL, order_index = 1 WHERE id = ?', [pathId]);
    if (previousCourseId !== null) await renumberCourse(tx, previousCourseId);
    return;
  }
  if (!locked.has(courseId)) { const err = new Error('Course not found'); err.status = 404; throw err; }
  // Spread the existing phases out (2, 4, 6, …) so the moved one can slot in between (2k-1).
  await tx.query('UPDATE paths SET order_index = order_index * 2 WHERE course_id = ? AND id <> ?', [courseId, pathId]);
  let target;
  if (position === null || position === undefined) {
    const [max] = await tx.query('SELECT COALESCE(MAX(order_index), 0) AS max FROM paths WHERE course_id = ? AND id <> ?', [courseId, pathId]);
    target = max[0].max + 1;
  } else {
    target = position * 2 - 1;
  }
  await tx.query('UPDATE paths SET course_id = ?, order_index = ? WHERE id = ?', [courseId, target, pathId]);
  await renumberCourse(tx, courseId);
  if (previousCourseId !== null && previousCourseId !== courseId) await renumberCourse(tx, previousCourseId);
}

function registerCourseRoutes({ api, db, io, authenticateToken, requireAdmin, optionalUserId }) {

  async function getCaller(userId) {
    if (!userId) return null;
    const [rows] = await db.query('SELECT id, role, stars FROM users WHERE id = ?', [userId]);
    return rows.length > 0 ? rows[0] : null;
  }

  function validateCourseBody(body) {
    const errors = [];
    const b = body || {};
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 255) errors.push('name is required (max 255 chars)');
    if (b.description !== undefined && b.description !== null && typeof b.description !== 'string') errors.push('description must be a string');
    return errors;
  }

  // A lesson counts as completed when every mandatory task is approved (and, if it only has
  // optional tasks, when all of them are). Lessons without tasks never block anything.
  function lessonCompleted(lesson) {
    if (lesson.tasks.length === 0) return false;
    const mandatory = lesson.tasks.filter((t) => t.type === 'mandatory');
    if (mandatory.length === 0) return lesson.tasks.every((t) => t.completed);
    return mandatory.every((t) => t.completed);
  }
  function lessonMandatoryDone(lesson) {
    return lesson.tasks.filter((t) => t.type === 'mandatory').every((t) => t.completed);
  }

  // ---- catalogue -----------------------------------------------------------
  api.get('/courses', async (req, res) => {
    try {
      const caller = await getCaller(optionalUserId(req));
      const [courses] = await db.query('SELECT * FROM courses ORDER BY id ASC');
      const [phaseCounts] = await db.query(`
        SELECT p.course_id, COUNT(DISTINCT p.id) AS phases, COUNT(l.id) AS lessons
        FROM paths p LEFT JOIN lessons l ON l.path_id = p.id
        WHERE p.course_id IS NOT NULL GROUP BY p.course_id
      `);
      const [enrolledCounts] = await db.query('SELECT course_id, COUNT(*) AS students FROM course_enrollments GROUP BY course_id');

      let mine = new Set();
      let progressByCourse = new Map();
      if (caller) {
        const [rows] = await db.query('SELECT course_id FROM course_enrollments WHERE user_id = ?', [caller.id]);
        mine = new Set(rows.map((r) => r.course_id));
        if (!isAdminRole(caller.role)) {
          const [prog] = await db.query(`
            SELECT p.course_id,
                   COUNT(t.id) FILTER (WHERE t.type = 'mandatory') AS total_mandatory,
                   COUNT(up.id) FILTER (WHERE t.type = 'mandatory') AS done_mandatory
            FROM paths p
            JOIN lessons l ON l.path_id = p.id
            JOIN tasks t ON t.lesson_id = l.id
            LEFT JOIN user_progress up ON up.entity_type = 'task' AND up.entity_id = t.id AND up.user_id = ?
            WHERE p.course_id IS NOT NULL GROUP BY p.course_id
          `, [caller.id]);
          progressByCourse = new Map(prog.map((r) => [r.course_id, { total: r.total_mandatory, done: r.done_mandatory }]));
        }
      }

      const counts = new Map(phaseCounts.map((r) => [r.course_id, r]));
      const students = new Map(enrolledCounts.map((r) => [r.course_id, r.students]));
      res.json(courses.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description || '',
        phaseCount: counts.get(c.id)?.phases || 0,
        lessonCount: counts.get(c.id)?.lessons || 0,
        studentCount: students.get(c.id) || 0,
        enrolled: mine.has(c.id),
        progress: progressByCourse.get(c.id) || null,
      })));
    } catch (err) {
      console.error('[GET /courses] Error:', err);
      res.status(500).json({ error: 'Failed to fetch courses' });
    }
  });

  // ---- admin CRUD ----------------------------------------------------------
  api.post('/courses', authenticateToken, requireAdmin, async (req, res) => {
    const errors = validateCourseBody(req.body);
    if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });
    try {
      const [result] = await db.query('INSERT INTO courses (name, description) VALUES (?, ?)', [req.body.name.trim(), req.body.description || '']);
      io.emit('course:updated', { courseId: result.insertId });
      res.status(201).json({ id: result.insertId, name: req.body.name.trim(), description: req.body.description || '' });
    } catch (err) {
      console.error('[POST /courses] Error:', err);
      res.status(500).json({ error: 'Failed to create course' });
    }
  });

  api.put('/courses/:id', authenticateToken, requireAdmin, async (req, res) => {
    const errors = validateCourseBody(req.body);
    if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });
    try {
      const [result] = await db.query('UPDATE courses SET name = ?, description = ? WHERE id = ?', [req.body.name.trim(), req.body.description || '', req.params.id]);
      if (result.affectedRows === 0) return res.status(404).json({ error: 'Course not found' });
      io.emit('course:updated', { courseId: Number(req.params.id) });
      res.json({ success: true });
    } catch (err) {
      console.error('[PUT /courses/:id] Error:', err);
      res.status(500).json({ error: 'Failed to update course' });
    }
  });

  api.delete('/courses/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
      // paths.course_id is ON DELETE SET NULL: the phases survive as "unassigned".
      const [result] = await db.query('DELETE FROM courses WHERE id = ?', [req.params.id]);
      if (result.affectedRows === 0) return res.status(404).json({ error: 'Course not found' });
      io.emit('course:updated', { courseId: Number(req.params.id) });
      res.json({ success: true });
    } catch (err) {
      console.error('[DELETE /courses/:id] Error:', err);
      res.status(500).json({ error: 'Failed to delete course' });
    }
  });

  // ---- enrolment -----------------------------------------------------------
  api.post('/courses/:id/enroll', authenticateToken, async (req, res) => {
    try {
      const [courses] = await db.query('SELECT id FROM courses WHERE id = ?', [req.params.id]);
      if (courses.length === 0) return res.status(404).json({ error: 'Course not found' });
      await db.query(
        'INSERT INTO course_enrollments (user_id, course_id) VALUES (?, ?) ON CONFLICT (user_id, course_id) DO NOTHING',
        [req.user.id, req.params.id]
      );
      io.emit('course:updated', { courseId: Number(req.params.id) });
      res.json({ success: true, enrolled: true });
    } catch (err) {
      console.error('[POST /courses/:id/enroll] Error:', err);
      res.status(500).json({ error: 'Failed to enrol' });
    }
  });

  api.delete('/courses/:id/enroll', authenticateToken, async (req, res) => {
    try {
      await db.query('DELETE FROM course_enrollments WHERE user_id = ? AND course_id = ?', [req.user.id, req.params.id]);
      io.emit('course:updated', { courseId: Number(req.params.id) });
      res.json({ success: true, enrolled: false });
    } catch (err) {
      console.error('[DELETE /courses/:id/enroll] Error:', err);
      res.status(500).json({ error: 'Failed to leave course' });
    }
  });

  // ---- the road ------------------------------------------------------------
  api.get('/courses/:id', async (req, res) => {
    try {
      const [courses] = await db.query('SELECT * FROM courses WHERE id = ?', [req.params.id]);
      if (courses.length === 0) return res.status(404).json({ error: 'Course not found' });
      const course = courses[0];
      const caller = await getCaller(optionalUserId(req));
      const admin = caller ? isAdminRole(caller.role) : false;

      const [paths] = await db.query(`SELECT * FROM paths WHERE course_id = ? ${PHASE_ORDER}`, [course.id]);
      const pathIds = paths.map((p) => p.id);
      let lessons = [];
      let tasks = [];
      if (pathIds.length > 0) {
        // Explicit columns: `script` (admin-only teaching notes) is never loaded for the road.
        [lessons] = await db.query(
          'SELECT id, path_id, title, description, position_x, position_y, order_index, parent_id FROM lessons WHERE path_id = ANY(?) ORDER BY order_index ASC, id ASC',
          [pathIds]
        );
        const lessonIds = lessons.map((l) => l.id);
        if (lessonIds.length > 0) {
          [tasks] = await db.query('SELECT * FROM tasks WHERE lesson_id = ANY(?) ORDER BY order_index ASC, id ASC', [lessonIds]);
        }
      }
      const taskIds = tasks.map((t) => t.id);

      // Caller-specific flags: completion, NEW badges (students), unviewed submissions (admin)
      const completed = new Set();
      let enrolled = false;
      if (caller) {
        const [prog] = await db.query("SELECT entity_id FROM user_progress WHERE user_id = ? AND entity_type = 'task'", [caller.id]);
        prog.forEach((p) => completed.add(p.entity_id));
        const [enr] = await db.query('SELECT 1 FROM course_enrollments WHERE user_id = ? AND course_id = ?', [caller.id, course.id]);
        enrolled = enr.length > 0;
        if (taskIds.length > 0) {
          if (admin) {
            const [unviewed] = await db.query(`
              SELECT task_id, COUNT(*) AS count FROM task_submissions
              WHERE task_id = ANY(?) AND status != 'rejected' AND (is_viewed = FALSE OR is_viewed IS NULL)
              GROUP BY task_id`, [taskIds]);
            const map = new Map(unviewed.map((u) => [u.task_id, u.count]));
            tasks.forEach((t) => { t.unviewed_count = map.get(t.id) || 0; });
          } else {
            const [views] = await db.query('SELECT task_id, viewed_at FROM user_task_views WHERE user_id = ? AND task_id = ANY(?)', [caller.id, taskIds]);
            const map = new Map(views.map((v) => [v.task_id, v.viewed_at]));
            tasks.forEach((t) => { t.is_new = !map.get(t.id); });
          }
        }
      }

      const tasksByLesson = new Map();
      tasks.forEach((t) => {
        const list = tasksByLesson.get(t.lesson_id) || [];
        list.push({
          id: t.id, lesson_id: t.lesson_id, title: t.title, description: t.description, type: t.type,
          xp_reward: t.xp_reward, deadline: t.deadline, order_index: t.order_index,
          position_x: t.position_x, position_y: t.position_y,
          completed: completed.has(t.id), is_new: t.is_new, unviewed_count: t.unviewed_count,
        });
        tasksByLesson.set(t.lesson_id, list);
      });

      let previousPhaseDone = true;
      const phases = paths.map((p, index) => {
        const phaseLessons = lessons.filter((l) => l.path_id === p.id).map((l) => {
          const lt = tasksByLesson.get(l.id) || [];
          return {
            id: l.id, path_id: l.path_id, title: l.title, description: l.description,
            order_index: l.order_index, position_x: l.position_x, position_y: l.position_y,
            tasks: lt, completed: lessonCompleted({ tasks: lt }),
          };
        });
        const lockReasons = phaseLockReasonsFrom({
          isAdmin: admin, enrolled, isFirst: index === 0, requiresPrevious: p.requires_previous,
          previousDone: previousPhaseDone, stars: caller?.stars, starsRequired: p.stars_required,
        });
        previousPhaseDone = phaseLessons.every(lessonMandatoryDone);
        // Locked phases keep their lesson titles, summaries and task titles (so a student can see
        // what is coming); only the task briefs are held back until the phase is reached.
        if (lockReasons.length > 0) {
          phaseLessons.forEach((l) => { l.tasks.forEach((t) => { t.description = ''; }); });
        }
        return {
          id: p.id, name: p.name, description: p.description || '', order_index: p.order_index,
          stars_required: p.stars_required, requires_previous: p.requires_previous,
          locked: lockReasons.length > 0, lockReasons, lessons: phaseLessons,
        };
      });

      res.json({ id: course.id, name: course.name, description: course.description || '', enrolled, phases });
    } catch (err) {
      console.error('[GET /courses/:id] Error:', err);
      res.status(500).json({ error: 'Failed to fetch course' });
    }
  });

  // ---- users directory (everyone who is logged in) -------------------------
  api.get('/users/directory', authenticateToken, async (req, res) => {
    try {
      const [users] = await db.query(`
        SELECT id, name, role, stars, avatar_url FROM users
        WHERE is_approved = TRUE
        ORDER BY CASE WHEN role = 'admin' THEN 0 ELSE 1 END, stars DESC, name ASC`);
      res.json(users);
    } catch (err) {
      console.error('[GET /users/directory] Error:', err);
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  });
}

module.exports = { registerCourseRoutes, placePhase, renumberCourse, lockCourses, phaseLockReasons, taskLockReasons };
