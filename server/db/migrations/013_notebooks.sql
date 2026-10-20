-- ============================================================================
-- Notebooks: Java notebooks with code and text cells, run in the sandbox runner (runner/).
--   notebooks       — one row per notebook, whoever owns it. A teacher original, a student's copy
--                     and a playground differ only in owner_id, lesson_id and copied_from_id.
--                       cells    [{id, kind: 'code'|'text', source}]  (what the owner edits)
--                       outputs  {<cell id>: {status, stdout, stderr, value, error, ...}}
--                                kept apart from cells so a run never conflicts with an autosave
--                       version  bumped when the cells' content changes ("updated since you copied")
--                       revision bumped on every save (two-tab conflict detection)
--   notebook_files  — images used in text cells. A copy gets its own rows pointing at the same
--                     stored bytes, which are removed when the last row goes.
--   notebook_runs   — one row per run, for per-user limits and usage numbers.
-- Forward-only: never edit after it has been applied.
-- ============================================================================

CREATE TABLE IF NOT EXISTS notebooks (
  id                   SERIAL PRIMARY KEY,
  owner_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                VARCHAR(255) NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  lesson_id            INTEGER REFERENCES lessons(id) ON DELETE SET NULL,
  published            BOOLEAN NOT NULL DEFAULT FALSE,
  copied_from_id       INTEGER REFERENCES notebooks(id) ON DELETE SET NULL,
  copied_from_version  INTEGER,
  copied_at            TIMESTAMPTZ,
  cells                JSONB NOT NULL DEFAULT '[]'::jsonb,
  outputs              JSONB NOT NULL DEFAULT '{}'::jsonb,
  version              INTEGER NOT NULL DEFAULT 1,
  revision             INTEGER NOT NULL DEFAULT 1,
  order_index          INTEGER NOT NULL DEFAULT 1,
  last_run_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notebooks_owner ON notebooks (owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notebooks_lesson ON notebooks (lesson_id, order_index);
CREATE INDEX IF NOT EXISTS idx_notebooks_copied_from ON notebooks (copied_from_id);
DROP TRIGGER IF EXISTS trg_notebooks_updated_at ON notebooks;
CREATE TRIGGER trg_notebooks_updated_at BEFORE UPDATE ON notebooks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A notebook was "deleted" while copies existed: copies keep working and show "original removed"
-- (copied_from_id becomes NULL, copied_at stays set).

CREATE TABLE IF NOT EXISTS notebook_files (
  id            SERIAL PRIMARY KEY,
  notebook_id   INTEGER NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  original_name VARCHAR(255) NOT NULL,
  stored_name   VARCHAR(255) NOT NULL,
  ext           VARCHAR(10)  NOT NULL,
  size_bytes    INTEGER      NOT NULL,
  uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notebook_files_notebook ON notebook_files (notebook_id);
CREATE INDEX IF NOT EXISTS idx_notebook_files_stored ON notebook_files (stored_name);

CREATE TABLE IF NOT EXISTS notebook_runs (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notebook_id  INTEGER REFERENCES notebooks(id) ON DELETE SET NULL,
  mode         VARCHAR(20) NOT NULL,
  cell_count   INTEGER NOT NULL DEFAULT 0,
  status       VARCHAR(20) NOT NULL,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notebook_runs_user ON notebook_runs (user_id, created_at DESC);
