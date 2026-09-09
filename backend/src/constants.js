/* ============================================================================
   RENUZI OPERATIONS PLATFORM - SHARED CONSTANTS
   Single source of truth for enums, statuses, and thresholds.
   TD-6 fix: vehicle status enums now match the database column comments.
   ============================================================================ */

const VEHICLE_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  IN_WORKSHOP: 'IN_WORKSHOP',
  ON_ROUTE: 'ON_ROUTE',
  RETIRED: 'RETIRED',
  SOLD: 'SOLD'
});

const TRIP_STATUS = Object.freeze({
  PLANNED: 'PLANNED',
  STARTED: 'STARTED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED'
});

const CHECK_STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  PASS_WITH_ISSUES: 'PASS_WITH_ISSUES'
});

const FUEL_REQUEST_STATUS = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED'
});

const FUEL_REQUEST_TYPE = Object.freeze({
  CASH: 'CASH',
  FUEL_CARD: 'FUEL_CARD',
  EMERGENCY: 'EMERGENCY'
});

const APPROVAL_STATUS = Object.freeze({
  PENDING: 'PENDING',
  OPS_APPROVED: 'OPS_APPROVED',
  MD_APPROVED: 'MD_APPROVED',
  REJECTED: 'REJECTED'
});

const MAINTENANCE_STATUS = Object.freeze({
  OPEN: 'OPEN',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED'
});

const MAINTENANCE_TYPE = Object.freeze({
  SCHEDULED: 'SCHEDULED',
  REPAIR: 'REPAIR',
  ACCIDENT: 'ACCIDENT',
  INSPECTION: 'INSPECTION'
});

const INCIDENT_TYPE = Object.freeze({
  LATENESS: 'LATENESS',
  THEFT: 'THEFT',
  DAMAGE: 'DAMAGE',
  BAD_BEHAVIOR: 'BAD_BEHAVIOR',
  ACCIDENT: 'ACCIDENT',
  PERFORMANCE_GAP: 'PERFORMANCE_GAP'
});

const DISPATCH_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PICKED: 'PICKED',
  LOADED: 'LOADED',
  IN_TRANSIT: 'IN_TRANSIT',
  DELIVERED: 'DELIVERED',
  RETURNED: 'RETURNED'
});

const RECEIPT_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PARTIAL: 'PARTIAL',
  COMPLETE: 'COMPLETE',
  REJECTED: 'REJECTED'
});

const MOVEMENT_TYPE = Object.freeze({
  RECEIPT: 'RECEIPT',
  DISPATCH: 'DISPATCH',
  TRANSFER_IN: 'TRANSFER_IN',
  TRANSFER_OUT: 'TRANSFER_OUT',
  ADJUSTMENT: 'ADJUSTMENT',
  DAMAGED: 'DAMAGED',
  EXPIRED: 'EXPIRED',
  COUNT: 'COUNT'
});

const RETURN_STATUS = Object.freeze({
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  CREDIT_ISSUED: 'CREDIT_ISSUED',
  REJECTED: 'REJECTED'
});

const RETURN_TYPE = Object.freeze({
  DAMAGED: 'DAMAGED',
  EXPIRED: 'EXPIRED',
  WRONG_ORDER: 'WRONG_ORDER',
  QUALITY_ISSUE: 'QUALITY_ISSUE'
});

const SYNC_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  SYNCED: 'SYNCED',
  FAILED: 'FAILED',
  CONFLICT: 'CONFLICT',
  DEAD_LETTER: 'DEAD_LETTER'
});

const SYNC_ENTITY_TYPES = Object.freeze([
  'VEHICLE_CHECK', 'TRIP_START', 'TRIP_END', 'FUEL_REQUEST', 'FUEL_LOG',
  'MAINTENANCE', 'GRN', 'DISPATCH_ACK', 'STOCK_COUNT', 'STOCK_MOVEMENT',
  'GOODS_RETURN'
]);

/* Pull-side delta sync (Objective: download/dataset sync). PULL_DATASETS is
   the download mirror of SYNC_ENTITY_TYPES (push types): each entry maps a
   dataset name to the table + business-scoped key the change log records. */
const PULL_DATASETS = Object.freeze({
  VEHICLES: { table: 'dim_vehicle', keyColumn: 'vehicle_key' },
  ROUTES: { table: 'dim_route', keyColumn: 'route_key' },
  CUSTOMERS: { table: 'dim_customer', keyColumn: 'customer_key' },
  PRODUCTS: { table: 'dim_product', keyColumn: 'product_key' },
  DISPATCHES: { table: 'fact_dispatch', keyColumn: 'dispatch_key' },
  GRNS: { table: 'fact_grn', keyColumn: 'grn_key' }
});

const CHANGE_OP = Object.freeze({
  UPSERT: 'UPSERT',
  DELETE: 'DELETE' // tombstone: payload_json is NULL, devices drop the row
});

/* Soft-delete convention: rows are never physically deleted. Entities are
   deactivated by setting the is_active column, and downstream devices are
   tombstoned via CHANGE_OP.DELETE in the change log. */
const SOFT_DELETE = Object.freeze({
  FIELD: 'is_active',
  ACTIVE: 1,
  DELETED: 0
});

const CONFLICT_RESOLUTION = Object.freeze({
  SERVER_WINS: 'SERVER_WINS',
  CLIENT_WINS: 'CLIENT_WINS',
  MERGED: 'MERGED',
  PENDING: 'PENDING'
});

const UPLOAD_PURPOSES = Object.freeze({
  DAMAGE_PHOTO: 'DAMAGE_PHOTO',
  RECEIPT_PHOTO: 'RECEIPT_PHOTO',
  DRIVER_SIGNATURE: 'DRIVER_SIGNATURE',
  CUSTOMER_SIGNATURE: 'CUSTOMER_SIGNATURE',
  GENERAL: 'GENERAL'
});

const USER_ROLES = Object.freeze({
  DRIVER: 'DRIVER',
  FLEET_MANAGER: 'FLEET_MANAGER',
  WAREHOUSE_MANAGER: 'WAREHOUSE_MANAGER',
  WAREHOUSE_STAFF: 'WAREHOUSE_STAFF',
  OPS_MANAGER: 'OPS_MANAGER',
  SECURITY: 'SECURITY',
  ADMIN: 'ADMIN'
});

const GEO_REGION = 'Africa/Lagos';

module.exports = {
  VEHICLE_STATUS,
  TRIP_STATUS,
  CHECK_STATUS,
  FUEL_REQUEST_STATUS,
  FUEL_REQUEST_TYPE,
  APPROVAL_STATUS,
  MAINTENANCE_STATUS,
  MAINTENANCE_TYPE,
  INCIDENT_TYPE,
  DISPATCH_STATUS,
  RECEIPT_STATUS,
  MOVEMENT_TYPE,
  RETURN_STATUS,
  RETURN_TYPE,
  SYNC_STATUS,
  SYNC_ENTITY_TYPES,
  PULL_DATASETS,
  CHANGE_OP,
  SOFT_DELETE,
  CONFLICT_RESOLUTION,
  UPLOAD_PURPOSES,
  USER_ROLES,
  GEO_REGION
};
