-- ============================================================================
-- Courses: a course groups ordered paths ("phases") into one end-to-end road.
--   courses             — e.g. "QA Automation Engineer"
--   paths.course_id     — which course a path belongs to (NULL = unassigned)
--   paths.order_index   — position of the phase inside its course
--   paths.requires_previous — phase is locked until every mandatory task of the
--                         previous phase is approved (admin-configurable per phase;
--                         stars_required stays as an optional extra gate, 0 = none)
--   course_enrollments  — students enrol explicitly ("My courses")
-- Forward-only: never edit after it has been applied.
-- ============================================================================

CREATE TABLE IF NOT EXISTS courses (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS trg_courses_updated_at ON courses;
CREATE TRIGGER trg_courses_updated_at BEFORE UPDATE ON courses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE paths ADD COLUMN IF NOT EXISTS course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL;
ALTER TABLE paths ADD COLUMN IF NOT EXISTS order_index INTEGER NOT NULL DEFAULT 1;
ALTER TABLE paths ADD COLUMN IF NOT EXISTS requires_previous BOOLEAN NOT NULL DEFAULT TRUE;
CREATE INDEX IF NOT EXISTS idx_paths_course ON paths (course_id, order_index);

CREATE TABLE IF NOT EXISTS course_enrollments (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, course_id)
);
CREATE INDEX IF NOT EXISTS idx_course_enrollments_course ON course_enrollments (course_id);

-- The placeholder paths seeded by 001 on an empty database ("HTML + CSS", "JavaScript")
-- are removed when they were never used (no lessons, nobody unlocked them), so a fresh
-- install starts with an empty catalogue instead of two demo phases in a real course.
DELETE FROM paths p
WHERE p.name IN ('HTML + CSS', 'JavaScript')
  AND NOT EXISTS (SELECT 1 FROM lessons l WHERE l.path_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM user_paths up WHERE up.path_id = p.id);

-- Existing content: every path that is still unassigned becomes a phase of the
-- "QA Automation Engineer" course, in the order the old UI listed them.
DO $$
DECLARE
  cid INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM paths WHERE course_id IS NULL) THEN
    INSERT INTO courses (name, description)
    VALUES ('QA Automation Engineer',
            'From Java fundamentals to API and UI test automation: four phases, one road.')
    RETURNING id INTO cid;

    WITH ordered AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY stars_required ASC, id ASC) AS rn
      FROM paths WHERE course_id IS NULL
    )
    UPDATE paths p SET course_id = cid, order_index = o.rn
    FROM ordered o WHERE p.id = o.id;
  END IF;
END $$;
