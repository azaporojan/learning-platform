-- ============================================================================
-- Teaching progress: an admin marks a lesson as taught (done) so the course outline shows
-- which lessons are behind, which one is current and which one comes next. Admin-only:
-- students keep their own progress (based on their task submissions).
-- Forward-only: never edit after it has been applied.
-- ============================================================================
ALTER TABLE lessons ADD COLUMN IF NOT EXISTS taught_at TIMESTAMPTZ;
