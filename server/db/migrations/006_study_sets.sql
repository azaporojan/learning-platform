-- ============================================================================
-- Study sets: practice material hanging under a lesson, next to its tasks.
--   study_sets           — a quiz or a flashcard deck. The content lives in `items` (JSONB):
--                            quiz        [{question, options: [..], correct: [index..], explanation?}]
--                            flashcards  [{front, back}]
--                          They are prep only: they never gate lessons and grant no stars.
--   study_set_progress   — a student's result per set (best/last score out of total, attempts)
-- Forward-only: never edit after it has been applied.
-- ============================================================================

CREATE TABLE IF NOT EXISTS study_sets (
  id          SERIAL PRIMARY KEY,
  lesson_id   INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  kind        VARCHAR(20) NOT NULL CHECK (kind IN ('quiz', 'flashcards')),
  title       VARCHAR(255) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  order_index INTEGER NOT NULL DEFAULT 1,
  items       JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_study_sets_lesson ON study_sets (lesson_id, order_index);
DROP TRIGGER IF EXISTS trg_study_sets_updated_at ON study_sets;
CREATE TRIGGER trg_study_sets_updated_at BEFORE UPDATE ON study_sets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS study_set_progress (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  study_set_id INTEGER NOT NULL REFERENCES study_sets(id) ON DELETE CASCADE,
  best_score   INTEGER NOT NULL DEFAULT 0,
  last_score   INTEGER NOT NULL DEFAULT 0,
  total        INTEGER NOT NULL DEFAULT 0,
  attempts     INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, study_set_id)
);
CREATE INDEX IF NOT EXISTS idx_study_set_progress_set ON study_set_progress (study_set_id);
