-- ============================================================================
-- Password / session hardening
--   session_version        bumped when the password changes: every session cookie carries the
--                          version it was issued with, so older sessions stop working at once
--   failed_login_attempts  wrong passwords in a row; at 10 the account is locked for 15 minutes
--   locked_until           (on top of the per-IP rate limit, which a distributed guesser avoids)
--   password_changed_at    shown to the user, and lets admins see stale passwords
--   login_code             now holds the SHA-256 of the emailed code (64 hex chars), never the code
-- Forward-only: never edit after it has been applied.
-- ============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
ALTER TABLE users ALTER COLUMN login_code TYPE VARCHAR(64);
-- Codes issued before this release were stored in clear: void them (they live 10 minutes anyway).
UPDATE users SET login_code = NULL, login_code_expires = NULL, login_code_attempts = 0 WHERE login_code IS NOT NULL;
