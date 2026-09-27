-- ============================================================================
-- API keys for automation (e.g. an AI agent creating learning paths).
-- Only the SHA-256 hash of a key is stored; the plaintext is shown once at
-- creation. A key acts on behalf of the admin who created it (created_by)
-- and stops working when it is revoked or when that user is no longer admin.
-- ============================================================================
CREATE TABLE IF NOT EXISTS api_keys (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  key_prefix   VARCHAR(16)  NOT NULL,
  key_hash     CHAR(64)     NOT NULL UNIQUE,
  created_by   INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_api_keys_created_by ON api_keys (created_by);
