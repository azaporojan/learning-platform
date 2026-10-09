-- ============================================================================
-- users.password now holds an encrypted ("sealed") scrypt hash — see server/passwords.js —
-- which is longer than a bcrypt hash: give it room. Existing hashes are sealed by the server
-- at startup (it needs PASSWORD_PEPPER, which never lives in the database).
-- Forward-only: never edit after it has been applied.
-- ============================================================================
ALTER TABLE users ALTER COLUMN password TYPE TEXT;
