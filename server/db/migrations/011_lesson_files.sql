-- ============================================================================
-- Lesson materials: files a teacher attaches to a lesson (Word, PowerPoint, PDF, TXT, Markdown).
-- The bytes live on the uploads volume under lesson-files/ (never served by the public
-- /api/uploads route); access goes through /api/lesson-files/:id/* with the lesson's lock rules.
-- Forward-only: never edit after it has been applied.
-- ============================================================================
CREATE TABLE IF NOT EXISTS lesson_files (
  id            SERIAL PRIMARY KEY,
  lesson_id     INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  original_name VARCHAR(255) NOT NULL,
  stored_name   VARCHAR(255) NOT NULL UNIQUE,
  ext           VARCHAR(10)  NOT NULL,
  size_bytes    INTEGER      NOT NULL,
  uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  order_index   INTEGER      NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lesson_files_lesson ON lesson_files (lesson_id, order_index);
