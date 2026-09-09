-- ============================================================================
-- MIGRATION 03: LEAST-PRIVILEGE SQL LOGIN (Objective 6)
--
-- Creates a dedicated application login/user with ONLY the rights the API
-- needs: DML on the operational tables, SELECT on dimension/config tables,
-- and NOTHING else. The app never needs DDL, TRUNCATE, or db_owner - and
-- with the least-privilege user, a SQL-injection or app compromise cannot
-- drop tables, read other databases, or grant itself further rights.
--
-- RUN AS sysadmin ONCE (e.g. staging bootstrap), then configure the app's
-- DB_USER/DB_PASSWORD to this login. Rotation of the password is an
-- ALTER LOGIN ... WITH PASSWORD away (script at bottom).
--
-- IDEMPOTENT: guarded creates; grants re-issued harmlessly.
-- ============================================================================

-- The password is set via :password substitution or edited before running.
-- Replace <APP_PASSWORD> with the staging secret before execution.

USE master;
GO

-- 1. Login (server-level)
IF NOT EXISTS (SELECT 1 FROM sys.sql_logins WHERE name = 'renuzi_app')
    CREATE LOGIN renuzi_app WITH PASSWORD = '<APP_PASSWORD>', CHECK_POLICY = ON;
GO

USE RenuziOpsDB;
GO

-- 2. Database user mapped to the login
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'renuzi_app')
    CREATE USER renuzi_app FOR LOGIN renuzi_app;
GO

-- 3. Deny everything by default; grant explicitly below
DENY ALTER ON SCHEMA::dbo TO renuzi_app;
DENY CREATE TABLE TO renuzi_app;
DENY CREATE PROCEDURE TO renuzi_app;
DENY VIEW DEFINITION ON SCHEMA::dbo TO renuzi_app;
GO

-- 4. DML on fact + sync tables (the API's write surface)
GRANT INSERT, UPDATE, SELECT, DELETE ON sync_queue        TO renuzi_app;
GRANT INSERT, UPDATE, SELECT, DELETE ON sync_conflict_log  TO renuzi_app;
GRANT INSERT, SELECT, UPDATE ON fact_vehicle_check        TO renuzi_app;
GRANT INSERT, SELECT, UPDATE ON fact_trip                 TO renuzi_app;
GRANT INSERT, SELECT, UPDATE ON fact_fuel_request         TO renuzi_app;
GRANT INSERT, SELECT, UPDATE ON fact_fuel_log             TO renuzi_app;
GRANT INSERT, SELECT, UPDATE ON fact_maintenance          TO renuzi_app;
GRANT INSERT, SELECT          ON fact_driver_incident     TO renuzi_app;
GRANT INSERT, SELECT, UPDATE ON fact_grn                  TO renuzi_app;
GRANT INSERT, SELECT          ON fact_grn_line            TO renuzi_app;
GRANT INSERT, SELECT, UPDATE ON fact_dispatch             TO renuzi_app;
GRANT INSERT, SELECT, UPDATE ON fact_dispatch_line        TO renuzi_app;
GRANT INSERT, SELECT          ON fact_stock_movement      TO renuzi_app;
GRANT INSERT, SELECT, UPDATE ON fact_goods_return        TO renuzi_app;
GRANT INSERT, SELECT, UPDATE ON fact_stock_count         TO renuzi_app;
GO

-- 5. Read-mostly dimensions: the app updates vehicle odometer/status and
--    user password/rotation flags, otherwise read-only
GRANT SELECT, UPDATE ON dim_vehicle    TO renuzi_app;
GRANT SELECT, UPDATE ON dim_user       TO renuzi_app;
GRANT SELECT         ON dim_business   TO renuzi_app;
GRANT SELECT         ON dim_date       TO renuzi_app;
GRANT SELECT         ON dim_product    TO renuzi_app;
GRANT SELECT         ON dim_customer   TO renuzi_app;
GRANT SELECT         ON dim_supplier   TO renuzi_app;
GRANT SELECT         ON dim_route      TO renuzi_app;
GO

-- 6. Config: readable (thresholds), NOT writable by the app (config changes
--    are an ops action through migration scripts, never runtime SQL)
GRANT SELECT ON app_config TO renuzi_app;
GO

-- 7. Views (dashboard reads)
GRANT SELECT ON vw_fleet_daily_dashboard    TO renuzi_app;
GRANT SELECT ON vw_fuel_efficiency          TO renuzi_app;
GRANT SELECT ON vw_vehicle_maintenance      TO renuzi_app;
GRANT SELECT ON vw_stock_position           TO renuzi_app;
GRANT SELECT ON vw_grn_summary              TO renuzi_app;
GRANT SELECT ON vw_dispatch_performance     TO renuzi_app;
GRANT SELECT ON vw_stock_variances          TO renuzi_app;
GO

-- 8. EXECUTE on nothing: the app uses no stored procedures (the atomic
--    claim is an OUTPUT-clause UPDATE, deliberately chosen so this grant
--    table can stay minimal).

PRINT 'Migration 03 (least privilege app login) applied.';
PRINT 'ROTATE THE PASSWORD WITH (example):';
PRINT '  ALTER LOGIN renuzi_app WITH PASSWORD = ''<NEW_PASSWORD>'';';
GO
