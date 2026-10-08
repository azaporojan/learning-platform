-- ============================================================================
-- Login now matches the email lowercased (registration always stored it that way, but the
-- admin user editor used to store it as typed). Lowercase existing addresses so those accounts
-- can still log in. A row whose lowercase form already belongs to another account is left as
-- it is (it could not have been unique otherwise); an admin resolves such duplicates by hand.
-- Forward-only: never edit after it has been applied.
-- ============================================================================
UPDATE users u
SET email = lower(trim(u.email))
WHERE u.email <> lower(trim(u.email))
  AND NOT EXISTS (SELECT 1 FROM users o WHERE o.id <> u.id AND lower(trim(o.email)) = lower(trim(u.email)));
