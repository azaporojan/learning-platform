-- ============================================================================
-- Lesson script: the teacher's own Markdown notes for a lesson (prepared before,
-- followed during the session). Admin-only: never returned to students.
-- Forward-only: never edit after it has been applied.
-- ============================================================================
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS script TEXT;
