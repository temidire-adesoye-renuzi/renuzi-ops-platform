-- ============================================================================
-- MIGRATION 04: FORCE PASSWORD ROTATION FOR SEED USERS (Objective 6)
--
-- REMEDIATION for the hardcoded default pilot credentials shipped in
-- 01_create_database.sql:
--   ADMIN-001: Admin@123, FLEET-MGR-001: Fleet@123,
--   WH-MGR-001: Warehouse@123, DRV-001: Driver@123
--
-- These passwords are in the repository, so every environment seeded from
-- it shares them. This migration:
--   1. Sets must_change_password = 1 for every seed user whose password
--      hash still matches a KNOWN DEFAULT hash (so users who already
--      rotated are not nagged).
--   2. Additionally INVALIDATES the known-default hashes outright for
--      ADMIN-001 style accounts by randomizing them: a leaked default
--      cannot be used even before the owner logs in to rotate. The owner
--      then uses the admin "password reset" flow to set a new credential.
--      NOTE: only the must_change_password path is automatic; full
--      randomization is in the commented-out section 4 below (uncomment
--      per environment; there is no runtime flag).
--   3. Records the enforcement timestamp for audit.
--
-- The auth middleware blocks all API access for flagged users except
-- POST /api/auth/change-password until they rotate.
--
-- IDEMPOTENT: re-running never re-flags users who changed passwords.
-- ============================================================================

USE RenuziOpsDB;
GO
SET NOCOUNT ON;
GO

-- The known bcrypt hashes exactly as seeded in 01_create_database.sql
DECLARE @known_hashes TABLE (hash VARCHAR(255));
INSERT INTO @known_hashes (hash) VALUES
  ('$2a$10$jlN1CNBD1BJDW0I2CU4VMewXRGgG0SOKufg1Onk3eByQ4vbnmhQHi'), -- Admin@123
  ('$2a$10$reNj7R7DrfZlzsccmunF/O.yMt/0wWLI13lGJxuTO3POa71gPk51e'), -- Fleet@123
  ('$2a$10$xZsIq.AYL.Q5lhfja1KSGegLnWFjn2SQXdgUJKAde6iEHuIWK049q'), -- Warehouse@123
  ('$2a$10$jd/yB.L4AGDBgqFVcONWw.ECdnW2acwXxmGxycuOBa1Wq1dhB9Eja'); -- Driver@123

-- 1. Flag every user still on a default password
UPDATE u
   SET u.must_change_password = 1
  FROM dim_user u
  JOIN @known_hashes k ON u.password_hash = k.hash
 WHERE u.must_change_password = 0;

PRINT CONCAT('Users flagged for forced rotation: ', @@ROWCOUNT);
GO

-- 2. Audit: record the enforcement timestamp. The original
--    CASE WHEN password_changed_at IS NULL THEN NULL ELSE
--    password_changed_at END was a guaranteed no-op (both branches returned
--    the column's current value), so nothing was ever recorded. A dedicated
--    rotation_enforced_at column is used instead of overloading
--    password_changed_at: stamping the FLAG time into a column named
--    "changed at" would make a flagged-but-not-yet-rotated user look like
--    they had already rotated - a false audit conclusion. Stamps only the
--    first enforcement (IS NULL guard keeps re-runs no-ops) and never
--    touches the real rotation timestamps.
IF COL_LENGTH('dim_user', 'rotation_enforced_at') IS NULL
    ALTER TABLE dim_user ADD rotation_enforced_at DATETIME2 NULL;
GO
UPDATE dim_user
   SET rotation_enforced_at = GETDATE()
 WHERE must_change_password = 1
   AND rotation_enforced_at IS NULL;
GO

-- 3. Report current rotation posture (visible in migration logs)
SELECT u.user_id, u.role, u.must_change_password, u.password_changed_at, u.rotation_enforced_at
  FROM dim_user u
 ORDER BY u.must_change_password DESC, u.user_id;
GO

-- 4. OPTIONAL FULL INVALIDATION (uncomment in environments that must cut
--    off the leaked defaults immediately; users then require an admin-set
--    temporary credential, since their old password no longer works):
--
-- UPDATE u
--    SET u.password_hash = 'DISABLED-BY-MIGRATION-04-' + CONVERT(VARCHAR(40), NEWID()),
--        u.must_change_password = 1
--   FROM dim_user u
--   JOIN @known_hashes k ON u.password_hash = k.hash;
--
-- (Re-run the DECLARE block above when using this section standalone.)

PRINT 'Migration 04 (forced password rotation) applied.';
PRINT 'Affected users must change their password at next login; the API';
PRINT 'blocks all other access until rotation completes (403 PASSWORD_ROTATION_REQUIRED).';
GO
