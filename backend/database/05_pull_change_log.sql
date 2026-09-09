-- ============================================================================
-- MIGRATION 05: PULL-SIDE DELTA SYNC (transactional change log / outbox)
--
-- The push path (sync_queue) is durable and idempotent, but devices had no
-- way to PULL server-side changes (routes, customers, dispatches, GRNs,
-- stock positions). This migration adds the download-side complement:
--
--   sync_change_log  - transactional outbox. Every service-layer write to a
--                     pull-relevant table emits a log row IN THE SAME
--                     TRANSACTION. change_key is the monotonic per-DB
--                     cursor devices page through; version_no is the
--                     per-entity monotonic version for stale-push detection
--                     and replay-safe client applies.
--   version_no      - per-row version columns on the pull-relevant tables,
--                     bumped on every service-layer write.
--   dim_route.updated_at - parity audit column: dim_route was the only
--                     PULL_DATASETS table without updated_at (dim_vehicle,
--                     dim_customer, dim_product, fact_dispatch, fact_grn all
--                     carry it). Guarded ADD + created_at backfill; pull
--                     payloads self-snapshot the full row, so routes now
--                     serialize the same last-touch timestamp as every other
--                     pull dataset.
--   retention proc  - sp_sync_change_log_retention purges log rows older
--                     than the retention window. A device whose cursor
--                     predates the oldest surviving row gets an explicit
--                     resetRequired from the pull API and re-bootstraps via
--                     cursor 0 (full current-state snapshot).
--
-- The sweeper job (services/changeLogService.sweepChanges) re-emits rows
-- whose version_no advanced but which are missing from the log (backstop
-- for writes that bypassed the service layer, e.g. manual SQL fixes).
--
-- GRANT FIXES (least-privilege deployments): the app login (renuzi_app)
-- needs more than SELECT on the new surface - changeLogService
--   .recordChange()    INSERTs into sync_change_log (outbox emit) and
--                      bumps version_no on the entity's table
--   .runRetention()    EXECUTEs sp_sync_change_log_retention
-- Section 7 grants exactly those: INSERT + SELECT on sync_change_log,
-- EXECUTE on the retention proc, and column-scoped UPDATE(version_no) on
-- the read-mostly dimensions that migration 03 left SELECT-only - all
-- guarded so dev databases running as sa (no renuzi_app) simply skip them
-- with a printed notice.
--
-- CALL SITES (service layer emits INSIDE their write transactions):
--   fleetService.startTrip/endTrip/recordFuelLog  -> VEHICLES (dim_vehicle;
--     migration 03's table-level UPDATE grant already covers version_no)
--   fleet routes: PUT vehicles/:key/odometer     -> VEHICLES
--   warehouseService.createGRN                   -> GRNS
--   warehouseService.signoffGRNFinance           -> GRNS
--   warehouseService.createDispatch              -> DISPATCHES
--   warehouseService.stampDispatchCustody       -> DISPATCHES (all stages)
--   jobs/grnAutoCloseJob.runGRNAutoClose         -> GRNS (escalation pass)
-- No additional grants are required for any of these: table-level UPDATE
-- from migration 03 covers dim_vehicle/fact_dispatch/fact_grn entirely,
-- and sync_change_log INSERT is granted in section 7 below.
--
-- IDEMPOTENT: every statement is guarded; safe to re-run.
-- ============================================================================

USE RenuziOpsDB;
GO
SET NOCOUNT ON;
GO

-- 1. The change log (transactional outbox)
IF OBJECT_ID('sync_change_log') IS NULL
BEGIN
    CREATE TABLE sync_change_log (
        change_key       BIGINT IDENTITY(1,1) PRIMARY KEY, -- monotonic pull cursor
        business_key     INT NOT NULL REFERENCES dim_business(business_key),
        entity_type      VARCHAR(50) NOT NULL,             -- PULL_DATASETS key: VEHICLES, ROUTES, CUSTOMERS, PRODUCTS, DISPATCHES, GRNS
        entity_key       INT NOT NULL,
        op               VARCHAR(10) NOT NULL,             -- UPSERT | DELETE (tombstone)
        version_no       BIGINT NOT NULL,                  -- per-entity monotonic version
        payload_json     NVARCHAR(MAX) NULL,               -- NULL for tombstones
        created_at       DATETIME2 NOT NULL DEFAULT GETDATE()
    );
END
GO

-- 2. Pull cursor index: (business, dataset, change_key) range scans
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_change_log_pull' AND object_id = OBJECT_ID('sync_change_log')
)
    CREATE INDEX IX_change_log_pull
        ON sync_change_log(business_key, entity_type, change_key)
        INCLUDE (op, version_no);
GO

-- 3. Sweeper backstop index: find the latest logged version per entity
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_change_log_entity_version' AND object_id = OBJECT_ID('sync_change_log')
)
    CREATE INDEX IX_change_log_entity_version
        ON sync_change_log(business_key, entity_type, entity_key, version_no DESC);
GO

-- 4. Per-entity version columns (bumped by every service-layer write).
--    Snapshot semantics: version 1 = row as created; every update bumps by 1.
IF COL_LENGTH('dim_route', 'version_no') IS NULL
    ALTER TABLE dim_route ADD version_no BIGINT NOT NULL DEFAULT 1;
IF COL_LENGTH('dim_customer', 'version_no') IS NULL
    ALTER TABLE dim_customer ADD version_no BIGINT NOT NULL DEFAULT 1;
IF COL_LENGTH('dim_product', 'version_no') IS NULL
    ALTER TABLE dim_product ADD version_no BIGINT NOT NULL DEFAULT 1;
IF COL_LENGTH('dim_vehicle', 'version_no') IS NULL
    ALTER TABLE dim_vehicle ADD version_no BIGINT NOT NULL DEFAULT 1;
IF COL_LENGTH('fact_dispatch', 'version_no') IS NULL
    ALTER TABLE fact_dispatch ADD version_no BIGINT NOT NULL DEFAULT 1;
IF COL_LENGTH('fact_grn', 'version_no') IS NULL
    ALTER TABLE fact_grn ADD version_no BIGINT NOT NULL DEFAULT 1;
GO

-- 4b. dim_route.updated_at: parity audit column for the ROUTES pull
--     dataset. Every other PULL_DATASETS table already carries updated_at
--     (see 01_create_database.sql); dim_route was the lone exception and
--     changeLogService.recordChange documents its absence. Three guarded
--     steps, each in its OWN GO batch (a batch compiles before executing,
--     so statements referencing the new column must not share the batch
--     that adds it):
--       1. ADD as NULL so existing rows can be backfilled from created_at
--          (their only last-touch proxy; ISNULL covers legacy rows with
--          NULL created_at) instead of a migration-time GETDATE().
--       2. Backfill. Guarded on updated_at IS NULL: a no-op on re-run
--          (and never stomps a real later-touched timestamp).
--       3. Tighten to NOT NULL, guarded on is_nullable so a re-run does
--          not re-take the schema-mod lock.
--       4. A separately guarded named DEFAULT (DF_dim_route_updated_at)
--          gives new rows a server-side last-touch timestamp, matching
--          dim_vehicle/dim_customer, so future INSERTs (route management,
--          manual fixes) never need to name the column. The guard checks
--          the COLUMN (not the constraint name) because a column admits
--          only one default.
--     Pull payloads self-snapshot the full row (recordChange), so ROUTES
--     change events now serialize the same last-touch timestamp as
--     VEHICLES/CUSTOMERS/PRODUCTS/DISPATCHES/GRNS.
IF COL_LENGTH('dim_route', 'updated_at') IS NULL
    ALTER TABLE dim_route ADD updated_at DATETIME2 NULL;
GO
UPDATE dim_route SET updated_at = ISNULL(created_at, GETDATE())
 WHERE updated_at IS NULL;
GO
IF EXISTS (
    SELECT 1 FROM sys.columns
     WHERE object_id = OBJECT_ID('dim_route') AND name = 'updated_at' AND is_nullable = 1
)
    ALTER TABLE dim_route ALTER COLUMN updated_at DATETIME2 NOT NULL;
GO
IF NOT EXISTS (
    SELECT 1 FROM sys.default_constraints dc
     WHERE dc.parent_object_id = OBJECT_ID('dim_route')
       AND dc.parent_column_id = COLUMNPROPERTY(OBJECT_ID('dim_route'), 'updated_at', 'ColumnId')
)
    ALTER TABLE dim_route ADD CONSTRAINT DF_dim_route_updated_at
        DEFAULT GETDATE() FOR updated_at;
GO

-- 5. Pull configuration seeds (page size + retention window)
IF NOT EXISTS (SELECT 1 FROM app_config WHERE config_name = 'SYNC_PULL_PAGE_SIZE')
    INSERT INTO app_config (config_name, config_value, config_group, description)
    VALUES ('SYNC_PULL_PAGE_SIZE', '200', 'SYNC', 'Max rows per pull page for mobile delta sync');
IF NOT EXISTS (SELECT 1 FROM app_config WHERE config_name = 'SYNC_CHANGE_LOG_RETENTION_DAYS')
    INSERT INTO app_config (config_name, config_value, config_group, description)
    VALUES ('SYNC_CHANGE_LOG_RETENTION_DAYS', '30', 'SYNC', 'Days to keep sync_change_log rows before retention purge');
GO

-- 6. Retention proc: purge log rows older than the retention window.
--    Returns the purged row count; the job logs it. Devices whose cursor
--    predates the new oldest change_key get resetRequired on next pull.
IF OBJECT_ID('sp_sync_change_log_retention') IS NULL
BEGIN
    EXEC('CREATE PROCEDURE sp_sync_change_log_retention AS SELECT 1'); -- shell for CREATE PROC guard
END
GO
ALTER PROCEDURE sp_sync_change_log_retention
    @retentionDays INT = NULL
AS
BEGIN
    SET NOCOUNT ON;
    DECLARE @days INT = @retentionDays;
    IF @days IS NULL
        SELECT @days = TRY_CAST(config_value AS INT)
          FROM app_config
         WHERE config_name = 'SYNC_CHANGE_LOG_RETENTION_DAYS';
    IF @days IS NULL OR @days < 0 SET @days = 30; -- negative input is invalid config, never "purge all"

    DECLARE @purged TABLE (change_key BIGINT);
    DELETE FROM sync_change_log
      OUTPUT deleted.change_key INTO @purged
     WHERE created_at < DATEADD(DAY, -@days, GETDATE());

    SELECT COUNT(*) AS purged FROM @purged;
END
GO

-- 7. Least-privilege grants for the new pull surface (mirror of migration 03
--    style). The app login needs THREE permissions, each tied to a concrete
--    call site in services/changeLogService.js:
--      INSERT  ON sync_change_log        - recordChange()/recordChangeStandalone()
--                                         emit the outbox row (INSERT ... OUTPUT
--                                         INSERTED.change_key)
--      SELECT  ON sync_change_log        - syncPullService delta pages,
--                                         sweepChanges() reconciliation,
--                                         oldestChangeKey() watermark
--      EXECUTE ON sp_sync_change_log_retention - runRetention() (scheduler /
--                                         ops purge pass)
--      UPDATE(version_no) ON dim_route, dim_customer, dim_product -
--                                         recordChange()'s atomic version
--                                         bump (UPDATE ... SET version_no =
--                                         version_no + 1 OUTPUT). Migration
--                                         03 granted table-level UPDATE only
--                                         where the push path needs it
--                                         (dim_vehicle, fact tables); the
--                                         three read-mostly dimensions got
--                                         SELECT only, so without this
--                                         grant the bump DENIED for the
--                                         ROUTES/CUSTOMERS/PRODUCTS pull
--                                         datasets under renuzi_app. The
--                                         grant is COLUMN-SCOPED: the app
--                                         can advance version_no but still
--                                         cannot alter route names,
--                                         customer credit limits, or
--                                         product prices.
--    No DELETE grant is needed: the retention proc DELETEs from
--    sync_change_log, but as a dbo-owned proc operating on a dbo-owned
--    table its statements are covered by ownership chaining - EXECUTE is
--    the only permission renuzi_app requires to trigger the purge.
--    Re-issuing the grants is a harmless no-op.
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'renuzi_app')
BEGIN
    GRANT INSERT, SELECT ON sync_change_log TO renuzi_app;
    GRANT EXECUTE ON sp_sync_change_log_retention TO renuzi_app;
    GRANT UPDATE ON dim_route(version_no) TO renuzi_app;
    GRANT UPDATE ON dim_customer(version_no) TO renuzi_app;
    GRANT UPDATE ON dim_product(version_no) TO renuzi_app;
END
ELSE
BEGIN
    PRINT 'renuzi_app user absent; run database/03_least_privilege.sql first. Skipping pull grants.';
END
GO

PRINT 'Migration 05 (pull-side delta sync change log) applied.';
GO
