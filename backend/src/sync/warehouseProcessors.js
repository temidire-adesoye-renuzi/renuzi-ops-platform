/* ============================================================================
   WAREHOUSE SYNC PROCESSORS (Objective 1a)
   processGRN, processDispatchAck, processStockCount, processStockMovement,
   processGoodsReturn.

   These were previously STUBS: the old sync.js threw "No server processor
   for entity type ..." for every warehouse entity, so every offline GRN,
   dispatch acknowledgment, stock count, movement and return FAILED and
   burned its retry budget. All five now run real, transactional logic via
   the warehouse SERVICE layer:

   - GRN:            header + lines + RECEIPT movements in ONE transaction
   - DISPATCH_ACK:   custody-chain stamping (WAREHOUSE/SECURITY/DRIVER/
                     CUSTOMER stages), idempotent per stage
   - STOCK_COUNT:    variance computed server-side (physical - system)
   - STOCK_MOVEMENT: manual adjustment/transfer/damage/expiry movements
   - GOODS_RETURN:   header + TRANSFER_IN movement transactional

   conflictOverride (set by conflictService on CLIENT_WINS/MERGED re-apply)
   makes custody-chain prereqs yield: a manager resolving "driver ack beats
   missing security stamp" is deliberately allowed to jump the queue stamp.
   ============================================================================ */

const warehouseService = require('../services/warehouseService');
const g = require('../services/guards');
const { HttpError } = require('../utils/httpError');
const { SyncConflictError } = require('../utils/syncError');

/* ---------------------------------------------------------------------------
   GRN
   --------------------------------------------------------------------------- */

async function processGRN(actor, p) {
  const { grnKey } = await warehouseService.createGRN(actor, p);
  return grnKey;
}

/* ---------------------------------------------------------------------------
   DISPATCH_ACK - custody-chain stamping from the mobile app.
   Payload: { dispatchKey, stage, loadedQuantities?, driverSignatureUrl?,
             customerSignatureUrl?, returned?, returnReason?, lineDeliveries? }
   stage: 'WAREHOUSE' | 'SECURITY' | 'DRIVER' | 'CUSTOMER'
   --------------------------------------------------------------------------- */

async function processDispatchAck(actor, p) {
  if (!p.dispatchKey) {
    throw new Error('DISPATCH_ACK payload requires dispatchKey');
  }

  const stage = String(p.stage || '').toUpperCase();
  const validStages = ['WAREHOUSE', 'SECURITY', 'DRIVER', 'CUSTOMER'];
  if (!validStages.includes(stage)) {
    throw new Error(`DISPATCH_ACK stage must be one of ${validStages.join(', ')}`);
  }

  try {
    const { dispatchKey, alreadyStamped } = await warehouseService.stampDispatchCustody(
      actor, p.dispatchKey, stage, p,
      { conflictAsError: true, overridePrereqs: actor.conflictOverride === true }
    );
    if (alreadyStamped) return null; // idempotent duplicate stamp ack
    return dispatchKey;
  } catch (err) {
    // Custody-prereq violations are 409s online; offline they are conflicts
    // ONLY when we are not deliberately overriding during resolution.
    if (err instanceof HttpError && err.status === 409 && !actor.conflictOverride) {
      throw new SyncConflictError(err.publicMessage, null, { clientPayload: p });
    }
    throw err;
  }
}

/* ---------------------------------------------------------------------------
   STOCK_COUNT - variance computed server-side
   --------------------------------------------------------------------------- */

async function processStockCount(actor, p) {
  const { countKey } = await warehouseService.recordStockCount(actor, p);
  return countKey;
}

/* ---------------------------------------------------------------------------
   STOCK_MOVEMENT - manual adjustments/transfers from the device
   --------------------------------------------------------------------------- */

async function processStockMovement(actor, p) {
  const { movementKey } = await warehouseService.recordStockMovement(actor, p);
  return movementKey;
}

/* ---------------------------------------------------------------------------
   GOODS_RETURN
   --------------------------------------------------------------------------- */

async function processGoodsReturn(actor, p) {
  const { returnKey } = await warehouseService.recordGoodsReturn(actor, p);
  return returnKey;
}

module.exports = {
  processGRN,
  processDispatchAck,
  processStockCount,
  processStockMovement,
  processGoodsReturn
};
