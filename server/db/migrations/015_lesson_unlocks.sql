-- ============================================================================
-- Lesson unlocks: an admin opens a lesson early — for everyone (user_id NULL) or for a chosen
-- student — so the road's "finish the previous lesson / phase first" gate is skipped for it.
-- Enrolment and star gates still apply. Forward-only: never edit after it has been applied.
-- ============================================================================

CREATE TABLE IF NOT EXISTS lesson_unlocks (
  id          SERIAL PRIMARY KEY,
  lesson_id   INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- NULL = every student
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lesson_unlocks_user ON lesson_unlocks (lesson_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_lesson_unlocks_all ON lesson_unlocks (lesson_id) WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_lesson_unlocks_user ON lesson_unlocks (user_id);

-- Students are told when a lesson is opened for them
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'account_approved', 'account_rejected', 'new_task', 'task_submission',
  'task_graded', 'new_user_pending', 'submission_approved',
  'submission_rejected', 'stars_received', 'path_unlocked', 'role_changed', 'lesson_unlocked'));
