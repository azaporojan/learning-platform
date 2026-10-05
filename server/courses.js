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

function registerCourseRoutes({ api, db, io, authenticateToken, requireAdmin, optionalUserId }) {
  const isAdminRole = (role) => role === 'admin';

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
      res.json({ success: true, enrolled: true });
    } catch (err) {
      console.error('[POST /courses/:id/enroll] Error:', err);
      res.status(500).json({ error: 'Failed to enrol' });
    }
  });

  api.delete('/courses/:id/enroll', authenticateToken, async (req, res) => {
    try {
      await db.query('DELETE FROM course_enrollments WHERE user_id = ? AND course_id = ?', [req.user.id, req.params.id]);
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

      const [paths] = await db.query('SELECT * FROM paths WHERE course_id = ? ORDER BY order_index ASC, stars_required ASC, id ASC', [course.id]);
      const pathIds = paths.map((p) => p.id);
      let lessons = [];
      let tasks = [];
      if (pathIds.length > 0) {
        [lessons] = await db.query(`SELECT * FROM lessons WHERE path_id IN (${pathIds.join(',')}) ORDER BY order_index ASC, id ASC`);
        const lessonIds = lessons.map((l) => l.id);
        if (lessonIds.length > 0) {
          [tasks] = await db.query(`SELECT * FROM tasks WHERE lesson_id IN (${lessonIds.join(',')}) ORDER BY order_index ASC, id ASC`);
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
              WHERE task_id IN (${taskIds.join(',')}) AND status != 'rejected' AND (is_viewed = FALSE OR is_viewed IS NULL)
              GROUP BY task_id`);
            const map = new Map(unviewed.map((u) => [u.task_id, u.count]));
            tasks.forEach((t) => { t.unviewed_count = map.get(t.id) || 0; });
          } else {
            const [views] = await db.query(`SELECT task_id, viewed_at FROM user_task_views WHERE user_id = ? AND task_id IN (${taskIds.join(',')})`, [caller.id]);
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
        const lockReasons = [];
        if (!admin) {
          if (!enrolled) lockReasons.push('enroll');
          if (index > 0 && p.requires_previous && !previousPhaseDone) lockReasons.push('previous');
          if (p.stars_required > 0 && (caller?.stars || 0) < p.stars_required) lockReasons.push('stars');
        }
        previousPhaseDone = phaseLessons.every(lessonMandatoryDone);
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

module.exports = { registerCourseRoutes };
