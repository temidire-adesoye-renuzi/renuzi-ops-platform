-- ============================================================================
-- MIGRATION 02: SYNC QUEUE INFRASTRUCTURE (v2)
-- Adds the columns the hardened queue engine requires:
--
--   claimed_at / claimed_by     - atomic-claim bookkeeping (multi-instance)
--   next_retry_at               - exponential backoff scheduling
--   client_ref                  - promoted to a real column (was JSON-only)
--                                 so the unique filtered index is honored
--   must_change_password /
--   password_changed_at          - forced rotation remediation (migration 04
--                                 depends on these)
--
-- Also grants the sync_conflict_log a queue-status index for the
-- reconciliation feed, and adds the DEAD_LETTER status documentation.
--
-- IDEMPOTENT: every statement is guarded; safe to re-run.
-- ============================================================================

USE RenuziOpsDB;
GO
SET NOCOUNT ON;
GO

-- 1. client_ref: promote to column so the unique filtered index works.
--    (Backfills from payload JSON where possible.)
IF COL_LENGTH('sync_queue', 'client_ref') IS NULL
    ALTER TABLE sync_queue ADD client_ref VARCHAR(100);
GO

-- Backfill client_ref from payload JSON for legacy rows (best-effort)
UPDATE sync_queue
   SET client_ref = TRY_CAST(JSON_VALUE(payload_json, '$.clientRef') AS NVARCHAR(100))
 WHERE client_ref IS NULL
   AND JSON_VALUE(payload_json, '$.clientRef') IS NOT NULL;
GO

-- 2. The unique filtered index on client_ref (idempotency backstop).
--    NOTE: the original script already contains UX_sync_queue_client_ref
--    on (device_id, user_key, entity_type, client_ref); create-if-missing
--    here for databases predating it.
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'UX_sync_queue_client_ref' AND object_id = OBJECT_ID('sync_queue')
)
    CREATE UNIQUE INDEX UX_sync_queue_client_ref
        ON sync_queue(device_id, user_key, entity_type, client_ref)
        WHERE client_ref IS NOT NULL;
GO

-- 3. Claim bookkeeping + backoff scheduling
IF COL_LENGTH('sync_queue', 'claimed_at') IS NULL
    ALTER TABLE sync_queue ADD claimed_at DATETIME2;
IF COL_LENGTH('sync_queue', 'claimed_by') IS NULL
    ALTER TABLE sync_queue ADD claimed_by VARCHAR(100);
IF COL_LENGTH('sync_queue', 'next_retry_at') IS NULL
    ALTER TABLE sync_queue ADD next_retry_at DATETIME2;
GO

-- 4. Index supporting the atomic claim predicate
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_sync_queue_claim' AND object_id = OBJECT_ID('sync_queue')
)
    CREATE INDEX IX_sync_queue_claim
        ON sync_queue(business_key, sync_status, next_retry_at)
        INCLUDE (retry_count, claimed_at);
GO

-- 5. Conflict feed: resolution-aware listing
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_sync_conflict_resolution' AND object_id = OBJECT_ID('sync_conflict_log')
)
    CREATE INDEX IX_sync_conflict_resolution
        ON sync_conflict_log(resolution, created_at);
GO

-- 6. Password rotation columns (used by migration 04 and the auth middleware)
IF COL_LENGTH('dim_user', 'must_change_password') IS NULL
    ALTER TABLE dim_user ADD must_change_password BIT NOT NULL DEFAULT 0;
IF COL_LENGTH('dim_user', 'password_changed_at') IS NULL
    ALTER TABLE dim_user ADD password_changed_at DATETIME2;
GO

-- 7. Status documentation: sync_status now includes DEAD_LETTER (rows that
--    exhausted their retry budget - the old code's CASE bug marked
--    everything FAILED forever; the app now distinguishes them).
IF NOT EXISTS (
    SELECT 1 FROM sys.extended_properties
     WHERE major_id = OBJECT_ID('sync_queue')
       AND name = 'MS_Description'
)
    EXEC sp_addextendedproperty
         @name = N'MS_Description',
         @value = N'PENDING, PROCESSING, SYNCED, FAILED (retryable), CONFLICT, DEAD_LETTER (terminal after retry exhaustion)',
         @level0type = N'SCHEMA', @level0name = N'dbo',
         @level1type = N'TABLE',  @level1name = N'sync_queue',
         @level2type = N'COLUMN', @level2name = N'sync_status';
GO

-- 8. Reset any legacy rows stuck in PROCESSING from the old soft-claim code
UPDATE sync_queue
   SET sync_status = 'PENDING',
       error_message = 'Reclaimed by migration 02 (legacy soft-claim stuck row)'
 WHERE sync_status = 'PROCESSING';
GO

PRINT 'Migration 02 (sync queue infrastructure) applied.';
GO
