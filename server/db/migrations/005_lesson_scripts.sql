-- ============================================================================
-- Lesson script: the teacher's own Markdown notes for a lesson (prepared before,
-- followed during the session). Admin-only: never returned to students.
-- Forward-only: never edit after it has been applied.
-- ============================================================================
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS script TEXT;
-- When the script itself was last saved (lessons.updated_at also moves on title/order edits, so it
-- cannot serve as the script's concurrency token).
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS script_updated_at TIMESTAMPTZ;
-- The admin review inbox groups submissions by status on every load.
CREATE INDEX IF NOT EXISTS idx_task_submissions_status ON task_submissions (status);
