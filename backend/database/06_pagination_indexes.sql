-- ============================================================================
-- MIGRATION 06: PAGINATION INDEXES + API LIST PAGE CONFIG SEEDS
--
-- The API's 14 list endpoints (fleet/warehouse/sync routes) all filter by
-- business_key and sort by a timestamp or ID column, but migration 01's
-- index set has NO leading business_key index on any fact table - every
-- list query is a table scan + sort, and the API's keyset/offset pagination
-- (see src/utils/pagination.js + route changes) has no index to seek.
--
-- This migration adds one composite index per list endpoint, ordered
-- (business_key, <sort column> DESC, <pk> DESC) so that:
--   - the leading business_key equality supports every TD-12 scoped query;
--   - the (sort DESC, pk DESC) tail makes the ORDER BY deterministic (no
--     tie-shuffling between pages when GETDATE() timestamps collide -
--     common during sync-batch processing) and gives keyset cursors a seek
--     target: (sort, pk) < (cursorSort, cursorKey) expands to an index
--     range scan, so every page costs O(limit), not O(offset).
--
-- Index strategy is SHARED by both pagination modes (keyset and offset), so
-- no index here is mode-specific. INCLUDE columns cover the list filters
-- (status, vehicle_key, etc.) so the same index serves filtered variants;
-- the SELECT-list join columns are deliberately NOT included - joins to
-- dim_vehicle/dim_user/dim_product go through their PK/UNIQUE indexes.
--
-- Two dimension pick-lists (dim_vehicle, dim_route) get (business_key,
-- <natural id>) indexes for their small ordered lists, and vw_stock_position
-- is backed via a fact_stock_movement (product_key, warehouse_location)
-- index with business_key/movement_type/quantity/created_at INCLUDED - the
-- view aggregates over exactly those columns.
--
-- sync_queue gains a (business_key, device_id) grouping index for
-- GET /api/sync/status (per-device GROUP BY) and sync_conflict_log gains a
-- (resolution, created_at DESC, conflict_key DESC) index for the pending
-- conflicts feed (listPendingConflicts filters resolution = 'PENDING').
--
-- Config seeds (app_config, guarded - re-runs are no-ops):
--   API_LIST_PAGE_SIZE - default page when the client sends no limit
--                        (50; mirrors the SYNC_PULL_PAGE_SIZE precedent)
--   API_LIST_MAX_PAGE  - hard cap on requested limit (200)
--   PAGINATION_MODE    - OFF | OFFSET | KEYSET rollout switch. KEYSET is
--                        the target state; OFF preserves the legacy
--                        full-list behavior for phased rollout.
--
-- IDEMPOTENT: every statement is guarded; safe to re-run.
-- ============================================================================

USE RenuziOpsDB;
GO
SET NOCOUNT ON;
GO

-- ============================================================================
-- 1. FLEET FACT LIST INDEXES
-- ============================================================================

-- GET /api/fleet/checks: business + check_datetime DESC, tiebreak check_key
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_fact_vehicle_check_business_check_date'
       AND object_id = OBJECT_ID('fact_vehicle_check')
)
    CREATE INDEX IX_fact_vehicle_check_business_check_date
        ON fact_vehicle_check(business_key, check_datetime DESC, check_key DESC)
        INCLUDE (vehicle_key, driver_key, check_status);
GO

-- GET /api/fleet/trips: business + trip_start_time DESC, tiebreak trip_key
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_fact_trip_business_start'
       AND object_id = OBJECT_ID('fact_trip')
)
    CREATE INDEX IX_fact_trip_business_start
        ON fact_trip(business_key, trip_start_time DESC, trip_key DESC)
        INCLUDE (vehicle_key, driver_key, route_key, trip_status);
GO

-- GET /api/fleet/fuel-requests: business + request_datetime DESC, tiebreak fuel_request_key
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_fact_fuel_request_business_requested'
       AND object_id = OBJECT_ID('fact_fuel_request')
)
    CREATE INDEX IX_fact_fuel_request_business_requested
        ON fact_fuel_request(business_key, request_datetime DESC, fuel_request_key DESC)
        INCLUDE (vehicle_key, driver_key, approval_status, approved_by_key);
GO

-- GET /api/fleet/maintenance: business + created_at DESC, tiebreak maintenance_key
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_fact_maintenance_business_created'
       AND object_id = OBJECT_ID('fact_maintenance')
)
    CREATE INDEX IX_fact_maintenance_business_created
        ON fact_maintenance(business_key, created_at DESC, maintenance_key DESC)
        INCLUDE (vehicle_key, reported_by_key, maintenance_status, priority, approval_status);
GO

-- ============================================================================
-- 2. WAREHOUSE FACT LIST INDEXES
-- ============================================================================

-- GET /api/warehouse/grn: business + created_at DESC, tiebreak grn_key
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_fact_grn_business_created'
       AND object_id = OBJECT_ID('fact_grn')
)
    CREATE INDEX IX_fact_grn_business_created
        ON fact_grn(business_key, created_at DESC, grn_key DESC)
        INCLUDE (supplier_key, received_by_key, receipt_status);
GO

-- GET /api/warehouse/dispatch: business + created_at DESC, tiebreak dispatch_key
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_fact_dispatch_business_created'
       AND object_id = OBJECT_ID('fact_dispatch')
)
    CREATE INDEX IX_fact_dispatch_business_created
        ON fact_dispatch(business_key, created_at DESC, dispatch_key DESC)
        INCLUDE (customer_key, driver_key, vehicle_key, dispatched_by_key, dispatch_status);
GO

-- GET /api/warehouse/movements: business + created_at DESC, tiebreak movement_key
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_fact_stock_movement_business_created'
       AND object_id = OBJECT_ID('fact_stock_movement')
)
    CREATE INDEX IX_fact_stock_movement_business_created
        ON fact_stock_movement(business_key, created_at DESC, movement_key DESC)
        INCLUDE (product_key, recorded_by_key, movement_type, warehouse_location);
GO

-- GET /api/warehouse/counts: business + created_at DESC, tiebreak count_key
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_fact_stock_count_business_created'
       AND object_id = OBJECT_ID('fact_stock_count')
)
    CREATE INDEX IX_fact_stock_count_business_created
        ON fact_stock_count(business_key, created_at DESC, count_key DESC)
        INCLUDE (product_key, counted_by_key, variance);
GO

-- GET /api/warehouse/returns: business + created_at DESC, tiebreak return_key
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_fact_goods_return_business_created'
       AND object_id = OBJECT_ID('fact_goods_return')
)
    CREATE INDEX IX_fact_goods_return_business_created
        ON fact_goods_return(business_key, created_at DESC, return_key DESC)
        INCLUDE (customer_key, product_key, returned_by_key, return_status);
GO

-- ============================================================================
-- 3. DIMENSION PICK-LISTS + STOCK POSITION VIEW
-- ============================================================================

-- GET /api/fleet/vehicles + GET /api/fleet/routes: small ordered pick-lists.
-- vehicle_id / route_id are the natural ascending sort; business_key lead
-- makes the scope + sort a single seek. assigned_driver_key /
-- assigned_vehicle_key are the join keys the routes need.
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_dim_vehicle_business_vehicle_id'
       AND object_id = OBJECT_ID('dim_vehicle')
)
    CREATE INDEX IX_dim_vehicle_business_vehicle_id
        ON dim_vehicle(business_key, vehicle_id)
        INCLUDE (assigned_driver_key);
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_dim_route_business_route_id'
       AND object_id = OBJECT_ID('dim_route')
)
    CREATE INDEX IX_dim_route_business_route_id
        ON dim_route(business_key, route_id)
        INCLUDE (assigned_vehicle_key);
GO

-- GET /api/warehouse/stock-position + /api/dashboard/stock-position read
-- vw_stock_position, which groups fact_stock_movement by (product_key,
-- warehouse_location) and sums movement_type-filtered quantities. Every
-- consumer scopes the view by business_key (TD-12), so business_key LEADS
-- the key: the aggregate becomes a covered seek per business, and each
-- (product, location) group is contiguous within it.
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_fact_stock_movement_product_location'
       AND object_id = OBJECT_ID('fact_stock_movement')
)
    CREATE INDEX IX_fact_stock_movement_product_location
        ON fact_stock_movement(business_key, product_key, warehouse_location)
        INCLUDE (movement_type, quantity, created_at);
GO

-- ============================================================================
-- 4. SYNC FEED INDEXES
-- ============================================================================

-- GET /api/sync/status: per-device GROUP BY over business-scoped rows
-- (getQueueStatus). (business_key, device_id) leads the grouping; the
-- INCLUDE covers the CASE/SUM/MAX aggregate columns so the whole grouped
-- read is covered.
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_sync_queue_business_device'
       AND object_id = OBJECT_ID('sync_queue')
)
    CREATE INDEX IX_sync_queue_business_device
        ON sync_queue(business_key, device_id)
        INCLUDE (sync_status, created_at, processed_at);
GO

-- GET /api/sync/conflicts: pending-conflict feed (listPendingConflicts)
-- filters resolution = 'PENDING' and sorts created_at DESC. The PK
-- tiebreak keeps keyset pages deterministic. The NVARCHAR(MAX) version
-- JSON columns are deliberately NOT included: key-lookup to the base row
-- for 50 feed rows is cheap, while duplicating every payload into the
-- index leaf on every insert would tax the conflict path (writes are the
-- rare event this feed exists for). Migration 02's
-- IX_sync_conflict_resolution(resolution, created_at) stays valid for the
-- un-tiebroken form.
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
     WHERE name = 'IX_sync_conflict_log_pending_feed'
       AND object_id = OBJECT_ID('sync_conflict_log')
)
    CREATE INDEX IX_sync_conflict_log_pending_feed
        ON sync_conflict_log(resolution, created_at DESC, conflict_key DESC)
        INCLUDE (queue_id, entity_type, entity_key);
GO

-- ============================================================================
-- 5. API LIST PAGINATION CONFIG SEEDS (app_config)
-- ============================================================================

IF NOT EXISTS (SELECT 1 FROM app_config WHERE config_name = 'API_LIST_PAGE_SIZE')
    INSERT INTO app_config (config_name, config_value, config_group, description)
    VALUES ('API_LIST_PAGE_SIZE', '50', 'GENERAL',
            'Default page size for API list endpoints when the client sends no limit');
GO

IF NOT EXISTS (SELECT 1 FROM app_config WHERE config_name = 'API_LIST_MAX_PAGE')
    INSERT INTO app_config (config_name, config_value, config_group, description)
    VALUES ('API_LIST_MAX_PAGE', '200', 'GENERAL',
            'Hard cap on the limit query parameter for API list endpoints (max page size)');
GO

IF NOT EXISTS (SELECT 1 FROM app_config WHERE config_name = 'PAGINATION_MODE')
    INSERT INTO app_config (config_name, config_value, config_group, description)
    VALUES ('PAGINATION_MODE', 'KEYSET', 'GENERAL',
            'List pagination mode: OFF (legacy full lists), OFFSET, or KEYSET (default)');
GO

PRINT 'Migration 06 (pagination indexes + API list config seeds) applied.';
GO
