/* ============================================================================
   PROCESSOR REGISTRY
   Maps sync_queue.entity_type -> processor function.

   Processor contract:
     async processor(actor, payload, options) -> entityKey | null
       actor  = { userKey, businessKey, deviceId, conflictOverride? }
       payload = parsed payload_json
     Returns the generated fact-table key (stored in sync_queue.entity_key)
     or null when nothing was created (idempotent duplicate ack).

     Throws:
       SyncConflictError - row is parked as CONFLICT (human resolution)
       anything else     - row becomes retryable FAILED / DEAD_LETTER

   Centralizing the registry (instead of a local const inside the old
   sync.js route file) means new entity types register in one place and the
   conflict service can re-invoke the exact processor that detected a
   conflict when a CLIENT_WINS resolution is applied.
   ============================================================================ */

const fleetProcessors = require('./fleetProcessors');
const warehouseProcessors = require('./warehouseProcessors');

const REGISTRY = Object.freeze({
  // Fleet
  VEHICLE_CHECK: fleetProcessors.processVehicleCheck,
  TRIP_START: fleetProcessors.processTripStart,
  TRIP_END: fleetProcessors.processTripEnd,
  FUEL_REQUEST: fleetProcessors.processFuelRequest,
  FUEL_LOG: fleetProcessors.processFuelLog,
  MAINTENANCE: fleetProcessors.processMaintenance,

  // Warehouse (Objective 1a)
  GRN: warehouseProcessors.processGRN,
  DISPATCH_ACK: warehouseProcessors.processDispatchAck,
  STOCK_COUNT: warehouseProcessors.processStockCount,
  STOCK_MOVEMENT: warehouseProcessors.processStockMovement,
  GOODS_RETURN: warehouseProcessors.processGoodsReturn
});

function getProcessor(entityType) {
  return REGISTRY[entityType] || null;
}

module.exports = { getProcessor, REGISTRY };
