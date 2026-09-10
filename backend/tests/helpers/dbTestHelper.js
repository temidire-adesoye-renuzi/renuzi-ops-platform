/* ============================================================================
   DB TEST HELPER (integration)
   Responsibilities:
   1. Bootstrap: create the database itself (via a master connection) - the
      app pool targets RenuziOpsDB which does not exist until migration 01
      runs, so the FIRST connection must tolerate failure and bootstrap.
   2. Apply all migrations once per Jest run (idempotent scripts).
   3. Per-suite cleanup: truncate operational tables between tests while
      PRESERVING dimension seeds (business/users/vehicle/date).
   ============================================================================ */

const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const { env } = require('../../src/config/env');
const { executeQuery, closePool } = require('../../src/config/db');

/* All migrations (01-05) live in backend/database, the single canonical
   migration directory (also read by scripts/migrate.js). 05 is required
   because service writes emit sync_change_log rows (transactional outbox)
   inside their write transactions. 03/04 are skipped: 03 creates a
   least-privilege login with a placeholder password (not applicable to
   sa-run test containers), 04 forces password rotation which
   clearRotationFlags() already neutralizes per-suite. */
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'database');

const MIGRATIONS = [
  '01_create_database.sql',
  '02_sync_queue.sql',
  '05_pull_change_log.sql'
].map((file) => path.join(MIGRATIONS_DIR, file));

/** Raw one-off connection (used for bootstrapping master-level work). */
async function rawConnect(database) {
  return new sql.ConnectionPool({
    user: env.db.user,
    password: env.db.password,
    server: env.db.server,
    database,
    port: env.db.port,
    options: { encrypt: env.db.encrypt, trustServerCertificate: true }
  }).connect();
}

/** Split a T-SQL script on GO delimiters and run each batch. */
async function runBatches(pool, scriptPath) {
  const raw = fs.readFileSync(scriptPath, 'utf8');
  const batches = raw.split(/^\s*GO\s*$/im).filter((b) => b.trim().length > 0);
  for (const batch of batches) {
    try {
      await pool.request().batch(batch);
    } catch (err) {
      // 2714 = object already exists - expected on idempotent re-runs
      if (err && (err.number === 2714 || err.number === 2627 || err.number === 2601)) continue;
      throw err;
    }
  }
}

async function databaseReachable(attempts = 5, delayMs = 500) {
  for (let i = 0; i < attempts; i++) {
    try {
      await executeQuery('SELECT 1 AS ok');
      return true;
    } catch (err) {
      if (i === attempts - 1) return false;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

/**
 * Apply all migrations once per Jest run.
 * The FIRST run bootstraps through master (the app pool cannot even open
 * RenuziOpsDB before it exists).
 */
let migrated = false;
async function migrate() {
  if (migrated) return;

  // Bootstrap path: DB missing -> create it + run 01 through master
  if (!(await databaseReachable())) {
    let master;
    try {
      master = await rawConnect('master');
    } catch (err) {
      throw new Error(
        'Test SQL Server unreachable. Start it with:\n' +
        '  docker compose -f docker-compose.test.yml up -d --wait\n' +
        `(expected at ${env.db.server}:${env.db.port}) - ${err.message}`
      );
    }
    try {
      try {
        await master.request().batch(
          `IF NOT EXISTS (SELECT name FROM sys.databases WHERE name = 'RenuziOpsDB') CREATE DATABASE RenuziOpsDB;`
        );
      } catch (err) {
        if (!(err.number === 2714 || err.number === 1801)) throw err;
      }
      await runBatches(master, MIGRATIONS[0]); // schema + seeds via master pool
    } finally {
      await master.close();
    }
  }

  if (!(await databaseReachable())) {
    throw new Error('Database created but the app pool still cannot connect. Check DB_* env values.');
  }

  // All migrations through the app pool (idempotent; 01 re-runs harmlessly)
  for (const script of MIGRATIONS) {
    await runBatchesViaPool(script);
  }
  migrated = true;
}

async function runBatchesViaPool(scriptPath) {
  const raw = fs.readFileSync(scriptPath, 'utf8');
  const batches = raw.split(/^\s*GO\s*$/im).filter((b) => b.trim().length > 0);
  for (const batch of batches) {
    try {
      await executeQuery(batch);
    } catch (err) {
      if (err && (err.number === 2714 || err.number === 2627 || err.number === 2601)) continue;
      throw err;
    }
  }
}

/**
 * Truncate operational + sync tables (preserving dimensions) so each test
 * starts from a known queue/fact state.
 */
async function cleanOperationalData() {
  await executeQuery(`
    DELETE FROM sync_change_log;
    DELETE FROM sync_conflict_log;
    DELETE FROM sync_queue;
    DELETE FROM fact_stock_movement;
    DELETE FROM fact_stock_count;
    DELETE FROM fact_goods_return;
    DELETE FROM fact_dispatch_line;
    DELETE FROM fact_dispatch;
    DELETE FROM fact_grn_line;
    DELETE FROM fact_grn;
    DELETE FROM fact_maintenance;
    DELETE FROM fact_fuel_log;
    DELETE FROM fact_fuel_request;
    DELETE FROM fact_trip;
    DELETE FROM fact_vehicle_check;
    UPDATE dim_vehicle SET current_odometer = 45230.50, status = 'ACTIVE';
    UPDATE dim_user SET must_change_password = 0;
  `);
}

async function close() {
  await closePool();
}

module.exports = { migrate, cleanOperationalData, close, databaseReachable, sql };
