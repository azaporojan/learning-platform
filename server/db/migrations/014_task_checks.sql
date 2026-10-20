-- ============================================================================
-- Auto-checked tasks: hidden JUnit tests per task, run by the sandbox runner (runner/).
--   task_checks        — one row per checked task: the hidden tests [{path, content}], the starter
--                        files students begin from, the time budget, auto-approve.
--   submission_checks  — one check of a code submission: the submitted files and the result.
--                        A submission can be checked again (admin re-check); the newest row counts.
-- Forward-only: never edit after it has been applied.
-- ============================================================================

CREATE TABLE IF NOT EXISTS task_checks (
  task_id       INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  tests         JSONB NOT NULL DEFAULT '[]'::jsonb,
  starter       JSONB NOT NULL DEFAULT '[]'::jsonb,
  timeout_s     INTEGER NOT NULL DEFAULT 30 CHECK (timeout_s BETWEEN 5 AND 60),
  auto_approve  BOOLEAN NOT NULL DEFAULT FALSE,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS trg_task_checks_updated_at ON task_checks;
CREATE TRIGGER trg_task_checks_updated_at BEFORE UPDATE ON task_checks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS submission_checks (
  id             SERIAL PRIMARY KEY,
  submission_id  INTEGER NOT NULL REFERENCES task_submissions(id) ON DELETE CASCADE,
  files          JSONB NOT NULL DEFAULT '[]'::jsonb,
  status         VARCHAR(20) NOT NULL DEFAULT 'running',
  summary        TEXT NOT NULL DEFAULT '',
  passed         INTEGER,
  total          INTEGER,
  result         JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_submission_checks_submission ON submission_checks (submission_id, id DESC);
