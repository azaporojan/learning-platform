-- ============================================================================
-- Learning Platform — initial PostgreSQL schema
-- Ported from the MySQL setup (setup_database.sql + the ad-hoc ALTERs the old
-- server ran at startup). Forward-only: never edit after it has been applied.
-- ============================================================================

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 1. USERS -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(255) NOT NULL,
  email               VARCHAR(255) NOT NULL UNIQUE,
  password            VARCHAR(255) NOT NULL,
  role                VARCHAR(20)  NOT NULL DEFAULT 'student' CHECK (role IN ('admin', 'student')),
  stars               INTEGER      NOT NULL DEFAULT 0,
  avatar_url          VARCHAR(512),
  is_approved         BOOLEAN      NOT NULL DEFAULT FALSE,
  login_code          VARCHAR(10),
  login_code_expires  TIMESTAMPTZ,
  login_code_attempts INTEGER      NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users (role);
DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 2. PATHS -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paths (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(255) NOT NULL,
  description    TEXT,
  stars_required INTEGER     NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS trg_paths_updated_at ON paths;
CREATE TRIGGER trg_paths_updated_at BEFORE UPDATE ON paths
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3. USER_PATHS (unlocked paths) ---------------------------------------------
CREATE TABLE IF NOT EXISTS user_paths (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path_id     INTEGER NOT NULL REFERENCES paths(id) ON DELETE CASCADE,
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, path_id)
);
CREATE INDEX IF NOT EXISTS idx_user_paths_path_id ON user_paths (path_id);

-- 4. LESSONS -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lessons (
  id          SERIAL PRIMARY KEY,
  path_id     INTEGER NOT NULL REFERENCES paths(id) ON DELETE CASCADE,
  title       VARCHAR(255) NOT NULL,
  description TEXT,
  position_x  INTEGER NOT NULL DEFAULT 0,
  position_y  INTEGER NOT NULL DEFAULT 0,
  order_index INTEGER NOT NULL,
  parent_id   INTEGER REFERENCES lessons(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lessons_path_id ON lessons (path_id);
CREATE INDEX IF NOT EXISTS idx_lessons_order ON lessons (order_index);
DROP TRIGGER IF EXISTS trg_lessons_updated_at ON lessons;
CREATE TRIGGER trg_lessons_updated_at BEFORE UPDATE ON lessons
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 5. TASKS -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id          SERIAL PRIMARY KEY,
  lesson_id   INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  title       VARCHAR(255) NOT NULL,
  description TEXT,
  type        VARCHAR(20) NOT NULL DEFAULT 'mandatory' CHECK (type IN ('mandatory', 'optional')),
  xp_reward   INTEGER NOT NULL DEFAULT 10,
  deadline    TIMESTAMPTZ,
  position_x  INTEGER NOT NULL DEFAULT 0,
  position_y  INTEGER NOT NULL DEFAULT 0,
  order_index INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tasks_lesson_id ON tasks (lesson_id);
CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks (type);
DROP TRIGGER IF EXISTS trg_tasks_updated_at ON tasks;
CREATE TRIGGER trg_tasks_updated_at BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 6. USER_PROGRESS -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_progress (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type  VARCHAR(20) NOT NULL CHECK (entity_type IN ('lesson', 'task')),
  entity_id    INTEGER NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_user_progress_entity ON user_progress (entity_type, entity_id);

-- 7. TASK_SUBMISSIONS --------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_submissions (
  id           SERIAL PRIMARY KEY,
  task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_name    VARCHAR(255) NOT NULL,
  file_path    VARCHAR(512) NOT NULL,
  file_size    BIGINT NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  is_viewed    BOOLEAN NOT NULL DEFAULT FALSE,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_task_submissions_task_id ON task_submissions (task_id);
CREATE INDEX IF NOT EXISTS idx_task_submissions_user_id ON task_submissions (user_id);

-- 8. CHATS -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chats (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chats_created_by ON chats (created_by);
DROP TRIGGER IF EXISTS trg_chats_updated_at ON chats;
CREATE TRIGGER trg_chats_updated_at BEFORE UPDATE ON chats
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 9. CHAT_MEMBERS ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_members (
  id        SERIAL PRIMARY KEY,
  chat_id   INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_members_user_id ON chat_members (user_id);

-- 10. MESSAGES ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id         SERIAL PRIMARY KEY,
  chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT NOT NULL DEFAULT '',
  images     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages (chat_id, created_at);

-- 11. NOTIFICATIONS ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       VARCHAR(40) NOT NULL CHECK (type IN (
               'account_approved', 'account_rejected', 'new_task', 'task_submission',
               'task_graded', 'new_user_pending', 'submission_approved',
               'submission_rejected', 'stars_received', 'path_unlocked')),
  title      VARCHAR(255),
  message    TEXT,
  link       VARCHAR(512),
  metadata   JSONB,
  status     VARCHAR(20) NOT NULL DEFAULT 'unread',
  is_read    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications (user_id, created_at DESC);

-- 12. USER_TASK_VIEWS (NEW badge tracking) -----------------------------------
CREATE TABLE IF NOT EXISTS user_task_views (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  viewed_at  TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_user_task_views_task_id ON user_task_views (task_id);

-- Seed: default learning paths (only on an empty table) -----------------------
INSERT INTO paths (name, description, stars_required)
SELECT * FROM (VALUES
  ('HTML + CSS', 'Learn the fundamentals of web development with HTML and CSS', 0),
  ('JavaScript', 'Master JavaScript programming and build interactive web applications', 3000)
) AS seed(name, description, stars_required)
WHERE NOT EXISTS (SELECT 1 FROM paths);
