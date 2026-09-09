-- ============================================================================
--
--  RENUZI OPERATIONS PLATFORM
--  SQL Server 2022 Database Schema (FIXED REVISION)
--  Kimball-Style Star Schema for Fleet + Warehouse
--  Pilot Business: Single KD (replicate pattern for remaining 9 KDs)
--
--  FIXES APPLIED IN THIS REVISION:
--  - Seed hash fix: real bcrypt hashes (old placeholder hashes were invalid
--    and made every seed user permanently unable to log in).
--  - TD-6: dim_vehicle.status comment now includes ON_ROUTE.
--  - TD-12: views and sync queries carry business_key so the API can scope
--    every read to the caller's business.
--  - TD-13: dim_vehicle.current_odometer has a CHECK constraint floor at 0;
--    monotonicity is enforced in the API layer.
--  - TD-16: guarded dim_date population (only inserts dates that do not
--    already exist, so re-running the script never duplicates or crashes).
--  - sync_queue: added client_ref column + unique filtered index for
--    idempotent mobile pushes (safe retries over flaky networks).
--  - Active-trip detection index (vehicle_key + trip_status) so
--    "vehicle already has an active trip" checks are fast.
--  - Password note: hashes below correspond to the DEFAULT PILOT
--    passwords listed in the comments. CHANGE THEM AFTER FIRST LOGIN.
--
-- ============================================================================

-- ============================================================================
-- STEP 1: CREATE THE DATABASE
-- Run this in SSMS as Administrator
-- ============================================================================
IF NOT EXISTS (SELECT name FROM sys.databases WHERE name = 'RenuziOpsDB')
    CREATE DATABASE RenuziOpsDB;
GO
USE RenuziOpsDB;
GO

-- ============================================================================
-- STEP 2: DIMENSION TABLES (The 'Who, What, Where, When, Why')
-- ============================================================================

-- 2.1 DATE DIMENSION (Power BI loves this)
CREATE TABLE dim_date (
    date_key            INT PRIMARY KEY,      -- YYYYMMDD format
    full_date           DATE NOT NULL,
    calendar_year       INT NOT NULL,
    calendar_quarter    INT NOT NULL,
    calendar_month      INT NOT NULL,
    month_name          VARCHAR(10) NOT NULL,
    month_name_short    VARCHAR(3) NOT NULL,
    week_of_year        INT NOT NULL,
    day_of_week         INT NOT NULL,
    day_name            VARCHAR(10) NOT NULL,
    day_name_short      VARCHAR(3) NOT NULL,
    is_weekend          BIT NOT NULL DEFAULT 0,
    fiscal_year         INT,
    fiscal_quarter      INT,
    is_holiday          BIT NOT NULL DEFAULT 0,
    holiday_name        VARCHAR(50)
);
GO

-- 2.2 BUSINESS DIMENSION (The 10 KDs + Parent)
CREATE TABLE dim_business (
    business_key        INT IDENTITY(1,1) PRIMARY KEY,
    business_id         VARCHAR(20) NOT NULL UNIQUE,   -- e.g. 'KD-KETU'
    business_name       VARCHAR(100) NOT NULL,          -- e.g. 'Renuzi Ketu'
    business_type       VARCHAR(20) NOT NULL DEFAULT 'KD', -- KD, PARENT, PARTNER
    region              VARCHAR(50),
    address             VARCHAR(255),
    contact_phone       VARCHAR(20),
    contact_email       VARCHAR(100),
    is_active           BIT NOT NULL DEFAULT 1,
    created_at          DATETIME2 DEFAULT GETDATE(),
    updated_at          DATETIME2 DEFAULT GETDATE()
);
GO

-- 2.3 USER DIMENSION (Drivers, Warehouse Staff, Managers, etc.)
CREATE TABLE dim_user (
    user_key            INT IDENTITY(1,1) PRIMARY KEY,
    user_id             VARCHAR(50) NOT NULL UNIQUE,    -- e.g. 'DRV-001'
    business_key        INT NOT NULL REFERENCES dim_business(business_key),
    full_name           VARCHAR(100) NOT NULL,
    email               VARCHAR(100),
    phone               VARCHAR(20),
    role                VARCHAR(30) NOT NULL,          -- DRIVER, FLEET_MANAGER, WAREHOUSE_MANAGER, WAREHOUSE_STAFF, OPS_MANAGER, SECURITY, ADMIN
    department          VARCHAR(30) NOT NULL,          -- FLEET, WAREHOUSE, OPERATIONS, FINANCE
    license_number      VARCHAR(50),                   -- For drivers only
    license_expiry      DATE,                          -- For drivers only
    password_hash       VARCHAR(255) NOT NULL,         -- bcrypt hash
    is_active           BIT NOT NULL DEFAULT 1,
    created_at          DATETIME2 DEFAULT GETDATE(),
    updated_at          DATETIME2 DEFAULT GETDATE()
);
GO

-- 2.4 VEHICLE DIMENSION (Fleet-specific)
-- TD-6 fix: status enum documented to include ON_ROUTE, matching the API's
-- VEHICLE_STATUS constant (ACTIVE, IN_WORKSHOP, ON_ROUTE, RETIRED, SOLD).
CREATE TABLE dim_vehicle (
    vehicle_key         INT IDENTITY(1,1) PRIMARY KEY,
    vehicle_id          VARCHAR(20) NOT NULL UNIQUE,   -- e.g. 'VAN-001'
    business_key        INT NOT NULL REFERENCES dim_business(business_key),
    plate_number        VARCHAR(20) NOT NULL,
    make                VARCHAR(50),
    model               VARCHAR(50),
    year_manufactured   INT,
    capacity_kg         DECIMAL(10,2),
    fuel_type           VARCHAR(20) DEFAULT 'PETROL',
    assigned_driver_key INT REFERENCES dim_user(user_key),
    -- TD-13: odometer cannot be negative; monotonicity is enforced by the API
    current_odometer    DECIMAL(10,2) DEFAULT 0 CHECK (current_odometer >= 0),
    status              VARCHAR(20) DEFAULT 'ACTIVE',   -- ACTIVE, IN_WORKSHOP, ON_ROUTE, RETIRED, SOLD
    registration_expiry DATE,
    insurance_expiry    DATE,
    last_service_date   DATE,
    next_service_due    DATE,
    is_active           BIT NOT NULL DEFAULT 1,
    created_at          DATETIME2 DEFAULT GETDATE(),
    updated_at          DATETIME2 DEFAULT GETDATE()
);
GO

-- 2.5 ROUTE DIMENSION (Fleet - delivery routes)
CREATE TABLE dim_route (
    route_key           INT IDENTITY(1,1) PRIMARY KEY,
    route_id            VARCHAR(20) NOT NULL UNIQUE,    -- e.g. 'RT-KETU-A'
    business_key        INT NOT NULL REFERENCES dim_business(business_key),
    route_name          VARCHAR(100) NOT NULL,
    region              VARCHAR(50),
    neighborhood        VARCHAR(100),
    estimated_distance_km DECIMAL(8,2),
    estimated_stores    INT,
    assigned_vehicle_key INT REFERENCES dim_vehicle(vehicle_key),
    is_active           BIT NOT NULL DEFAULT 1,
    created_at          DATETIME2 DEFAULT GETDATE()
);
GO

-- 2.6 PRODUCT/SKU DIMENSION
CREATE TABLE dim_product (
    product_key         INT IDENTITY(1,1) PRIMARY KEY,
    product_id          VARCHAR(50) NOT NULL UNIQUE,   -- e.g. 'SKU-COKE-33CL-24'
    business_key        INT NOT NULL REFERENCES dim_business(business_key),
    sku_code            VARCHAR(50) NOT NULL,
    product_name        VARCHAR(200) NOT NULL,
    brand               VARCHAR(50),
    manufacturer        VARCHAR(100),
    category            VARCHAR(50),
    sub_category        VARCHAR(50),
    pack_size           VARCHAR(20),
    unit_of_measure     VARCHAR(20) DEFAULT 'CASE',    -- CASE, UNIT, CARTON, PALLET
    units_per_case      INT DEFAULT 1,
    weight_kg           DECIMAL(8,3),
    unit_cost           DECIMAL(12,2),
    selling_price       DECIMAL(12,2),
    is_active           BIT NOT NULL DEFAULT 1,
    created_at          DATETIME2 DEFAULT GETDATE(),
    updated_at          DATETIME2 DEFAULT GETDATE()
);
GO

-- 2.7 CUSTOMER DIMENSION (For warehouse dispatch tracking)
CREATE TABLE dim_customer (
    customer_key        INT IDENTITY(1,1) PRIMARY KEY,
    customer_id         VARCHAR(50) NOT NULL UNIQUE,   -- e.g. 'CUST-001'
    business_key        INT NOT NULL REFERENCES dim_business(business_key),
    customer_name       VARCHAR(200) NOT NULL,
    customer_type       VARCHAR(30) NOT NULL DEFAULT 'RETAIL', -- WHOLESALER, RETAIL, SUB_DISTRIBUTOR, WALK_IN
    contact_person      VARCHAR(100),
    phone               VARCHAR(20),
    email               VARCHAR(100),
    address             VARCHAR(255),
    region              VARCHAR(50),
    neighborhood        VARCHAR(100),
    credit_limit        DECIMAL(12,2) DEFAULT 0,
    payment_terms_days  INT DEFAULT 0,
    is_active           BIT NOT NULL DEFAULT 1,
    created_at          DATETIME2 DEFAULT GETDATE(),
    updated_at          DATETIME2 DEFAULT GETDATE()
);
GO

-- 2.8 SUPPLIER DIMENSION (For warehouse receiving)
CREATE TABLE dim_supplier (
    supplier_key        INT IDENTITY(1,1) PRIMARY KEY,
    supplier_id         VARCHAR(50) NOT NULL UNIQUE,
    supplier_name       VARCHAR(200) NOT NULL,
    contact_person      VARCHAR(100),
    phone               VARCHAR(20),
    email               VARCHAR(100),
    address             VARCHAR(255),
    is_active           BIT NOT NULL DEFAULT 1,
    created_at          DATETIME2 DEFAULT GETDATE()
);
GO

-- ============================================================================
-- STEP 3: FLEET FACT TABLES
-- ============================================================================

-- 3.1 FACT: VEHICLE DAILY CHECKS
CREATE TABLE fact_vehicle_check (
    check_key           INT IDENTITY(1,1) PRIMARY KEY,
    business_key        INT NOT NULL REFERENCES dim_business(business_key),
    vehicle_key         INT NOT NULL REFERENCES dim_vehicle(vehicle_key),
    driver_key          INT NOT NULL REFERENCES dim_user(user_key),
    date_key            INT NOT NULL REFERENCES dim_date(date_key),
    check_datetime      DATETIME2 NOT NULL DEFAULT GETDATE(),
    latitude            DECIMAL(10,6),
    longitude           DECIMAL(10,6),
    tires_ok            BIT NOT NULL DEFAULT 0,
    lights_ok           BIT NOT NULL DEFAULT 0,
    brakes_ok           BIT NOT NULL DEFAULT 0,
    engine_ok           BIT NOT NULL DEFAULT 0,
    oil_level_ok        BIT NOT NULL DEFAULT 0,
    coolant_ok           BIT NOT NULL DEFAULT 0,
    wipers_ok           BIT NOT NULL DEFAULT 0,
    mirrors_ok          BIT NOT NULL DEFAULT 0,
    seatbelts_ok        BIT NOT NULL DEFAULT 0,
    fire_extinguisher_ok BIT NOT NULL DEFAULT 0,
    first_aid_kit_ok    BIT NOT NULL DEFAULT 0,
    has_damage          BIT NOT NULL DEFAULT 0,
    damage_description  VARCHAR(500),
    damage_photo_url    VARCHAR(500),
    check_status        VARCHAR(20) DEFAULT 'PASS',  -- PASS, FAIL, PASS_WITH_ISSUES
    supervisor_notes    VARCHAR(500),
    created_at          DATETIME2 DEFAULT GETDATE(),
    sync_timestamp      DATETIME2,
    mobile_device_id    VARCHAR(100)
);
GO

-- 3.2 FACT: TRIP LOGS
-- STATUS FLOW: PLANNED -> STARTED -> IN_PROGRESS -> COMPLETED -> CANCELLED
CREATE TABLE fact_trip (
    trip_key            INT IDENTITY(1,1) PRIMARY KEY,
    business_key        INT NOT NULL REFERENCES dim_business(business_key),
    vehicle_key         INT NOT NULL REFERENCES dim_vehicle(vehicle_key),
    driver_key          INT NOT NULL REFERENCES dim_user(user_key),
    route_key           INT REFERENCES dim_route(route_key),
    date_key            INT NOT NULL REFERENCES dim_date(date_key),
    trip_start_time     DATETIME2 NOT NULL,
    start_odometer      DECIMAL(10,2) NOT NULL,
    start_latitude      DECIMAL(10,6),
    start_longitude     DECIMAL(10,6),
    trip_end_time       DATETIME2,
    end_odometer        DECIMAL(10,2),
    end_latitude        DECIMAL(10,6),
    end_longitude       DECIMAL(10,6),
    distance_km         DECIMAL(10,2),
    stores_visited      INT DEFAULT 0,
    stores_planned      INT DEFAULT 0,
    delivery_success_count INT DEFAULT 0,
    delivery_fail_count INT DEFAULT 0,
    trip_status         VARCHAR(20) DEFAULT 'PLANNED',
    driver_notes        VARCHAR(500),
    supervisor_notes    VARCHAR(500),
    created_at          DATETIME2 DEFAULT GETDATE(),
    updated_at          DATETIME2 DEFAULT GETDATE(),
    sync_timestamp      DATETIME2,
    mobile_device_id    VARCHAR(100)
);
GO

-- 3.3 FACT: FUEL REQUESTS
CREATE TABLE fact_fuel_request (
    fuel_request_key    INT IDENTITY(1,1) PRIMARY KEY,
    business_key        INT NOT NULL REFERENCES dim_business(business_key),
    vehicle_key         INT NOT NULL REFERENCES dim_vehicle(vehicle_key),
    driver_key          INT NOT NULL REFERENCES dim_user(user_key),
    date_key            INT NOT NULL REFERENCES dim_date(date_key),
    request_datetime    DATETIME2 NOT NULL DEFAULT GETDATE(),
    request_type        VARCHAR(20) NOT NULL DEFAULT 'CASH', -- CASH, FUEL_CARD, EMERGENCY
    amount_requested    DECIMAL(12,2),
    liters_requested    DECIMAL(8,2),
    reason              VARCHAR(255),
    approval_status     VARCHAR(20) DEFAULT 'PENDING', -- PENDING, APPROVED, REJECTED
    approved_by_key     INT REFERENCES dim_user(user_key),
    approved_datetime   DATETIME2,
    approval_notes      VARCHAR(255),
    disbursed_amount    DECIMAL(12,2),
    disbursed_by_key    INT REFERENCES dim_user(user_key),
    disbursement_datetime DATETIME2,
    receipt_photo_url   VARCHAR(500),
    transfer_receipt_url VARCHAR(500),
    created_at          DATETIME2 DEFAULT GETDATE(),
    sync_timestamp      DATETIME2,
    mobile_device_id    VARCHAR(100)
);
GO

-- 3.4 FACT: FUEL LOGS
CREATE TABLE fact_fuel_log (
    fuel_log_key        INT IDENTITY(1,1) PRIMARY KEY,
    business_key        INT NOT NULL REFERENCES dim_business(business_key),
    vehicle_key         INT NOT NULL REFERENCES dim_vehicle(vehicle_key),
    driver_key          INT NOT NULL REFERENCES dim_user(user_key),
    fuel_request_key    INT REFERENCES fact_fuel_request(fuel_request_key),
    date_key            INT NOT NULL REFERENCES dim_date(date_key),
    refuel_datetime     DATETIME2 NOT NULL DEFAULT GETDATE(),
    odometer_reading    DECIMAL(10,2) NOT NULL,
    liters_filled       DECIMAL(8,2) NOT NULL,
    cost_per_liter      DECIMAL(8,2),
    total_cost          DECIMAL(12,2),
    station_name        VARCHAR(100),
    receipt_photo_url   VARCHAR(500),
    km_since_last_refuel DECIMAL(10,2),
    liters_per_100km    DECIMAL(8,2),
    created_at          DATETIME2 DEFAULT GETDATE(),
    sync_timestamp      DATETIME2,
    mobile_device_id    VARCHAR(100)
);
GO

-- 3.5 FACT: MAINTENANCE & REPAIRS
-- WORKFLOW (TD-7): PENDING -> OPS_APPROVED -> MD_APPROVED (only when
-- estimated_cost > MAINTENANCE_MD_THRESHOLD). OPS approval alone finalises
-- tickets within the threshold.
CREATE TABLE fact_maintenance (
    maintenance_key     INT IDENTITY(1,1) PRIMARY KEY,
    business_key        INT NOT NULL REFERENCES dim_business(business_key),
    vehicle_key         INT NOT NULL REFERENCES dim_vehicle(vehicle_key),
    reported_by_key     INT NOT NULL REFERENCES dim_user(user_key),
    date_key            INT NOT NULL REFERENCES dim_date(date_key),
    maintenance_type    VARCHAR(30) NOT NULL,          -- SCHEDULED, REPAIR, ACCIDENT, INSPECTION
    priority            VARCHAR(20) DEFAULT 'MEDIUM',  -- LOW, MEDIUM, HIGH, CRITICAL
    description         VARCHAR(500) NOT NULL,
    estimated_cost      DECIMAL(12,2),
    actual_cost         DECIMAL(12,2),
    approval_status     VARCHAR(20) DEFAULT 'PENDING', -- PENDING, OPS_APPROVED, MD_APPROVED, REJECTED
    ops_approved_by_key INT REFERENCES dim_user(user_key),
    ops_approved_datetime DATETIME2,
    md_approved_by_key  INT REFERENCES dim_user(user_key),
    md_approved_datetime DATETIME2,
    vendor_name         VARCHAR(100),
    work_start_date     DATE,
    work_completion_date DATE,
    invoice_number      VARCHAR(50),
    invoice_photo_url   VARCHAR(500),
    receipt_photo_url   VARCHAR(500),
    maintenance_status  VARCHAR(20) DEFAULT 'OPEN',    -- OPEN, IN_PROGRESS, COMPLETED, CANCELLED
    completion_notes    VARCHAR(500),
    created_at          DATETIME2 DEFAULT GETDATE(),
    updated_at          DATETIME2 DEFAULT GETDATE(),
    sync_timestamp      DATETIME2,
    mobile_device_id    VARCHAR(100)
);
GO

-- 3.6 FACT: DRIVER INCIDENTS
CREATE TABLE fact_driver_incident (
    incident_key        INT IDENTITY(1,1) PRIMARY KEY,
    business_key        INT NOT NULL REFERENCES dim_business(business_key),
    driver_key          INT NOT NULL REFERENCES dim_user(user_key),
    vehicle_key         INT REFERENCES dim_vehicle(vehicle_key),
    date_key            INT NOT NULL REFERENCES dim_date(date_key),
    incident_type       VARCHAR(30) NOT NULL,          -- LATENESS, THEFT, DAMAGE, BAD_BEHAVIOR, ACCIDENT, PERFORMANCE_GAP
    severity            VARCHAR(20) DEFAULT 'LOW',    -- LOW, MEDIUM, HIGH
    description         VARCHAR(500) NOT NULL,
    reported_by_key     INT NOT NULL REFERENCES dim_user(user_key),
    witness_notes       VARCHAR(500),
    action_taken        VARCHAR(50),                   -- VERBAL_WARNING, WRITTEN_WARNING, SUSPENSION, HR_REFERRAL
    action_date         DATE,
    is_resolved         BIT NOT NULL DEFAULT 0,
    resolution_notes    VARCHAR(500),
    created_at          DATETIME2 DEFAULT GETDATE(),
    sync_timestamp      DATETIME2,
    mobile_device_id    VARCHAR(100)
);
GO

-- ============================================================================
-- STEP 4: WAREHOUSE FACT TABLES
-- ============================================================================

-- 4.1 FACT: GOODS RECEIPT NOTE (GRN)
CREATE TABLE fact_grn (
    grn_key             INT IDENTITY(1,1) PRIMARY KEY,
    business_key        INT NOT NULL REFERENCES dim_business(business_key),
    supplier_key        INT REFERENCES dim_supplier(supplier_key),
    received_by_key     INT NOT NULL REFERENCES dim_user(user_key),
    date_key            INT NOT NULL REFERENCES dim_date(date_key),
    grn_number          VARCHAR(50) NOT NULL UNIQUE,   -- Auto-generated: GRN-KETU-20260829-001
    waybill_number      VARCHAR(50),
    invoice_number      VARCHAR(50),
    truck_plate_number  VARCHAR(20),
    driver_name         VARCHAR(100),
    seal_number         VARCHAR(50),
    seal_intact         BIT NOT NULL DEFAULT 0,
    seal_broken_datetime DATETIME2,
    seal_broken_in_presence_of VARCHAR(100),
    receipt_status      VARCHAR(20) DEFAULT 'PENDING', -- PENDING, PARTIAL, COMPLETE, REJECTED
    total_invoice_qty   INT,
    total_received_qty  INT,
    total_rejected_qty  INT,
    rejection_reason    VARCHAR(500),
    finance_signoff     BIT NOT NULL DEFAULT 0,
    finance_signoff_by_key INT REFERENCES dim_user(user_key),
    finance_signoff_datetime DATETIME2,
    credit_note_issued  BIT NOT NULL DEFAULT 0,
    credit_note_number  VARCHAR(50),
    created_at          DATETIME2 DEFAULT GETDATE(),
    updated_at          DATETIME2 DEFAULT GETDATE(),
    sync_timestamp      DATETIME2,
    mobile_device_id    VARCHAR(100)
);
GO

-- 4.2 FACT: GRN LINE ITEMS
CREATE TABLE fact_grn_line (
    grn_line_key        INT IDENTITY(1,1) PRIMARY KEY,
    grn_key             INT NOT NULL REFERENCES fact_grn(grn_key),
    product_key         INT NOT NULL REFERENCES dim_product(product_key),
    invoice_qty         INT NOT NULL DEFAULT 0,
    received_qty        INT NOT NULL DEFAULT 0,
    rejected_qty        INT NOT NULL DEFAULT 0,
    production_date     DATE,
    expiry_date         DATE,
    batch_number        VARCHAR(50),
    is_damaged          BIT NOT NULL DEFAULT 0,
    is_expired          BIT NOT NULL DEFAULT 0,
    is_near_expiry      BIT NOT NULL DEFAULT 0,
    near_expiry_days    INT,
    rejection_reason    VARCHAR(255),
    allocated_location  VARCHAR(50),
    fifo_compliant      BIT NOT NULL DEFAULT 0,
    created_at          DATETIME2 DEFAULT GETDATE(),
    sync_timestamp      DATETIME2
);
GO

-- 4.3 FACT: DISPATCH / OUTBOUND DELIVERY
-- CUSTODY CHAIN: warehouse_stamp -> security_stamp -> driver_ack -> customer_ack
CREATE TABLE fact_dispatch (
    dispatch_key        INT IDENTITY(1,1) PRIMARY KEY,
    business_key        INT NOT NULL REFERENCES dim_business(business_key),
    customer_key        INT NOT NULL REFERENCES dim_customer(customer_key),
    dispatched_by_key   INT NOT NULL REFERENCES dim_user(user_key),
    driver_key          INT REFERENCES dim_user(user_key),
    vehicle_key         INT REFERENCES dim_vehicle(vehicle_key),
    date_key            INT NOT NULL REFERENCES dim_date(date_key),
    dispatch_number     VARCHAR(50) NOT NULL UNIQUE,   -- Auto-generated: DSP-KETU-20260829-001
    invoice_number      VARCHAR(50) NOT NULL,
    warehouse_stamp     BIT NOT NULL DEFAULT 0,
    warehouse_signed_by_key INT REFERENCES dim_user(user_key),
    warehouse_sign_datetime DATETIME2,
    security_stamp      BIT NOT NULL DEFAULT 0,
    security_signed_by_key INT REFERENCES dim_user(user_key),
    security_sign_datetime DATETIME2,
    driver_acknowledged BIT NOT NULL DEFAULT 0,
    driver_ack_datetime DATETIME2,
    driver_signature_url VARCHAR(500),
    dispatch_status     VARCHAR(20) DEFAULT 'PENDING', -- PENDING, PICKED, LOADED, IN_TRANSIT, DELIVERED, RETURNED
    delivery_datetime   DATETIME2,
    customer_acknowledged BIT NOT NULL DEFAULT 0,
    customer_signature_url VARCHAR(500),
    return_reason       VARCHAR(255),
    created_at          DATETIME2 DEFAULT GETDATE(),
    updated_at          DATETIME2 DEFAULT GETDATE(),
    sync_timestamp      DATETIME2,
    mobile_device_id    VARCHAR(100)
);
GO

-- 4.4 FACT: DISPATCH LINE ITEMS
CREATE TABLE fact_dispatch_line (
    dispatch_line_key   INT IDENTITY(1,1) PRIMARY KEY,
    dispatch_key        INT NOT NULL REFERENCES fact_dispatch(dispatch_key),
    product_key         INT NOT NULL REFERENCES dim_product(product_key),
    invoice_qty         INT NOT NULL DEFAULT 0,
    picked_qty          INT NOT NULL DEFAULT 0,
    loaded_qty          INT NOT NULL DEFAULT 0,
    delivered_qty       INT NOT NULL DEFAULT 0,
    returned_qty        INT NOT NULL DEFAULT 0,
    unit_price          DECIMAL(12,2),
    line_total          DECIMAL(12,2),
    created_at          DATETIME2 DEFAULT GETDATE(),
    sync_timestamp      DATETIME2
);
GO

-- 4.5 FACT: STOCK MOVEMENTS
CREATE TABLE fact_stock_movement (
    movement_key        INT IDENTITY(1,1) PRIMARY KEY,
    business_key        INT NOT NULL REFERENCES dim_business(business_key),
    product_key         INT NOT NULL REFERENCES dim_product(product_key),
    warehouse_location  VARCHAR(50),
    date_key            INT NOT NULL REFERENCES dim_date(date_key),
    movement_type       VARCHAR(30) NOT NULL,          -- RECEIPT, DISPATCH, TRANSFER_IN, TRANSFER_OUT, ADJUSTMENT, DAMAGED, EXPIRED, COUNT
    reference_key       INT,                           -- Links to grn_key, dispatch_key, etc.
    reference_type      VARCHAR(20),                   -- GRN, DISPATCH, TRANSFER, ADJUSTMENT, RETURN
    quantity            INT NOT NULL,
    unit_cost           DECIMAL(12,2),
    total_value         DECIMAL(12,2),
    from_business_key   INT REFERENCES dim_business(business_key),
    to_business_key     INT REFERENCES dim_business(business_key),
    from_warehouse      VARCHAR(50),
    to_warehouse        VARCHAR(50),
    notes               VARCHAR(500),
    recorded_by_key     INT NOT NULL REFERENCES dim_user(user_key),
    approved_by_key     INT REFERENCES dim_user(user_key),
    created_at          DATETIME2 DEFAULT GETDATE(),
    sync_timestamp      DATETIME2,
    mobile_device_id    VARCHAR(100)
);
GO

-- 4.6 FACT: GOODS RETURNS
CREATE TABLE fact_goods_return (
    return_key          INT IDENTITY(1,1) PRIMARY KEY,
    business_key        INT NOT NULL REFERENCES dim_business(business_key),
    customer_key        INT NOT NULL REFERENCES dim_customer(customer_key),
    product_key         INT NOT NULL REFERENCES dim_product(product_key),
    returned_by_key     INT NOT NULL REFERENCES dim_user(user_key),
    date_key            INT NOT NULL REFERENCES dim_date(date_key),
    return_type         VARCHAR(20) NOT NULL,          -- DAMAGED, EXPIRED, WRONG_ORDER, QUALITY_ISSUE
    original_invoice    VARCHAR(50),
    batch_number        VARCHAR(50),
    quantity_returned   INT NOT NULL,
    quantity_confirmed  INT,
    credit_note_requested BIT NOT NULL DEFAULT 0,
    credit_note_number  VARCHAR(50),
    credit_note_amount  DECIMAL(12,2),
    finance_approved    BIT NOT NULL DEFAULT 0,
    finance_approved_by_key INT REFERENCES dim_user(user_key),
    finance_approved_datetime DATETIME2,
    return_status       VARCHAR(20) DEFAULT 'PENDING', -- PENDING, CONFIRMED, CREDIT_ISSUED, REJECTED
    created_at          DATETIME2 DEFAULT GETDATE(),
    updated_at          DATETIME2 DEFAULT GETDATE(),
    sync_timestamp      DATETIME2,
    mobile_device_id    VARCHAR(100)
);
GO

-- 4.7 FACT: STOCK COUNT / RECONCILIATION
CREATE TABLE fact_stock_count (
    count_key           INT IDENTITY(1,1) PRIMARY KEY,
    business_key        INT NOT NULL REFERENCES dim_business(business_key),
    product_key         INT NOT NULL REFERENCES dim_product(product_key),
    warehouse_location  VARCHAR(50),
    date_key            INT NOT NULL REFERENCES dim_date(date_key),
    counted_by_key      INT NOT NULL REFERENCES dim_user(user_key),
    witnessed_by_key    INT REFERENCES dim_user(user_key),
    system_qty          INT NOT NULL,
    physical_count      INT NOT NULL,
    variance            INT,
    variance_reason     VARCHAR(255),
    investigation_status VARCHAR(20) DEFAULT 'OPEN',  -- OPEN, RESOLVED, ESCALATED
    manager_decision    VARCHAR(255),
    created_at          DATETIME2 DEFAULT GETDATE(),
    updated_at          DATETIME2 DEFAULT GETDATE(),
    sync_timestamp      DATETIME2,
    mobile_device_id    VARCHAR(100)
);
GO

-- ============================================================================
-- STEP 5: SYNC & OFFLINE QUEUE TABLES
-- ============================================================================

-- 5.1 SYNC QUEUE (Mobile devices queue data here when offline)
-- FIX: client_ref column + unique filtered index makes mobile pushes
-- idempotent (retrying the same payload never double-inserts).
CREATE TABLE sync_queue (
    queue_id            INT IDENTITY(1,1) PRIMARY KEY,
    device_id           VARCHAR(100) NOT NULL,
    user_key            INT NOT NULL REFERENCES dim_user(user_key),
    business_key        INT NOT NULL REFERENCES dim_business(business_key),
    entity_type         VARCHAR(30) NOT NULL,
    entity_key          INT,
    client_ref          VARCHAR(100),
    payload_json        NVARCHAR(MAX) NOT NULL,
    sync_status         VARCHAR(20) DEFAULT 'PENDING', -- PENDING, PROCESSING, SYNCED, FAILED, CONFLICT
    retry_count         INT DEFAULT 0,
    error_message       VARCHAR(500),
    processed_at        DATETIME2,
    created_at          DATETIME2 DEFAULT GETDATE()
);
GO

CREATE UNIQUE INDEX UX_sync_queue_client_ref
    ON sync_queue(device_id, user_key, entity_type, client_ref)
    WHERE client_ref IS NOT NULL;
GO

-- 5.2 SYNC CONFLICT LOG
CREATE TABLE sync_conflict_log (
    conflict_key        INT IDENTITY(1,1) PRIMARY KEY,
    queue_id            INT NOT NULL REFERENCES sync_queue(queue_id),
    entity_type         VARCHAR(30) NOT NULL,
    entity_key          INT,
    server_version_json NVARCHAR(MAX),
    client_version_json NVARCHAR(MAX),
    resolution          VARCHAR(20) DEFAULT 'PENDING', -- PENDING, SERVER_WINS, CLIENT_WINS, MERGED
    resolved_by_key     INT REFERENCES dim_user(user_key),
    resolved_at         DATETIME2,
    resolution_notes    VARCHAR(500),
    created_at          DATETIME2 DEFAULT GETDATE()
);
GO

-- ============================================================================
-- STEP 6: CONFIG & LOOKUP TABLES
-- ============================================================================
CREATE TABLE app_config (
    config_key          INT IDENTITY(1,1) PRIMARY KEY,
    config_name         VARCHAR(50) NOT NULL UNIQUE,
    config_value        VARCHAR(500),
    config_group        VARCHAR(30) DEFAULT 'GENERAL', -- GENERAL, FLEET, WAREHOUSE, SYNC
    description         VARCHAR(255),
    updated_by_key      INT REFERENCES dim_user(user_key),
    updated_at          DATETIME2 DEFAULT GETDATE()
);
GO

-- ============================================================================
-- STEP 7: POWER BI VIEWS
-- TD-12 fix: business_key is exposed in every view so the API can scope
-- reads to the caller's business.
-- ============================================================================

CREATE VIEW vw_fleet_daily_dashboard AS
SELECT
    t.trip_key,
    t.business_key,
    t.trip_status,
    t.trip_start_time,
    t.trip_end_time,
    t.distance_km,
    t.stores_visited,
    t.delivery_success_count,
    t.delivery_fail_count,
    b.business_name,
    v.vehicle_id,
    v.plate_number,
    v.status AS vehicle_status,
    d.full_name AS driver_name,
    d.user_id AS driver_id,
    r.route_name,
    r.region,
    dt.full_date,
    dt.calendar_year,
    dt.calendar_month,
    dt.month_name,
    dt.day_name
FROM fact_trip t
JOIN dim_business b ON t.business_key = b.business_key
JOIN dim_vehicle v ON t.vehicle_key = v.vehicle_key
JOIN dim_user d ON t.driver_key = d.user_key
LEFT JOIN dim_route r ON t.route_key = r.route_key
JOIN dim_date dt ON t.date_key = dt.date_key;
GO

CREATE VIEW vw_fuel_efficiency AS
SELECT
    fl.fuel_log_key,
    fl.business_key,
    b.business_name,
    v.vehicle_id,
    v.plate_number,
    d.full_name AS driver_name,
    fl.refuel_datetime,
    fl.odometer_reading,
    fl.liters_filled,
    fl.cost_per_liter,
    fl.total_cost,
    fl.km_since_last_refuel,
    fl.liters_per_100km,
    dt.full_date,
    dt.calendar_month,
    dt.calendar_year
FROM fact_fuel_log fl
JOIN dim_business b ON fl.business_key = b.business_key
JOIN dim_vehicle v ON fl.vehicle_key = v.vehicle_key
JOIN dim_user d ON fl.driver_key = d.user_key
JOIN dim_date dt ON fl.date_key = dt.date_key;
GO

CREATE VIEW vw_vehicle_maintenance AS
SELECT
    m.maintenance_key,
    m.business_key,
    m.maintenance_type,
    m.priority,
    m.description,
    m.estimated_cost,
    m.actual_cost,
    m.approval_status,
    m.maintenance_status,
    m.work_start_date,
    m.work_completion_date,
    b.business_name,
    v.vehicle_id,
    v.plate_number,
    r.full_name AS reported_by,
    dt.full_date,
    DATEDIFF(DAY, m.work_start_date, m.work_completion_date) AS days_in_workshop
FROM fact_maintenance m
JOIN dim_business b ON m.business_key = b.business_key
JOIN dim_vehicle v ON m.vehicle_key = v.vehicle_key
JOIN dim_user r ON m.reported_by_key = r.user_key
JOIN dim_date dt ON m.date_key = dt.date_key;
GO

CREATE VIEW vw_stock_position AS
SELECT
    sm.business_key,
    b.business_name,
    sm.product_key,
    p.sku_code,
    p.product_name,
    p.brand,
    p.category,
    sm.warehouse_location,
    SUM(CASE WHEN sm.movement_type IN ('RECEIPT','TRANSFER_IN') THEN sm.quantity ELSE 0 END) AS total_in,
    SUM(CASE WHEN sm.movement_type IN ('DISPATCH','TRANSFER_OUT','DAMAGED','EXPIRED') THEN sm.quantity ELSE 0 END) AS total_out,
    SUM(CASE WHEN sm.movement_type IN ('RECEIPT','TRANSFER_IN') THEN sm.quantity ELSE -sm.quantity END) AS current_stock,
    MAX(sm.created_at) AS last_movement_date
FROM fact_stock_movement sm
JOIN dim_business b ON sm.business_key = b.business_key
JOIN dim_product p ON sm.product_key = p.product_key
GROUP BY sm.business_key, b.business_name, sm.product_key, p.sku_code, p.product_name, p.brand, p.category, sm.warehouse_location;
GO

CREATE VIEW vw_grn_summary AS
SELECT
    g.grn_key,
    g.business_key,
    g.grn_number,
    g.waybill_number,
    g.invoice_number,
    g.truck_plate_number,
    g.seal_number,
    g.seal_intact,
    g.receipt_status,
    g.total_invoice_qty,
    g.total_received_qty,
    g.total_rejected_qty,
    g.finance_signoff,
    g.credit_note_issued,
    b.business_name,
    s.supplier_name,
    r.full_name AS received_by,
    dt.full_date,
    DATEDIFF(HOUR, g.created_at, g.finance_signoff_datetime) AS hours_to_signoff
FROM fact_grn g
JOIN dim_business b ON g.business_key = b.business_key
LEFT JOIN dim_supplier s ON g.supplier_key = s.supplier_key
JOIN dim_user r ON g.received_by_key = r.user_key
JOIN dim_date dt ON g.date_key = dt.date_key;
GO

CREATE VIEW vw_dispatch_performance AS
SELECT
    d.dispatch_key,
    d.business_key,
    d.dispatch_number,
    d.invoice_number,
    d.dispatch_status,
    d.delivery_datetime,
    d.driver_acknowledged,
    d.customer_acknowledged,
    b.business_name,
    c.customer_name,
    c.customer_type,
    c.region,
    c.neighborhood,
    drv.full_name AS driver_name,
    dsp.full_name AS dispatched_by,
    dt.full_date,
    DATEDIFF(HOUR, d.created_at, d.delivery_datetime) AS hours_to_deliver
FROM fact_dispatch d
JOIN dim_business b ON d.business_key = b.business_key
JOIN dim_customer c ON d.customer_key = c.customer_key
LEFT JOIN dim_user drv ON d.driver_key = drv.user_key
JOIN dim_user dsp ON d.dispatched_by_key = dsp.user_key
JOIN dim_date dt ON d.date_key = dt.date_key;
GO

CREATE VIEW vw_stock_variances AS
SELECT
    sc.count_key,
    sc.business_key,
    sc.system_qty,
    sc.physical_count,
    sc.variance,
    sc.variance_reason,
    sc.investigation_status,
    sc.manager_decision,
    b.business_name,
    p.sku_code,
    p.product_name,
    p.brand,
    cnt.full_name AS counted_by,
    wit.full_name AS witnessed_by,
    dt.full_date
FROM fact_stock_count sc
JOIN dim_business b ON sc.business_key = b.business_key
JOIN dim_product p ON sc.product_key = p.product_key
JOIN dim_user cnt ON sc.counted_by_key = cnt.user_key
LEFT JOIN dim_user wit ON sc.witnessed_by_key = wit.user_key
JOIN dim_date dt ON sc.date_key = dt.date_key
WHERE sc.variance != 0;
GO

-- ============================================================================
-- STEP 8: SEED DATA (Pilot Business Setup)
-- ============================================================================

-- 8.1 Seed Date Dimension (2024-2027)
-- TD-16 fix: guarded population - only inserts dates that do not already
-- exist, and extends coverage so facts never hit missing date_keys.
-- Re-running this script is safe (no duplicates, no PK violations).
DECLARE @StartDate DATE = '2024-01-01';
DECLARE @EndDate   DATE = '2030-12-31';
DECLARE @CurrentDate DATE = @StartDate;

WHILE @CurrentDate <= @EndDate
BEGIN
    IF NOT EXISTS (SELECT 1 FROM dim_date WHERE date_key = CAST(FORMAT(@CurrentDate, 'yyyyMMdd') AS INT))
    BEGIN
        INSERT INTO dim_date (
            date_key, full_date, calendar_year, calendar_quarter, calendar_month,
            month_name, month_name_short, week_of_year, day_of_week, day_name,
            day_name_short, is_weekend, fiscal_year, fiscal_quarter
        )
        VALUES (
            CAST(FORMAT(@CurrentDate, 'yyyyMMdd') AS INT),
            @CurrentDate,
            YEAR(@CurrentDate),
            DATEPART(QUARTER, @CurrentDate),
            MONTH(@CurrentDate),
            DATENAME(MONTH, @CurrentDate),
            LEFT(DATENAME(MONTH, @CurrentDate), 3),
            DATEPART(WEEK, @CurrentDate),
            DATEPART(WEEKDAY, @CurrentDate),
            DATENAME(WEEKDAY, @CurrentDate),
            LEFT(DATENAME(WEEKDAY, @CurrentDate), 3),
            CASE WHEN DATEPART(WEEKDAY, @CurrentDate) IN (1,7) THEN 1 ELSE 0 END,
            YEAR(@CurrentDate),
            DATEPART(QUARTER, @CurrentDate)
        );
    END
    SET @CurrentDate = DATEADD(DAY, 1, @CurrentDate);
END;
GO

-- 8.2 Seed Pilot Business
IF NOT EXISTS (SELECT 1 FROM dim_business WHERE business_id = 'KD-KETU')
    INSERT INTO dim_business (business_id, business_name, business_type, region, address, contact_phone, contact_email)
    VALUES ('KD-KETU', 'Renuzi Ketu', 'KD', 'Lagos', 'Ketu, Lagos State', '0800-RENUZI', 'ketu@renuzi.com');
GO

-- 8.3 - 8.6 Seed Users
-- SEED HASH FIX: the original placeholder hashes were invalid bcrypt strings,
-- so NO seed user could log in. These are real bcrypt (cost 10) hashes.
-- DEFAULT PILOT PASSWORDS (change after first login!):
--   ADMIN-001:    Admin@123
--   FLEET-MGR-001: Fleet@123
--   WH-MGR-001:   Warehouse@123
--   DRV-001:      Driver@123
IF NOT EXISTS (SELECT 1 FROM dim_user WHERE user_id = 'ADMIN-001')
    INSERT INTO dim_user (user_id, business_key, full_name, email, phone, role, department, password_hash, is_active)
    VALUES ('ADMIN-001', 1, 'System Administrator', 'admin@renuzi.com', '08000000000', 'ADMIN', 'OPERATIONS',
            '$2a$10$jlN1CNBD1BJDW0I2CU4VMewXRGgG0SOKufg1Onk3eByQ4vbnmhQHi', 1);
GO
IF NOT EXISTS (SELECT 1 FROM dim_user WHERE user_id = 'FLEET-MGR-001')
    INSERT INTO dim_user (user_id, business_key, full_name, email, phone, role, department, password_hash, is_active)
    VALUES ('FLEET-MGR-001', 1, 'Fleet Manager', 'fleet.mgr@renuzi.com', '08011111111', 'FLEET_MANAGER', 'FLEET',
            '$2a$10$reNj7R7DrfZlzsccmunF/O.yMt/0wWLI13lGJxuTO3POa71gPk51e', 1);
GO
IF NOT EXISTS (SELECT 1 FROM dim_user WHERE user_id = 'WH-MGR-001')
    INSERT INTO dim_user (user_id, business_key, full_name, email, phone, role, department, password_hash, is_active)
    VALUES ('WH-MGR-001', 1, 'Warehouse Manager', 'wh.mgr@renuzi.com', '08022222222', 'WAREHOUSE_MANAGER', 'WAREHOUSE',
            '$2a$10$xZsIq.AYL.Q5lhfja1KSGegLnWFjn2SQXdgUJKAde6iEHuIWK049q', 1);
GO
IF NOT EXISTS (SELECT 1 FROM dim_user WHERE user_id = 'DRV-001')
    INSERT INTO dim_user (user_id, business_key, full_name, email, phone, role, department,
                          license_number, license_expiry, password_hash, is_active)
    VALUES ('DRV-001', 1, 'John Driver', 'john.drv@renuzi.com', '08033333333', 'DRIVER', 'FLEET',
            'LIC-123456', '2027-12-31',
            '$2a$10$jd/yB.L4AGDBgqFVcONWw.ECdnW2acwXxmGxycuOBa1Wq1dhB9Eja', 1);
GO

-- 8.7 Seed Sample Vehicle
IF NOT EXISTS (SELECT 1 FROM dim_vehicle WHERE vehicle_id = 'VAN-001')
    INSERT INTO dim_vehicle (vehicle_id, business_key, plate_number, make, model, year_manufactured,
                             capacity_kg, fuel_type, assigned_driver_key, current_odometer, status,
                             registration_expiry, insurance_expiry, next_service_due)
    VALUES ('VAN-001', 1, 'LAG-123-AA', 'Toyota', 'Hiace', 2022,
            1500.00, 'PETROL', 4, 45230.50, 'ACTIVE',
            '2027-06-30', '2027-06-30', '2026-09-15');
GO

-- 8.8 Seed Sample Route
IF NOT EXISTS (SELECT 1 FROM dim_route WHERE route_id = 'RT-KETU-A')
    INSERT INTO dim_route (route_id, business_key, route_name, region, neighborhood, estimated_distance_km, estimated_stores, assigned_vehicle_key)
    VALUES ('RT-KETU-A', 1, 'Ketu Route A', 'Lagos', 'Ketu, Alapere, Oworonshoki', 45.00, 25, 1);
GO

-- 8.9 Seed Sample Product
IF NOT EXISTS (SELECT 1 FROM dim_product WHERE product_id = 'SKU-COKE-33CL-24')
    INSERT INTO dim_product (product_id, business_key, sku_code, product_name, brand, manufacturer,
                             category, pack_size, unit_of_measure, units_per_case, weight_kg, unit_cost, selling_price)
    VALUES ('SKU-COKE-33CL-24', 1, 'COKE-33CL', 'Coca-Cola 33cl x 24', 'Coca-Cola', 'Nigerian Bottling Company',
            'BEVERAGES', '33cl x 24', 'CASE', 24, 8.5, 2500.00, 3200.00);
GO

-- 8.10 Seed Sample Customer
IF NOT EXISTS (SELECT 1 FROM dim_customer WHERE customer_id = 'CUST-001')
    INSERT INTO dim_customer (customer_id, business_key, customer_name, customer_type, contact_person,
                              phone, address, region, neighborhood, credit_limit, payment_terms_days)
    VALUES ('CUST-001', 1, 'Alaba Wholesalers Ltd', 'WHOLESALER', 'Mr. Alaba', '08044444444',
            'Alaba Market, Lagos', 'Lagos', 'Alaba', 500000.00, 14);
GO

-- 8.11 Seed App Config
IF NOT EXISTS (SELECT 1 FROM app_config WHERE config_name = 'PILOT_BUSINESS_ID')
    INSERT INTO app_config (config_name, config_value, config_group, description)
    VALUES ('PILOT_BUSINESS_ID', 'KD-KETU', 'GENERAL', 'Current pilot business for rollout');
IF NOT EXISTS (SELECT 1 FROM app_config WHERE config_name = 'FUEL_APPROVAL_THRESHOLD')
    INSERT INTO app_config (config_name, config_value, config_group, description)
    VALUES ('FUEL_APPROVAL_THRESHOLD', '50000', 'FLEET', 'Max fuel request auto-approved without MD');
IF NOT EXISTS (SELECT 1 FROM app_config WHERE config_name = 'MAINTENANCE_MD_THRESHOLD')
    INSERT INTO app_config (config_name, config_value, config_group, description)
    VALUES ('MAINTENANCE_MD_THRESHOLD', '100000', 'FLEET', 'Maintenance above this needs MD approval (SOP)');
IF NOT EXISTS (SELECT 1 FROM app_config WHERE config_name = 'GRN_AUTO_CLOSE_HOURS')
    INSERT INTO app_config (config_name, config_value, config_group, description)
    VALUES ('GRN_AUTO_CLOSE_HOURS', '24', 'WAREHOUSE', 'Hours before GRN auto-escalates if not signed off');
IF NOT EXISTS (SELECT 1 FROM app_config WHERE config_name = 'SYNC_RETRY_MAX')
    INSERT INTO app_config (config_name, config_value, config_group, description)
    VALUES ('SYNC_RETRY_MAX', '5', 'SYNC', 'Max retry attempts for offline sync');
IF NOT EXISTS (SELECT 1 FROM app_config WHERE config_name = 'SYNC_BATCH_SIZE')
    INSERT INTO app_config (config_name, config_value, config_group, description)
    VALUES ('SYNC_BATCH_SIZE', '50', 'SYNC', 'Records per sync batch from mobile');
GO

-- ============================================================================
-- STEP 9: INDEXES FOR PERFORMANCE
-- ============================================================================

CREATE INDEX IX_fact_trip_date ON fact_trip(date_key);
CREATE INDEX IX_fact_trip_vehicle ON fact_trip(vehicle_key);
CREATE INDEX IX_fact_trip_driver ON fact_trip(driver_key);
CREATE INDEX IX_fact_trip_status ON fact_trip(trip_status);
-- Fast "vehicle already has an active trip" detection (fleet.js trip start)
CREATE INDEX IX_fact_trip_vehicle_active ON fact_trip(vehicle_key, trip_status)
    INCLUDE (business_key, driver_key);
CREATE INDEX IX_fact_fuel_request_status ON fact_fuel_request(approval_status);
CREATE INDEX IX_fact_fuel_request_vehicle ON fact_fuel_request(vehicle_key);
CREATE INDEX IX_fact_fuel_log_vehicle ON fact_fuel_log(vehicle_key);
CREATE INDEX IX_fact_fuel_log_date ON fact_fuel_log(date_key);
CREATE INDEX IX_fact_maintenance_status ON fact_maintenance(maintenance_status);
CREATE INDEX IX_fact_grn_status ON fact_grn(receipt_status);
CREATE INDEX IX_fact_grn_date ON fact_grn(date_key);
CREATE INDEX IX_fact_dispatch_status ON fact_dispatch(dispatch_status);
CREATE INDEX IX_fact_dispatch_date ON fact_dispatch(date_key);
CREATE INDEX IX_fact_stock_movement_product ON fact_stock_movement(product_key);
CREATE INDEX IX_fact_stock_movement_type ON fact_stock_movement(movement_type);
CREATE INDEX IX_sync_queue_status ON sync_queue(sync_status);
CREATE INDEX IX_sync_queue_device ON sync_queue(device_id);
GO

PRINT '============================================================';
PRINT 'RENUZI OPERATIONS DATABASE CREATED SUCCESSFULLY';
PRINT '============================================================';
PRINT 'Next Steps:';
PRINT '1. Create a SQL Server login for the Node.js app';
PRINT '2. Grant SELECT, INSERT, UPDATE on all tables to app user';
PRINT '3. Update your .env file with connection credentials';
PRINT '4. Run the Node.js backend to start the API';
PRINT '============================================================';
GO
