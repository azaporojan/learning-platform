-- ============================================================================
-- Notifications deep-link into the app (notifications.link = an in-app path such as
-- '/courses/1?lesson=2&task=3'); the same link is the button of the notification email.
--   - new type 'role_changed' (an admin promoted / demoted the user)
--   - existing notifications get the link they would have today
-- Forward-only: never edit after it has been applied.
-- ============================================================================

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'account_approved', 'account_rejected', 'new_task', 'task_submission',
  'task_graded', 'new_user_pending', 'submission_approved',
  'submission_rejected', 'stars_received', 'path_unlocked', 'role_changed'));

-- Task notifications → the task on its course road
UPDATE notifications n
SET link = '/courses/' || p.course_id || '?lesson=' || l.id || '&task=' || t.id
FROM tasks t
INNER JOIN lessons l ON l.id = t.lesson_id
INNER JOIN paths p ON p.id = l.path_id
WHERE n.link IS NULL
  AND n.type IN ('new_task', 'task_submission', 'submission_approved', 'submission_rejected', 'task_graded')
  AND (n.metadata->>'taskId') ~ '^[0-9]+$'
  AND t.id = (n.metadata->>'taskId')::int
  AND p.course_id IS NOT NULL;

UPDATE notifications SET link = '/users?user=' || (metadata->>'userId')
WHERE link IS NULL AND type = 'new_user_pending' AND (metadata->>'userId') ~ '^[0-9]+$';

UPDATE notifications SET link = '/users' WHERE link IS NULL AND type = 'stars_received';

-- Everything else (and task notifications whose task is gone) opens the course catalogue
UPDATE notifications SET link = '/courses' WHERE link IS NULL;
