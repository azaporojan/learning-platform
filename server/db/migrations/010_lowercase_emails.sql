-- ============================================================================
-- Login now matches the email lowercased (registration always stored it that way, but the
-- admin user editor used to store it as typed). Lowercase existing addresses so those accounts
-- can still log in. A row whose lowercase form already belongs to another account is left as
-- it is and reported below: an admin must merge or rename those accounts by hand (see
-- docs/DEPLOYMENT.md, "Duplicate emails after migration 010"). Registration and the admin
-- editor both lowercase on write, so no new mixed-case rows can appear.
-- Forward-only: never edit after it has been applied.
-- ============================================================================
UPDATE users u
SET email = lower(trim(u.email))
WHERE u.email <> lower(trim(u.email))
  AND NOT EXISTS (SELECT 1 FROM users o WHERE o.id <> u.id AND lower(trim(o.email)) = lower(trim(u.email)));

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT id, email FROM users WHERE email <> lower(trim(email)) LOOP
    RAISE WARNING 'migration 010: user % (%) collides with another account by case and cannot log in until an admin resolves it', r.id, r.email;
  END LOOP;
END $$;
