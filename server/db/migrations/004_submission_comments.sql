-- ============================================================================
-- Submissions can be a comment (a pull-request link, a Jira ticket, a note), a
-- file, or both. The file columns become optional; `comment` is the text part.
-- Forward-only: never edit after it has been applied.
-- ============================================================================
ALTER TABLE task_submissions ADD COLUMN IF NOT EXISTS comment TEXT;
ALTER TABLE task_submissions ALTER COLUMN file_name DROP NOT NULL;
ALTER TABLE task_submissions ALTER COLUMN file_path DROP NOT NULL;
ALTER TABLE task_submissions ALTER COLUMN file_size DROP NOT NULL;
