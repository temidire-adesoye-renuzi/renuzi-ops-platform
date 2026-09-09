/* ============================================================================
   DOMAIN GUARDS (Service Layer support)
   Shared invariants enforced identically by online routes AND offline sync
   processors. Before this file existed, warehouse.js and sync.js each
   carried their own copy of these checks - the classic source of
   synchronization drift (e.g. the online GRN route validated product
   ownership but the offline one never would have).

   Every guard throws:
   - HttpError(4xx) for caller mistakes (route-friendly; the global error
     handler passes publicMessage through)
   - SyncConflictError when the failure is a data-truth collision
   - Error for infrastructure problems (missing dim_date row)
   ============================================================================ */

const { HttpError } = require('../utils/httpError');
const { SyncConflictError } = require('../utils/syncError');
const { getDateKey, assertDateKeyExists } = require('../utils/date');

/**
 * Resolve today's date_key (Africa/Lagos) and verify dim_date coverage.
 * TD-16 guard: a fact insert without a matching dim_date row would violate
 * the FK, so we fail loudly and early with an actionable message.
 */
async function resolveDateKey(query, dateKeyInput) {
  const dateKey = dateKeyInput ?? getDateKey();
  const ok = await assertDateKeyExists(query, dateKey);
  if (!ok) {
    throw new Error(`dim_date missing for ${dateKey}. Run the dim_date seed script.`);
  }
  return dateKey;
}

/**
 * Business must exist and be active. Returns the business_id (used for
 * document number prefixes).
 */
async function assertBusinessActive(query, businessKey) {
  const result = await query(
    'SELECT business_id FROM dim_business WHERE business_key = @businessKey AND is_active = 1',
    { businessKey }
  );
  if (result.recordset.length === 0) {
    throw new HttpError(403, 'Business account is inactive');
  }
  return result.recordset[0].business_id;
}

/** Vehicle must belong to the business. Returns the vehicle row. */
async function getOwnedVehicle(query, businessKey, vehicleKey) {
  const result = await query(
    'SELECT vehicle_key, current_odometer, status, assigned_driver_key FROM dim_vehicle WHERE vehicle_key = @vehicleKey AND business_key = @businessKey',
    { vehicleKey, businessKey }
  );
  if (result.recordset.length === 0) {
    throw new HttpError(404, 'Vehicle not found for this business');
  }
  return result.recordset[0];
}

/** Product must belong to the business. */
async function assertProductOwned(query, businessKey, productKey, context = 'Product') {
  const result = await query(
    'SELECT 1 AS ok FROM dim_product WHERE product_key = @productKey AND business_key = @businessKey',
    { productKey, businessKey }
  );
  if (result.recordset.length === 0) {
    throw new HttpError(400, `${context} ${productKey} not found for this business`);
  }
}

/** Customer must belong to the business. */
async function assertCustomerOwned(query, businessKey, customerKey) {
  const result = await query(
    'SELECT 1 AS ok FROM dim_customer WHERE customer_key = @customerKey AND business_key = @businessKey',
    { customerKey, businessKey }
  );
  if (result.recordset.length === 0) {
    throw new HttpError(400, 'Customer not found for this business');
  }
}

/** User (driver etc.) must belong to the business. */
async function assertUserInBusiness(query, businessKey, userKey, context = 'User') {
  const result = await query(
    'SELECT 1 AS ok FROM dim_user WHERE user_key = @userKey AND business_key = @businessKey',
    { userKey, businessKey }
  );
  if (result.recordset.length === 0) {
    throw new HttpError(400, `${context} not found for this business`);
  }
}

/** Supplier existence (suppliers are global, not business-scoped). */
async function assertSupplierExists(query, supplierKey) {
  const result = await query(
    'SELECT 1 AS ok FROM dim_supplier WHERE supplier_key = @supplierKey',
    { supplierKey }
  );
  if (result.recordset.length === 0) {
    throw new HttpError(400, 'Supplier not found');
  }
}

/**
 * Odometer monotonicity (TD-13): a new reading may never be below the
 * vehicle's current reading. Offline-first devices can genuinely produce
 * regressions (stale cache, clock/entry errors), so in the sync path this
 * is a CONFLICT (parked for human resolution), while online it is a 409.
 * We detect the violation here and let the caller decide how to surface it.
 */
function assertOdometerNotRegressed(currentOdometer, submittedOdometer, label = 'Odometer') {
  if (submittedOdometer < currentOdometer) {
    return { violated: true, currentOdometer };
  }
  return { violated: false, currentOdometer };
}

/**
 * Active-trip collision: a vehicle may not have two open trips.
 * Returns the active trip row or null.
 */
async function findActiveTrip(query, businessKey, vehicleKey, excludeTripKey = 0) {
  const result = await query(
    `SELECT trip_key FROM fact_trip
      WHERE vehicle_key = @vehicleKey AND business_key = @businessKey
        AND trip_status IN ('STARTED','IN_PROGRESS') AND trip_key != @excludeTripKey`,
    { vehicleKey, businessKey, excludeTripKey }
  );
  return result.recordset[0] || null;
}

/** Read an app_config value with fallback. */
async function getConfig(query, name, fallback) {
  const result = await query(
    'SELECT config_value FROM app_config WHERE config_name = @name',
    { name }
  );
  const row = result.recordset[0];
  if (!row) return fallback;
  const v = parseInt(row.config_value, 10);
  return Number.isNaN(v) ? fallback : v;
}

/** Read an app_config decimal value with fallback. */
async function getConfigDecimal(query, name, fallback) {
  const result = await query(
    `SELECT TRY_CAST(config_value AS DECIMAL(12,2)) AS v FROM app_config WHERE config_name = @name`,
    { name }
  );
  const row = result.recordset[0];
  return row && row.v !== null && row.v !== undefined ? row.v : fallback;
}

/**
 * Derive GRN receipt status from totals (single source of truth for the
 * online GRN route and the offline GRN processor).
 */
function deriveReceiptStatus({ totalInvoiceQty, totalReceivedQty, totalRejectedQty, lines }) {
  let inv, rec, rej;
  if (totalReceivedQty !== undefined && totalInvoiceQty !== undefined) {
    inv = totalInvoiceQty;
    rec = totalReceivedQty;
    rej = totalRejectedQty || 0;
  } else {
    inv = (lines || []).reduce((s, l) => s + (l.invoiceQty || 0), 0);
    rec = (lines || []).reduce((s, l) => s + (l.receivedQty || 0), 0);
    rej = (lines || []).reduce((s, l) => s + (l.rejectedQty || 0), 0);
  }
  if (rec === 0 && rej > 0) return 'REJECTED';
  if (rec + rej < inv) return 'PARTIAL';
  return 'COMPLETE';
}

/** Build a SyncConflictError carrying both versions for the conflict log. */
function conflict(message, serverVersion, clientPayload, extra) {
  return new SyncConflictError(message, serverVersion, { clientPayload, ...extra });
}

module.exports = {
  resolveDateKey,
  assertBusinessActive,
  getOwnedVehicle,
  assertProductOwned,
  assertCustomerOwned,
  assertUserInBusiness,
  assertSupplierExists,
  assertOdometerNotRegressed,
  findActiveTrip,
  getConfig,
  getConfigDecimal,
  deriveReceiptStatus,
  conflict
};
