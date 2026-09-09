/* ============================================================================
   WAREHOUSE SERVICE (Service Layer)
   Single source of truth for warehouse business logic. Consumers:
   - routes/warehouse.js            (online HTTP requests)
   - sync/warehouseProcessors.js    (offline queued payloads)

   Invariants enforced identically in both paths:
   - TD-4:  header + lines + stock movements atomic (single transaction)
   - TD-12: supplier/customer/product/driver/vehicle business-scoped
   - TD-13: dispatch odometer monotonicity when a vehicle is attached
   - TD-16: dim_date coverage guard before fact inserts
   - GRN status derivation shared with offline processor via guards.deriveReceiptStatus
   - PULL: every fact_grn/fact_dispatch mutation also emits a GRNS or
     DISPATCHES change-log row via changeLogService.recordChange INSIDE the
     same transaction (transactional outbox). Single-statement writes that
     previously used bare executeQuery (custody SECURITY/DRIVER stages,
     finance signoff) are now wrapped in withTransaction so the write and
     its outbox row commit atomically - devices can never observe a
     business write without its change-log row (or vice versa).
   ============================================================================ */
 
const { executeQuery, withTransaction } = require('../config/db');
const {
  DISPATCH_STATUS, MOVEMENT_TYPE, RETURN_STATUS, RETURN_TYPE, CHANGE_OP
} = require('../constants');
const { HttpError } = require('../utils/httpError');
const g = require('./guards');
const { nextDocNumber } = require('./docNumbers');
const { recordChange } = require('./changeLogService');

const q = executeQuery;

/* -----------------------------------------------------------------------
   GOODS RECEIPT NOTE (GRN)
   ----------------------------------------------------------------------- */

/**
 * Create a GRN: header + lines + RECEIPT stock movements in ONE transaction.
 * @param {object} actor  { userKey, businessKey, deviceId }
 * @param {object} body   GRN payload (see routes for shape)
 * @returns {{ grnKey:number, grnNumber:string, receiptStatus:string }}
 */
async function createGRN(actor, body) {
  const {
    supplierKey, waybillNumber, invoiceNumber, truckPlateNumber, driverName,
    sealNumber, sealIntact, totalInvoiceQty, totalReceivedQty, totalRejectedQty,
    rejectionReason, lines
  } = body;

  if (!Array.isArray(lines) || lines.length === 0) {
    throw new HttpError(400, 'At least one GRN line is required');
  }
  for (const [i, l] of lines.entries()) {
    if (!l.productKey) throw new HttpError(400, `Line ${i + 1}: productKey is required`);
    if ((l.invoiceQty ?? 0) < 0 || (l.receivedQty ?? 0) < 0 || (l.rejectedQty ?? 0) < 0) {
      throw new HttpError(400, `Line ${i + 1}: quantities must be >= 0`);
    }
  }

  const dateKey = await g.resolveDateKey(q);

  const receiptStatus = g.deriveReceiptStatus({
    totalInvoiceQty, totalReceivedQty, totalRejectedQty, lines
  });

  const out = await withTransaction(async (tx) => {
    const businessId = await g.assertBusinessActive((s, p) => tx.query(s, p), actor.businessKey);

    const grnNumber = await nextDocNumber(tx, 'GRN', businessId, dateKey);

    if (supplierKey) await g.assertSupplierExists((s, p) => tx.query(s, p), supplierKey);
    for (const l of lines) {
      await g.assertProductOwned((s, p) => tx.query(s, p), actor.businessKey, l.productKey, 'Product');
    }

    const header = await tx.query(
      `INSERT INTO fact_grn (
         business_key, supplier_key, received_by_key, date_key, grn_number,
         waybill_number, invoice_number, truck_plate_number, driver_name,
         seal_number, seal_intact,
         receipt_status, total_invoice_qty, total_received_qty, total_rejected_qty,
         rejection_reason, mobile_device_id, sync_timestamp
       ) OUTPUT INSERTED.grn_key
       VALUES (
         @businessKey, @supplierKey, @receivedByKey, @dateKey, @grnNumber,
         @waybillNumber, @invoiceNumber, @truckPlateNumber, @driverName,
         @sealNumber, @sealIntact,
         @receiptStatus, @totalInvoiceQty, @totalReceivedQty, @totalRejectedQty,
         @rejectionReason, @mobileDeviceId, GETDATE()
       )`,
      {
        businessKey: actor.businessKey,
        supplierKey: supplierKey || null,
        receivedByKey: actor.userKey,
        dateKey,
        grnNumber,
        waybillNumber: waybillNumber || null,
        invoiceNumber: invoiceNumber || null,
        truckPlateNumber: truckPlateNumber || null,
        driverName: driverName || null,
        sealNumber: sealNumber || null,
        sealIntact: sealIntact ? 1 : 0,
        receiptStatus,
        totalInvoiceQty: totalInvoiceQty ?? lines.reduce((s, l) => s + (l.invoiceQty || 0), 0),
        totalReceivedQty: totalReceivedQty ?? lines.reduce((s, l) => s + (l.receivedQty || 0), 0),
        totalRejectedQty: totalRejectedQty ?? lines.reduce((s, l) => s + (l.rejectedQty || 0), 0),
        rejectionReason: rejectionReason || null,
        mobileDeviceId: actor.deviceId || null
      }
    );
    const grnKey = header.recordset[0].grn_key;
 
    for (const l of lines) {
      await tx.query(
        `INSERT INTO fact_grn_line (
           grn_key, product_key, invoice_qty, received_qty, rejected_qty,
           production_date, expiry_date, batch_number,
           is_damaged, is_expired, is_near_expiry, near_expiry_days,
           rejection_reason, allocated_location, fifo_compliant
         ) OUTPUT INSERTED.grn_line_key
         VALUES (
           @grnKey, @productKey, @invoiceQty, @receivedQty, @rejectedQty,
           @productionDate, @expiryDate, @batchNumber,
           @isDamaged, @isExpired, @isNearExpiry, @nearExpiryDays,
           @lineRejectionReason, @allocatedLocation, @fifoCompliant
         )`,
        {
          grnKey,
          productKey: l.productKey,
          invoiceQty: l.invoiceQty || 0,
          receivedQty: l.receivedQty || 0,
          rejectedQty: l.rejectedQty || 0,
          productionDate: l.productionDate || null,
          expiryDate: l.expiryDate || null,
          batchNumber: l.batchNumber || null,
          isDamaged: l.isDamaged ? 1 : 0,
          isExpired: l.isExpired ? 1 : 0,
          isNearExpiry: l.isNearExpiry ? 1 : 0,
          nearExpiryDays: l.nearExpiryDays || null,
          lineRejectionReason: l.rejectionReason || null,
          allocatedLocation: l.allocatedLocation || null,
          fifoCompliant: l.fifoCompliant ? 1 : 0
        }
      );

      // Positive receipts become stock movements so vw_stock_position works
      if ((l.receivedQty || 0) > 0) {
        await tx.query(
          `INSERT INTO fact_stock_movement (
             business_key, product_key, warehouse_location, date_key,
             movement_type, reference_key, reference_type, quantity,
             recorded_by_key, created_at
           ) VALUES (
             @businessKey, @productKey, @location, @dateKey,
             @movementType, @referenceKey, @referenceType, @quantity,
             @recordedByKey, GETDATE()
           )`,
          {
            businessKey: actor.businessKey,
            productKey: l.productKey,
            location: l.allocatedLocation || 'MAIN',
            dateKey,
            movementType: MOVEMENT_TYPE.RECEIPT,
            referenceKey: grnKey,
            referenceType: 'GRN',
            quantity: l.receivedQty,
            recordedByKey: actor.userKey
          }
        );
      }
    }

    // Transactional outbox: the GRN (header + lines + movements) and its
    // GRNS change-log row commit together; the emit self-snapshots the
    // committed header state for pull devices.
    await recordChange(tx, {
      dataset: 'GRNS',
      businessKey: actor.businessKey,
      entityKey: grnKey,
      op: CHANGE_OP.UPSERT
    });

    return { grnKey, grnNumber, receiptStatus };
  });

  return out;
}

/** Finance sign-off on a GRN (idempotent-guarded). */
async function signoffGRNFinance(actor, grnKey, { creditNoteIssued, creditNoteNumber }) {
  const existing = await executeQuery(
    'SELECT finance_signoff FROM fact_grn WHERE grn_key = @grnKey AND business_key = @businessKey',
    { grnKey, businessKey: actor.businessKey }
  );
  if (existing.recordset.length === 0) throw new HttpError(404, 'GRN not found');
  if (existing.recordset[0].finance_signoff) {
    throw new HttpError(409, 'GRN already signed off by finance');
  }

  // Single statement + outbox row in ONE transaction (TD-4/PULL): the
  // signoff and its change-log entry commit atomically.
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE fact_grn SET
         finance_signoff = 1,
         finance_signoff_by_key = @userKey,
         finance_signoff_datetime = GETDATE(),
         credit_note_issued = @creditNoteIssued,
         credit_note_number = @creditNoteNumber,
         updated_at = GETDATE()
       WHERE grn_key = @grnKey AND business_key = @businessKey`,
      {
        userKey: actor.userKey,
        creditNoteIssued: creditNoteIssued ? 1 : 0,
        creditNoteNumber: creditNoteNumber || null,
        grnKey,
        businessKey: actor.businessKey
      }
    );
    await recordChange(tx, {
      dataset: 'GRNS',
      businessKey: actor.businessKey,
      entityKey: grnKey,
      op: CHANGE_OP.UPSERT
    });
  });
}

/* -----------------------------------------------------------------------
   DISPATCH / OUTBOUND
   ----------------------------------------------------------------------- */

/**
 * Create a dispatch: header + lines transactional.
 * @returns {{ dispatchKey:number, dispatchNumber:string }}
 */
async function createDispatch(actor, body) {
  const { customerKey, invoiceNumber, driverKey, vehicleKey, lines } = body;

  if (!customerKey || !invoiceNumber) {
    throw new HttpError(400, 'customerKey and invoiceNumber are required');
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new HttpError(400, 'At least one dispatch line is required');
  }

  const dateKey = await g.resolveDateKey(q);

  return withTransaction(async (tx) => {
    const tq = (s, p) => tx.query(s, p);
    const businessId = await g.assertBusinessActive(tq, actor.businessKey);

    await g.assertCustomerOwned(tq, actor.businessKey, customerKey);
    for (const [i, l] of lines.entries()) {
      if (!l.productKey) throw new HttpError(400, `Line ${i + 1}: productKey is required`);
      await g.assertProductOwned(tq, actor.businessKey, l.productKey, 'Product');
    }
    if (driverKey) await g.assertUserInBusiness(tq, actor.businessKey, driverKey, 'Driver');
    if (vehicleKey) await g.getOwnedVehicle(tq, actor.businessKey, vehicleKey);

    const dispatchNumber = await nextDocNumber(tx, 'DISPATCH', businessId, dateKey);

    const header = await tx.query(
      `INSERT INTO fact_dispatch (
         business_key, customer_key, dispatched_by_key, driver_key, vehicle_key,
         date_key, dispatch_number, invoice_number,
         dispatch_status, mobile_device_id
       ) OUTPUT INSERTED.dispatch_key
       VALUES (
         @businessKey, @customerKey, @dispatchedByKey, @driverKey, @vehicleKey,
         @dateKey, @dispatchNumber, @invoiceNumber,
         @dispatchStatus, @mobileDeviceId
       )`,
      {
        businessKey: actor.businessKey,
        customerKey,
        dispatchedByKey: actor.userKey,
        driverKey: driverKey || null,
        vehicleKey: vehicleKey || null,
        dateKey,
        dispatchNumber,
        invoiceNumber,
        dispatchStatus: DISPATCH_STATUS.PENDING,
        mobileDeviceId: actor.deviceId || null
      }
    );
    const dispatchKey = header.recordset[0].dispatch_key;

    for (const l of lines) {
      const lineTotal = l.unitPrice && l.pickedQty ? l.unitPrice * l.pickedQty : null;
      await tx.query(
        `INSERT INTO fact_dispatch_line (
           dispatch_key, product_key, invoice_qty, picked_qty, loaded_qty,
           delivered_qty, returned_qty, unit_price, line_total
         ) VALUES (
           @dispatchKey, @productKey, @invoiceQty, @pickedQty, @loadedQty,
           0, 0, @unitPrice, @lineTotal
         )`,
        {
          dispatchKey,
          productKey: l.productKey,
          invoiceQty: l.invoiceQty || 0,
          pickedQty: l.pickedQty || 0,
          loadedQty: l.loadedQty || 0,
          unitPrice: l.unitPrice || null,
          lineTotal
        }
      );
    }

    // Transactional outbox: dispatch header + lines + DISPATCHES change
    // row commit together (devices see the dispatch or nothing).
    await recordChange(tx, {
      dataset: 'DISPATCHES',
      businessKey: actor.businessKey,
      entityKey: dispatchKey,
      op: CHANGE_OP.UPSERT
    });

    return { dispatchKey, dispatchNumber };
  });
}

/** Load a dispatch header (business-scoped). Returns null when absent. */
async function getDispatch(actor, dispatchKey) {
  const result = await executeQuery(
    `SELECT * FROM fact_dispatch WHERE dispatch_key = @dispatchKey AND business_key = @businessKey`,
    { dispatchKey, businessKey: actor.businessKey }
  );
  return result.recordset[0] || null;
}

/**
 * CUSTODY CHAIN STAMPING (warehouse -> security -> driver -> customer).
 * All four stamps flow through this one function so online stamps and
 * offline DISPATCH_ACK payloads share identical state-transition rules:
 *
 *   WAREHOUSE: requires nothing; sets LOADED (idempotent)
 *   SECURITY:  requires warehouse stamp; sets LOADED (idempotent)
 *   DRIVER:    requires security stamp; sets IN_TRANSIT (idempotent)
 *   CUSTOMER:  requires driver ack; sets DELIVERED/RETURNED + stock moves
 *
 * @param {string} stage - 'WAREHOUSE' | 'SECURITY' | 'DRIVER' | 'CUSTOMER'
 * @param {object} p     stage-specific payload (loadedQuantities, deliveries...)
 * @param {object} [opts]
 * @param {boolean} [opts.conflictAsError] - offline mode: prereq violations throw
 *   SyncConflictError instead of HttpError(409) so they park as conflicts.
 * @param {boolean} [opts.overridePrereqs] - conflict resolution mode: a
 *   manager's CLIENT_WINS/MERGED decision deliberately jumps the custody
 *   prereqs (the human IS the missing stamp's authority).
 */
async function stampDispatchCustody(actor, dispatchKey, stage, p = {}, { conflictAsError = false, overridePrereqs = false } = {}) {
  const d = await getDispatch(actor, dispatchKey);
  if (!d) {
    if (conflictAsError) throw g.conflict('Dispatch not found on server', null, p);
    throw new HttpError(404, 'Dispatch not found');
  }

  const alreadyStaged = {
    WAREHOUSE: d.warehouse_stamp,
    SECURITY: d.security_stamp,
    DRIVER: d.driver_acknowledged,
    CUSTOMER: d.customer_acknowledged
  }[stage];
  if (alreadyStaged) {
    // Idempotent re-ack (offline duplicates are acks, not errors)
    return { dispatchKey, status: d.dispatch_status, alreadyStamped: true };
  }

  if (!overridePrereqs) {
    const prereqMissing = {
      WAREHOUSE: false,
      SECURITY: !d.warehouse_stamp && 'Warehouse must stamp before security',
      DRIVER: !d.security_stamp && 'Security must stamp before driver acknowledgement',
      CUSTOMER: !d.driver_acknowledged && 'Driver must acknowledge before delivery confirmation'
    }[stage];
    if (prereqMissing) {
      if (conflictAsError) throw g.conflict(prereqMissing, d, p);
      throw new HttpError(409, prereqMissing);
    }
  }

  if (stage === 'CUSTOMER' && (d.dispatch_status === DISPATCH_STATUS.DELIVERED || d.dispatch_status === DISPATCH_STATUS.RETURNED)) {
    if (conflictAsError) throw g.conflict(`Dispatch already ${d.dispatch_status}`, d, p);
    throw new HttpError(409, `Dispatch already ${d.dispatch_status}`);
  }

  /* ---------------- WAREHOUSE ---------------- */
  if (stage === 'WAREHOUSE') {
    await withTransaction(async (tx) => {
      if (Array.isArray(p.loadedQuantities)) {
        for (const lq of p.loadedQuantities) {
          if (lq.lineKey && lq.loadedQty !== undefined) {
            await tx.query(
              `UPDATE fact_dispatch_line SET loaded_qty = @loadedQty
                 WHERE dispatch_line_key = @lineKey AND dispatch_key = @dispatchKey`,
              { loadedQty: lq.loadedQty, lineKey: lq.lineKey, dispatchKey }
            );
          }
        }
      }
      await tx.query(
        `UPDATE fact_dispatch SET
           warehouse_stamp = 1,
           warehouse_signed_by_key = @userKey,
           warehouse_sign_datetime = GETDATE(),
           dispatch_status = CASE WHEN dispatch_status = 'PENDING' THEN 'LOADED' ELSE dispatch_status END,
           updated_at = GETDATE()
         WHERE dispatch_key = @dispatchKey AND business_key = @businessKey`,
        { userKey: actor.userKey, dispatchKey, businessKey: actor.businessKey }
      );
      // Transactional outbox: stamp + DISPATCHES change row commit together.
      await recordChange(tx, {
        dataset: 'DISPATCHES',
        businessKey: actor.businessKey,
        entityKey: dispatchKey,
        op: CHANGE_OP.UPSERT
      });
    });
    return { dispatchKey, status: 'LOADED', alreadyStamped: false };
  }

  /* ---------------- SECURITY ---------------- */
  if (stage === 'SECURITY') {
    // Single statement + outbox row in ONE transaction (TD-4/PULL).
    await withTransaction(async (tx) => {
      await tx.query(
        `UPDATE fact_dispatch SET
           security_stamp = 1,
           security_signed_by_key = @userKey,
           security_sign_datetime = GETDATE(),
           dispatch_status = CASE WHEN dispatch_status IN ('PENDING','LOADED') THEN 'LOADED' ELSE dispatch_status END,
           updated_at = GETDATE()
         WHERE dispatch_key = @dispatchKey AND business_key = @businessKey`,
        { userKey: actor.userKey, dispatchKey, businessKey: actor.businessKey }
      );
      await recordChange(tx, {
        dataset: 'DISPATCHES',
        businessKey: actor.businessKey,
        entityKey: dispatchKey,
        op: CHANGE_OP.UPSERT
      });
    });
    return { dispatchKey, status: 'LOADED', alreadyStamped: false };
  }

  /* ---------------- DRIVER ---------------- */
  if (stage === 'DRIVER') {
    // Single statement + outbox row in ONE transaction (TD-4/PULL).
    await withTransaction(async (tx) => {
      await tx.query(
        `UPDATE fact_dispatch SET
           driver_acknowledged = 1,
           driver_ack_datetime = GETDATE(),
           driver_signature_url = @driverSignatureUrl,
           dispatch_status = 'IN_TRANSIT',
           updated_at = GETDATE()
         WHERE dispatch_key = @dispatchKey AND business_key = @businessKey`,
        { driverSignatureUrl: p.driverSignatureUrl || null, dispatchKey, businessKey: actor.businessKey }
      );
      await recordChange(tx, {
        dataset: 'DISPATCHES',
        businessKey: actor.businessKey,
        entityKey: dispatchKey,
        op: CHANGE_OP.UPSERT
      });
    });
    return { dispatchKey, status: 'IN_TRANSIT', alreadyStamped: false };
  }

  /* ---------------- CUSTOMER ---------------- */
  const finalStatus = p.returned ? DISPATCH_STATUS.RETURNED : DISPATCH_STATUS.DELIVERED;
  const dateKey = await g.resolveDateKey(q);

  await withTransaction(async (tx) => {
    if (Array.isArray(p.lineDeliveries)) {
      for (const ld of p.lineDeliveries) {
        if (ld.lineKey && (ld.deliveredQty !== undefined || ld.returnedQty !== undefined)) {
          await tx.query(
            `UPDATE fact_dispatch_line
                SET delivered_qty = @deliveredQty, returned_qty = @returnedQty
              WHERE dispatch_line_key = @lineKey AND dispatch_key = @dispatchKey`,
            { deliveredQty: ld.deliveredQty || 0, returnedQty: ld.returnedQty || 0, lineKey: ld.lineKey, dispatchKey }
          );
        }
      }
    }

    await tx.query(
      `UPDATE fact_dispatch SET
         delivery_datetime = GETDATE(),
         customer_acknowledged = 1,
         customer_signature_url = @customerSignatureUrl,
         return_reason = @returnReason,
         dispatch_status = @finalStatus,
         sync_timestamp = GETDATE(),
         updated_at = GETDATE()
       WHERE dispatch_key = @dispatchKey AND business_key = @businessKey`,
      {
        customerSignatureUrl: p.customerSignatureUrl || null,
        returnReason: p.returned ? (p.returnReason || 'Not specified') : null,
        finalStatus,
        dispatchKey,
        businessKey: actor.businessKey
      }
    );

    // Stock movements: delivered qty leaves stock; returns come back
    const lines = await tx.query(
      `SELECT dispatch_line_key, product_key, delivered_qty, returned_qty
         FROM fact_dispatch_line WHERE dispatch_key = @dispatchKey`,
      { dispatchKey }
    );
    for (const l of lines.recordset) {
      if ((l.delivered_qty || 0) > 0) {
        await tx.query(
          `INSERT INTO fact_stock_movement (
             business_key, product_key, warehouse_location, date_key,
             movement_type, reference_key, reference_type, quantity,
             recorded_by_key, mobile_device_id
           ) VALUES (
             @businessKey, @productKey, 'MAIN', @dateKey,
             @movementType, @dispatchKey, 'DISPATCH', @quantity,
             @recordedByKey, @mobileDeviceId
           )`,
          {
            businessKey: actor.businessKey,
            productKey: l.product_key,
            dateKey,
            movementType: MOVEMENT_TYPE.DISPATCH,
            quantity: l.delivered_qty,
            recordedByKey: actor.userKey,
            mobileDeviceId: actor.deviceId || null
          }
        );
      }
      if ((l.returned_qty || 0) > 0) {
        await tx.query(
          `INSERT INTO fact_stock_movement (
             business_key, product_key, warehouse_location, date_key,
             movement_type, reference_key, reference_type, quantity,
             recorded_by_key, mobile_device_id
           ) VALUES (
             @businessKey, @productKey, 'MAIN', @dateKey,
             @movementTypeIn, @dispatchKey, 'DISPATCH', @quantity,
             @recordedByKey, @mobileDeviceId
           )`,
          {
            businessKey: actor.businessKey,
            productKey: l.product_key,
            dateKey,
            movementTypeIn: MOVEMENT_TYPE.TRANSFER_IN,
            quantity: l.returned_qty,
            recordedByKey: actor.userKey,
            mobileDeviceId: actor.deviceId || null
          }
        );
      }
    }

    // Transactional outbox: final delivery state + stock movements +
    // DISPATCHES change row commit together.
    await recordChange(tx, {
      dataset: 'DISPATCHES',
      businessKey: actor.businessKey,
      entityKey: dispatchKey,
      op: CHANGE_OP.UPSERT
    });
  });

  return { dispatchKey, status: finalStatus, alreadyStamped: false };
}

/* -----------------------------------------------------------------------
   STOCK MOVEMENTS
   ----------------------------------------------------------------------- */

const MANUAL_MOVEMENT_TYPES = [
  MOVEMENT_TYPE.ADJUSTMENT, MOVEMENT_TYPE.TRANSFER_IN, MOVEMENT_TYPE.TRANSFER_OUT,
  MOVEMENT_TYPE.DAMAGED, MOVEMENT_TYPE.EXPIRED
];

/**
 * Record a manual stock movement (adjustment/transfer/damage/expiry).
 * @returns {{ movementKey:number }}
 */
async function recordStockMovement(actor, body) {
  const {
    productKey, movementType, quantity, warehouseLocation, notes,
    toBusinessKey, fromWarehouse, toWarehouse, unitCost
  } = body;

  if (!productKey || !movementType || quantity === undefined || quantity <= 0) {
    throw new HttpError(400, 'productKey, movementType and quantity > 0 are required');
  }
  if (!MANUAL_MOVEMENT_TYPES.includes(movementType)) {
    throw new HttpError(400, `Manual movements must be one of: ${MANUAL_MOVEMENT_TYPES.join(', ')} (RECEIPT/DISPATCH/COUNT are system-generated)`);
  }
  if (movementType === MOVEMENT_TYPE.TRANSFER_OUT && !toBusinessKey) {
    throw new HttpError(400, 'toBusinessKey is required for TRANSFER_OUT');
  }

  await g.assertProductOwned(q, actor.businessKey, productKey, 'Product');
  const dateKey = await g.resolveDateKey(q);

  const result = await executeQuery(
    `INSERT INTO fact_stock_movement (
       business_key, product_key, warehouse_location, date_key,
       movement_type, reference_type, quantity, unit_cost, total_value,
       from_business_key, to_business_key, from_warehouse, to_warehouse,
       notes, recorded_by_key, mobile_device_id, sync_timestamp
     ) OUTPUT INSERTED.movement_key
     VALUES (
       @businessKey, @productKey, @warehouseLocation, @dateKey,
       @movementType, 'ADJUSTMENT', @quantity, @unitCost, @totalValue,
       @fromBusinessKey, @toBusinessKey, @fromWarehouse, @toWarehouse,
       @notes, @recordedByKey, @mobileDeviceId, GETDATE()
     )`,
    {
      businessKey: actor.businessKey,
      productKey,
      warehouseLocation: warehouseLocation || 'MAIN',
      dateKey,
      movementType,
      unitCost: unitCost || null,
      totalValue: unitCost ? unitCost * quantity : null,
      fromBusinessKey: movementType === MOVEMENT_TYPE.TRANSFER_OUT ? actor.businessKey : null,
      toBusinessKey: toBusinessKey || null,
      fromWarehouse: fromWarehouse || null,
      toWarehouse: toWarehouse || null,
      notes: notes || null,
      recordedByKey: actor.userKey,
      mobileDeviceId: actor.deviceId || null
    }
  );
  return { movementKey: result.recordset[0].movement_key };
}

/* -----------------------------------------------------------------------
   STOCK COUNT / RECONCILIATION
   ----------------------------------------------------------------------- */

/**
 * Record a stock count with server-computed variance.
 * The variance is ALWAYS physical_count - system_qty, computed here so
 * the offline processor cannot disagree with the online route.
 * @returns {{ countKey:number, variance:number }}
 */
async function recordStockCount(actor, body) {
  const { productKey, warehouseLocation, systemQty, physicalCount, witnessedByKey, varianceReason } = body;

  if (!productKey || systemQty === undefined || physicalCount === undefined) {
    throw new HttpError(400, 'productKey, systemQty and physicalCount are required');
  }

  await g.assertProductOwned(q, actor.businessKey, productKey, 'Product');
  const dateKey = await g.resolveDateKey(q);
  const variance = physicalCount - systemQty;

  const result = await executeQuery(
    `INSERT INTO fact_stock_count (
       business_key, product_key, warehouse_location, date_key,
       counted_by_key, witnessed_by_key, system_qty, physical_count,
       variance, variance_reason, mobile_device_id, sync_timestamp
     ) OUTPUT INSERTED.count_key
     VALUES (
       @businessKey, @productKey, @warehouseLocation, @dateKey,
       @countedByKey, @witnessedByKey, @systemQty, @physicalCount,
       @variance, @varianceReason, @mobileDeviceId, GETDATE()
     )`,
    {
      businessKey: actor.businessKey,
      productKey,
      warehouseLocation: warehouseLocation || 'MAIN',
      dateKey,
      countedByKey: actor.userKey,
      witnessedByKey: witnessedByKey || null,
      systemQty,
      physicalCount,
      variance,
      varianceReason: variance !== 0 ? (varianceReason || 'Unexplained') : (varianceReason || null),
      mobileDeviceId: actor.deviceId || null
    }
  );

  return { countKey: result.recordset[0].count_key, variance };
}

/* -----------------------------------------------------------------------
   GOODS RETURNS
   ----------------------------------------------------------------------- */

/**
 * Record a goods return: header + TRANSFER_IN stock movement transactional.
 * @returns {{ returnKey:number }}
 */
async function recordGoodsReturn(actor, body) {
  const { customerKey, productKey, returnType, originalInvoice, batchNumber, quantityReturned, creditNoteRequested } = body;

  if (!customerKey || !productKey || !quantityReturned || quantityReturned <= 0) {
    throw new HttpError(400, 'customerKey, productKey and quantityReturned > 0 are required');
  }
  if (!Object.values(RETURN_TYPE).includes(returnType)) {
    throw new HttpError(400, `returnType must be one of: ${Object.values(RETURN_TYPE).join(', ')}`);
  }

  const dateKey = await g.resolveDateKey(q);

  return withTransaction(async (tx) => {
    const tq = (s, p) => tx.query(s, p);
    await g.assertCustomerOwned(tq, actor.businessKey, customerKey);
    await g.assertProductOwned(tq, actor.businessKey, productKey, 'Product');

    const inserted = await tx.query(
      `INSERT INTO fact_goods_return (
         business_key, customer_key, product_key, returned_by_key, date_key,
         return_type, original_invoice, batch_number,
         quantity_returned, credit_note_requested, return_status, mobile_device_id, sync_timestamp
       ) OUTPUT INSERTED.return_key
       VALUES (
         @businessKey, @customerKey, @productKey, @returnedByKey, @dateKey,
         @returnType, @originalInvoice, @batchNumber,
         @quantityReturned, @creditNoteRequested, @returnStatus, @mobileDeviceId, GETDATE()
       )`,
      {
        businessKey: actor.businessKey,
        customerKey,
        productKey,
        returnedByKey: actor.userKey,
        dateKey,
        returnType,
        originalInvoice: originalInvoice || null,
        batchNumber: batchNumber || null,
        quantityReturned,
        creditNoteRequested: creditNoteRequested ? 1 : 0,
        returnStatus: RETURN_STATUS.PENDING,
        mobileDeviceId: actor.deviceId || null
      }
    );

    // Returned goods re-enter stock (unless later rejected at confirmation)
    await tx.query(
      `INSERT INTO fact_stock_movement (
         business_key, product_key, warehouse_location, date_key,
         movement_type, reference_key, reference_type, quantity,
         recorded_by_key, mobile_device_id
       ) VALUES (
         @businessKey, @productKey, 'RETURNS', @dateKey,
         @movementType, @returnKey, 'RETURN', @quantityReturned,
         @recordedByKey, @mobileDeviceId
       )`,
      {
        businessKey: actor.businessKey,
        productKey,
        dateKey,
        movementType: MOVEMENT_TYPE.TRANSFER_IN,
        returnKey: inserted.recordset[0].return_key,
        quantityReturned,
        recordedByKey: actor.userKey,
        mobileDeviceId: actor.deviceId || null
      }
    );

    return { returnKey: inserted.recordset[0].return_key };
  });
}

module.exports = {
  createGRN,
  signoffGRNFinance,
  createDispatch,
  getDispatch,
  stampDispatchCustody,
  recordStockMovement,
  recordStockCount,
  recordGoodsReturn,
  MANUAL_MOVEMENT_TYPES
};
