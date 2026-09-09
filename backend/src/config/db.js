/* ============================================================================
   DATABASE CONFIGURATION
   Connects Node.js to SQL Server 2022 using the 'mssql' package.

   Fixes in this file:
   - TD-2: NULL parameters are now typed explicitly. mssql cannot infer a
     type for JS null, which previously crashed every query that passed an
     optional parameter. We infer a sensible SQL type from the parameter
     name (and value when present) and fall back to NVarChar.
   - TD-4: withTransaction() helper so multi-statement writes (trip end,
     GRN, dispatch, sync processing) are atomic.
   ============================================================================ */

const sql = require('mssql');
const { env } = require('./env');

const dbConfig = {
  user: env.db.user,
  password: env.db.password,
  server: env.db.server,
  database: env.db.database,
  port: env.db.port,
  options: {
    encrypt: env.db.encrypt,
    trustServerCertificate: true
  },
  pool: {
    max: env.db.poolMax,
    min: env.db.poolMin,
    idleTimeoutMillis: 30000
  }
};

/* ---------------------------------------------------------------------------
   TD-2: Type inference for parameters.

   mssql's request.input(name, value) with a 2-arg call needs to infer the
   SQL type from the value; for null it cannot, and it throws. We keep a map
   of known parameter names -> sql type so that "routeKey: null" binds as
   Int instead of crashing. Unlisted names fall back to NVarChar(4000),
   which SQL Server implicitly converts for most comparisons.
   --------------------------------------------------------------------------- */

const PARAM_TYPE_MAP = {
  // Keys / IDs (INT)
  vehicleKey: sql.Int, routeKey: sql.Int, driverKey: sql.Int, userKey: sql.Int,
  tripKey: sql.Int, fuelRequestKey: sql.Int, fuelLogKey: sql.Int,
  maintenanceKey: sql.Int, incidentKey: sql.Int, checkKey: sql.Int,
  grnKey: sql.Int, grnLineKey: sql.Int, dispatchKey: sql.Int,
  dispatchLineKey: sql.Int, movementKey: sql.Int, returnKey: sql.Int,
  countKey: sql.Int, conflictKey: sql.Int, queueId: sql.Int,
  customerKey: sql.Int, supplierKey: sql.Int, productKey: sql.Int,
  businessKey: sql.Int, dateKey: sql.Int, reportedByKey: sql.Int,
  approvedByKey: sql.Int, opsApprovedByKey: sql.Int, mdApprovedByKey: sql.Int,
  receivedByKey: sql.Int, dispatchedByKey: sql.Int, recordedByKey: sql.Int,
  returnedByKey: sql.Int, countedByKey: sql.Int, witnessedByKey: sql.Int,
  resolvedByKey: sql.Int, financeSignoffByKey: sql.Int, financeApprovedByKey: sql.Int,
  warehouseSignedByKey: sql.Int, securitySignedByKey: sql.Int, assignedDriverKey: sql.Int,
  assignedVehicleKey: sql.Int, supplierKey: sql.Int, offset: sql.Int, limit: sql.Int,
  referenceKey: sql.Int, fromBusinessKey: sql.Int, toBusinessKey: sql.Int,

  // Quantities / money / decimals
  startOdometer: sql.Decimal(10, 2), endOdometer: sql.Decimal(10, 2),
  odometerReading: sql.Decimal(10, 2), distanceKm: sql.Decimal(10, 2),
  amountRequested: sql.Decimal(12, 2), disbursedAmount: sql.Decimal(12, 2),
  litersRequested: sql.Decimal(8, 2), litersFilled: sql.Decimal(8, 2),
  costPerLiter: sql.Decimal(8, 2), totalCost: sql.Decimal(12, 2),
  estimatedCost: sql.Decimal(12, 2), actualCost: sql.Decimal(12, 2),
  kmSinceLast: sql.Decimal(10, 2), litersPer100km: sql.Decimal(8, 2),
  unitPrice: sql.Decimal(12, 2), lineTotal: sql.Decimal(12, 2),
  unitCost: sql.Decimal(12, 2), totalValue: sql.Decimal(12, 2),
  mdThreshold: sql.Decimal(12, 2), fuelThreshold: sql.Decimal(12, 2),
  latitude: sql.Decimal(10, 6), longitude: sql.Decimal(10, 6),

  // Counts
  storesVisited: sql.Int, storesPlanned: sql.Int,
  deliverySuccessCount: sql.Int, deliveryFailCount: sql.Int,
  invoiceQty: sql.Int, receivedQty: sql.Int, rejectedQty: sql.Int,
  pickedQty: sql.Int, loadedQty: sql.Int, deliveredQty: sql.Int,
  returnedQty: sql.Int, quantity: sql.Int, systemQty: sql.Int,
  physicalCount: sql.Int, variance: sql.Int, retryCount: sql.Int,
  quantityReturned: sql.Int, quantityConfirmed: sql.Int,
  totalInvoiceQty: sql.Int, totalReceivedQty: sql.Int, totalRejectedQty: sql.Int,
  nearExpiryDays: sql.Int,

  // Bits
  tiresOk: sql.Bit, lightsOk: sql.Bit, brakesOk: sql.Bit, engineOk: sql.Bit,
  oilLevelOk: sql.Bit, coolantOk: sql.Bit, wipersOk: sql.Bit, mirrorsOk: sql.Bit,
  seatbeltsOk: sql.Bit, fireExtinguisherOk: sql.Bit, firstAidKitOk: sql.Bit,
  hasDamage: sql.Bit, sealIntact: sql.Bit, fifoCompliant: sql.Bit,
  isDamaged: sql.Bit, isExpired: sql.Bit, isNearExpiry: sql.Bit,
  financeSignoff: sql.Bit, creditNoteIssued: sql.Bit, financeApproved: sql.Bit,
  warehouseStamp: sql.Bit, securityStamp: sql.Bit, driverAcknowledged: sql.Bit,
  customerAcknowledged: sql.Bit, isActive: sql.Bit,

  // Dates
  licenseExpiry: sql.Date, registrationExpiry: sql.Date, insuranceExpiry: sql.Date,
  productionDate: sql.Date, expiryDate: sql.Date, actionDate: sql.Date,
  workStartDate: sql.Date, workCompletionDate: sql.Date,
  dateFrom: sql.DateTime2, dateTo: sql.DateTime2, monthStart: sql.DateTime2,

  // Strings (nullable text)
  userId: sql.NVarChar(50), grnNumber: sql.NVarChar(50), dispatchNumber: sql.NVarChar(50)
};

/**
 * Infer the mssql type for a parameter. If the value is non-null, JS value
 * -> sql type is straightforward. If null, use the name map; otherwise
 * default to NVarChar which SQL Server can implicitly convert.
 */
function inferParamType(name, value) {
  if (value === null || value === undefined) {
    return PARAM_TYPE_MAP[name] || sql.NVarChar(4000);
  }
  if (value instanceof Date) return sql.DateTime2;
  if (typeof value === 'boolean') return sql.Bit;
  if (Number.isInteger(value)) return sql.Int;
  if (typeof value === 'number') return sql.Decimal(18, 4);
  return sql.NVarChar(4000);
}

/**
 * Bind every entry in the params object onto a request, typing nulls.
 */
function bindParams(request, params) {
  Object.keys(params).forEach((key) => {
    const value = params[key] === undefined ? null : params[key];
    const type = inferParamType(key, value);
    request.input(key, type, value === null ? null : value);
  });
}

/* ---------------------------------------------------------------------------
   Connection pool (kept open for the lifetime of the app)
   --------------------------------------------------------------------------- */

let pool = null;
let poolPromise = null;

async function getPool() {
  if (pool && pool.connected) return pool;
  if (poolPromise) return poolPromise;

  poolPromise = new sql.ConnectionPool(dbConfig)
    .connect()
    .then((p) => {
      pool = p;
      console.log('[DB] Connected to SQL Server successfully');
      pool.on('error', (err) => {
        console.error('[DB] Pool error:', err.message);
        pool = null;
        poolPromise = null;
      });
      return p;
    })
    .catch((err) => {
      poolPromise = null;
      console.error('[DB] Connection failed:', err.message);
      throw err;
    });

  return poolPromise;
}

/* ---------------------------------------------------------------------------
   Query helpers
   --------------------------------------------------------------------------- */

/**
 * Execute a parameterised query. TD-2: null-safe parameter binding.
 */
async function executeQuery(queryString, params = {}) {
  const connection = await getPool();
  const request = connection.request();
  bindParams(request, params);
  const result = await request.query(queryString);
  return result;
}

/**
 * TD-4: Run multiple statements atomically.
 *
 *   await withTransaction(async (tx) => {
 *     await tx.request().input(...).query(...);
 *     ...
 *   });
 *
 * The transaction commits if the callback resolves and rolls back if it
 * throws. The callback receives a transaction-scoped object exposing
 * request() and rollback().
 */
async function withTransaction(work) {
  const connection = await getPool();
  const transaction = new sql.Transaction(connection);
  await transaction.begin();

  const tx = {
    transaction,
    request() {
      return new sql.Request(transaction);
    },
    async query(queryString, params = {}) {
      const request = new sql.Request(transaction);
      bindParams(request, params);
      return request.query(queryString);
    }
  };

  try {
    const result = await work(tx);
    await transaction.commit();
    return result;
  } catch (err) {
    try {
      await transaction.rollback();
    } catch (rollbackErr) {
      console.error('[DB] Rollback failed:', rollbackErr.message);
    }
    throw err;
  }
}

/**
 * Parameter binding for a raw mssql Request (used by route helpers that
 * manage their own transaction requests).
 */
function bindRequestParams(request, params) {
  bindParams(request, params);
}

/** Execute a stored procedure with typed parameters. */
async function executeStoredProc(procName, params = {}) {
  const connection = await getPool();
  const request = connection.request();
  bindParams(request, params);
  const result = await request.execute(procName);
  return result;
}

/** Lightweight DB ping for /api/ready. */
async function ping() {
  const result = await executeQuery('SELECT 1 AS ok');
  return result.recordset[0].ok === 1;
}

/** Close the pool on shutdown. */
async function closePool() {
  if (pool) {
    await pool.close();
    pool = null;
    poolPromise = null;
    console.log('[DB] Connection pool closed');
  }
}

module.exports = {
  sql,
  dbConfig,
  getPool,
  executeQuery,
  executeStoredProc,
  withTransaction,
  bindRequestParams,
  ping,
  closePool
};
