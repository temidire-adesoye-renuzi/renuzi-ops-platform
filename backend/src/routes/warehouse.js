/* ============================================================================
   WAREHOUSE API ROUTES   All endpoints prefixed with /api/warehouse

   Covers: GRN, Dispatch (with custody chain), Stock Movements,
           Stock Counts, Goods Returns, Stock Position.

   REFACTORED: this file is now a thin HTTP adapter. ALL business logic
   lives in services/warehouseService.js, shared verbatim with the offline
   sync processors (sync/warehouseProcessors.js). Fixes preserved:
   - TD-3: date_key in Africa/Lagos (service layer)
   - TD-4: GRN and Dispatch create transactional (service layer)
   - TD-5: no error internals leaked to clients
   - TD-12: every query scoped by business_key (guards)
   - TD-13: odometer monotonicity (guards, dispatch path)
   - TD-16: dim_date coverage guard (guards)
   ============================================================================ */

const express = require('express');
const router = express.Router();
const { executeQuery } = require('../config/db');
const { authenticateToken } = require('../middleware/auth');
const {
  requireWarehouseManager, requireWarehouseStaff, requireSecurity,
  requireOpsOrAdmin
} = require('../middleware/roleCheck');
const { HttpError } = require('../utils/httpError');
const warehouseService = require('../services/warehouseService');

function fail(res, err, fallback, internal) {
  console.error(internal || fallback, err.message);
  return res.status(500).json({ success: false, message: fallback });
}

/** Map service errors to HTTP responses. */
function serviceErrorResponse(res, err, internal) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ success: false, message: err.publicMessage });
  }
  return fail(res, err, 'Request failed', internal);
}

/* ============================================================================
   GOODS RECEIPT NOTE (GRN)
   ============================================================================ */

// POST /api/warehouse/grn - Create GRN (header + lines, transactional)
router.post('/grn', authenticateToken, requireWarehouseStaff, async (req, res) => {
  try {
    const data = await warehouseService.createGRN(
      {
        userKey: req.user.userKey,
        businessKey: req.user.businessKey,
        deviceId: req.body?.mobileDeviceId || null
      },
      req.body || {}
    );
    return res.status(201).json({ success: true, message: `GRN ${data.grnNumber} recorded`, data });
  } catch (err) {
    return serviceErrorResponse(res, err, '[WH] GRN create error:');
  }
});

// GET /api/warehouse/grn - List GRNs
router.get('/grn', authenticateToken, requireWarehouseStaff, async (req, res) => {
  try {
    const { status, dateFrom, dateTo } = req.query;
    let query = `
      SELECT g.*, s.supplier_name, r.full_name AS received_by_name
        FROM fact_grn g
        LEFT JOIN dim_supplier s ON g.supplier_key = s.supplier_key
        JOIN dim_user r ON g.received_by_key = r.user_key
       WHERE g.business_key = @businessKey
    `;
    const params = { businessKey: req.user.businessKey };
    if (status) { query += ' AND g.receipt_status = @status'; params.status = status; }
    if (dateFrom) { query += ' AND g.created_at >= @dateFrom'; params.dateFrom = dateFrom; }
    if (dateTo) { query += ' AND g.created_at <= @dateTo'; params.dateTo = dateTo; }
    query += ' ORDER BY g.created_at DESC';

    const result = await executeQuery(query, params);
    return res.json({ success: true, count: result.recordset.length, data: result.recordset });
  } catch (err) {
    return fail(res, err, 'Failed to fetch GRNs', '[WH] GRN list error:');
  }
});

// GET /api/warehouse/grn/:grnKey - GRN detail with lines
router.get('/grn/:grnKey', authenticateToken, requireWarehouseStaff, async (req, res) => {
  try {
    const header = await executeQuery(
      `SELECT g.*, s.supplier_name, r.full_name AS received_by_name
         FROM fact_grn g
         LEFT JOIN dim_supplier s ON g.supplier_key = s.supplier_key
         JOIN dim_user r ON g.received_by_key = r.user_key
        WHERE g.grn_key = @grnKey AND g.business_key = @businessKey`,
      { grnKey: req.params.grnKey, businessKey: req.user.businessKey }
    );
    if (header.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'GRN not found' });
    }

    const lines = await executeQuery(
      `SELECT gl.*, p.sku_code, p.product_name, p.unit_of_measure
         FROM fact_grn_line gl
         JOIN dim_product p ON gl.product_key = p.product_key
        WHERE gl.grn_key = @grnKey`,
      { grnKey: req.params.grnKey }
    );

    return res.json({
      success: true,
      data: { ...header.recordset[0], lines: lines.recordset }
    });
  } catch (err) {
    return fail(res, err, 'Failed to fetch GRN', '[WH] GRN detail error:');
  }
});

// PUT /api/warehouse/grn/:grnKey/finance-signoff - Finance signs off GRN
router.put('/grn/:grnKey/finance-signoff', authenticateToken, requireOpsOrAdmin, async (req, res) => {
  try {
    const { creditNoteIssued, creditNoteNumber } = req.body || {};
    await warehouseService.signoffGRNFinance(
      { userKey: req.user.userKey, businessKey: req.user.businessKey },
      Number(req.params.grnKey),
      { creditNoteIssued, creditNoteNumber }
    );
    return res.json({ success: true, message: 'Finance signoff recorded' });
  } catch (err) {
    return serviceErrorResponse(res, err, '[WH] GRN signoff error:');
  }
});

/* ============================================================================
   DISPATCH / OUTBOUND
   ============================================================================ */

// POST /api/warehouse/dispatch - Create dispatch (header + lines, transactional)
router.post('/dispatch', authenticateToken, requireWarehouseStaff, async (req, res) => {
  try {
    const { mobileDeviceId } = req.body || {};
    const data = await warehouseService.createDispatch(
      { userKey: req.user.userKey, businessKey: req.user.businessKey, deviceId: mobileDeviceId },
      req.body || {}
    );
    return res.status(201).json({ success: true, message: `Dispatch ${data.dispatchNumber} created`, data });
  } catch (err) {
    return serviceErrorResponse(res, err, '[WH] dispatch create error:');
  }
});

// GET /api/warehouse/dispatch - List dispatches
router.get('/dispatch', authenticateToken, requireWarehouseStaff, async (req, res) => {
  try {
    const { status, customerKey, dateFrom, dateTo } = req.query;
    let query = `
      SELECT d.*, c.customer_name, drv.full_name AS driver_name, v.plate_number,
             dsp.full_name AS dispatched_by_name
        FROM fact_dispatch d
        JOIN dim_customer c ON d.customer_key = c.customer_key
        LEFT JOIN dim_user drv ON d.driver_key = drv.user_key
        LEFT JOIN dim_vehicle v ON d.vehicle_key = v.vehicle_key
        JOIN dim_user dsp ON d.dispatched_by_key = dsp.user_key
       WHERE d.business_key = @businessKey
    `;
    const params = { businessKey: req.user.businessKey };
    if (status) { query += ' AND d.dispatch_status = @status'; params.status = status; }
    if (customerKey) { query += ' AND d.customer_key = @customerKey'; params.customerKey = customerKey; }
    if (dateFrom) { query += ' AND d.created_at >= @dateFrom'; params.dateFrom = dateFrom; }
    if (dateTo) { query += ' AND d.created_at <= @dateTo'; params.dateTo = dateTo; }
    query += ' ORDER BY d.created_at DESC';

    const result = await executeQuery(query, params);
    return res.json({ success: true, count: result.recordset.length, data: result.recordset });
  } catch (err) {
    return fail(res, err, 'Failed to fetch dispatches', '[WH] dispatch list error:');
  }
});

// GET /api/warehouse/dispatch/:dispatchKey - Dispatch detail with lines
router.get('/dispatch/:dispatchKey', authenticateToken, requireWarehouseStaff, async (req, res) => {
  try {
    const header = await executeQuery(
      `SELECT d.*, c.customer_name, drv.full_name AS driver_name, v.plate_number
         FROM fact_dispatch d
         JOIN dim_customer c ON d.customer_key = c.customer_key
         LEFT JOIN dim_user drv ON d.driver_key = drv.user_key
         LEFT JOIN dim_vehicle v ON d.vehicle_key = v.vehicle_key
        WHERE d.dispatch_key = @dispatchKey AND d.business_key = @businessKey`,
      { dispatchKey: req.params.dispatchKey, businessKey: req.user.businessKey }
    );
    if (header.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Dispatch not found' });
    }

    const lines = await executeQuery(
      `SELECT dl.*, p.sku_code, p.product_name, p.unit_of_measure
         FROM fact_dispatch_line dl
         JOIN dim_product p ON dl.product_key = p.product_key
        WHERE dl.dispatch_key = @dispatchKey`,
      { dispatchKey: req.params.dispatchKey }
    );

    return res.json({
      success: true,
      data: { ...header.recordset[0], lines: lines.recordset }
    });
  } catch (err) {
    return fail(res, err, 'Failed to fetch dispatch', '[WH] dispatch detail error:');
  }
});

/* ----------------------------------------------------------------------------
   Dispatch custody chain stamps (warehouse -> security -> driver -> customer)
   Logic lives in warehouseService.stampDispatchCustody; these adapters
   enforce WHO may stamp each stage.
   -------------------------------------------------------------------------- */

// PUT /api/warehouse/dispatch/:dispatchKey/warehouse-stamp
router.put('/dispatch/:dispatchKey/warehouse-stamp', authenticateToken, requireWarehouseStaff, async (req, res) => {
  try {
    const { loadedQuantities } = req.body || {};
    await warehouseService.stampDispatchCustody(
      { userKey: req.user.userKey, businessKey: req.user.businessKey },
      Number(req.params.dispatchKey),
      'WAREHOUSE',
      { loadedQuantities }
    );
    return res.json({ success: true, message: 'Warehouse stamp applied' });
  } catch (err) {
    return serviceErrorResponse(res, err, '[WH] warehouse stamp error:');
  }
});

// PUT /api/warehouse/dispatch/:dispatchKey/security-stamp
router.put('/dispatch/:dispatchKey/security-stamp', authenticateToken, requireSecurity, async (req, res) => {
  try {
    await warehouseService.stampDispatchCustody(
      { userKey: req.user.userKey, businessKey: req.user.businessKey },
      Number(req.params.dispatchKey),
      'SECURITY',
      {}
    );
    return res.json({ success: true, message: 'Security stamp applied' });
  } catch (err) {
    return serviceErrorResponse(res, err, '[WH] security stamp error:');
  }
});

// PUT /api/warehouse/dispatch/:dispatchKey/driver-ack
router.put('/dispatch/:dispatchKey/driver-ack', authenticateToken, async (req, res) => {
  try {
    const { driverSignatureUrl } = req.body || {};
    const dispatchKey = Number(req.params.dispatchKey);

    // Drivers may acknowledge their own dispatches; managers any dispatch.
    const d = await warehouseService.getDispatch(
      { userKey: req.user.userKey, businessKey: req.user.businessKey },
      dispatchKey
    );
    if (!d) return res.status(404).json({ success: false, message: 'Dispatch not found' });
    const isAssignedDriver = d.driver_key === req.user.userKey;
    const isManager = ['FLEET_MANAGER', 'OPS_MANAGER', 'ADMIN'].includes(req.user.role);
    if (!isAssignedDriver && !isManager) {
      return res.status(403).json({ success: false, message: 'Only the assigned driver or a manager can acknowledge this dispatch' });
    }

    await warehouseService.stampDispatchCustody(
      { userKey: req.user.userKey, businessKey: req.user.businessKey },
      dispatchKey,
      'DRIVER',
      { driverSignatureUrl }
    );
    return res.json({ success: true, message: 'Driver acknowledgement recorded' });
  } catch (err) {
    return serviceErrorResponse(res, err, '[WH] driver ack error:');
  }
});

// PUT /api/warehouse/dispatch/:dispatchKey/customer-ack - Delivery confirmation
router.put('/dispatch/:dispatchKey/customer-ack', authenticateToken, async (req, res) => {
  try {
    const dispatchKey = Number(req.params.dispatchKey);
    const { customerSignatureUrl, returned, returnReason, lineDeliveries, mobileDeviceId } = req.body || {};

    const d = await warehouseService.getDispatch(
      { userKey: req.user.userKey, businessKey: req.user.businessKey },
      dispatchKey
    );
    if (!d) return res.status(404).json({ success: false, message: 'Dispatch not found' });
    const isAssignedDriver = d.driver_key === req.user.userKey;
    const isManager = ['FLEET_MANAGER', 'OPS_MANAGER', 'WAREHOUSE_MANAGER', 'ADMIN'].includes(req.user.role);
    if (!isAssignedDriver && !isManager) {
      return res.status(403).json({ success: false, message: 'Only the assigned driver or a manager can confirm delivery' });
    }

    const result = await warehouseService.stampDispatchCustody(
      { userKey: req.user.userKey, businessKey: req.user.businessKey, deviceId: mobileDeviceId },
      dispatchKey,
      'CUSTOMER',
      { customerSignatureUrl, returned, returnReason, lineDeliveries }
    );
    return res.json({ success: true, message: `Dispatch marked ${result.status}` });
  } catch (err) {
    return serviceErrorResponse(res, err, '[WH] customer ack error:');
  }
});

/* ============================================================================
   STOCK MOVEMENTS
   ============================================================================ */

// GET /api/warehouse/movements - List stock movements
router.get('/movements', authenticateToken, requireWarehouseStaff, async (req, res) => {
  try {
    const { productKey, movementType, dateFrom, dateTo, location } = req.query;
    let query = `
      SELECT sm.*, p.sku_code, p.product_name, u.full_name AS recorded_by_name
        FROM fact_stock_movement sm
        JOIN dim_product p ON sm.product_key = p.product_key
        JOIN dim_user u ON sm.recorded_by_key = u.user_key
       WHERE sm.business_key = @businessKey
    `;
    const params = { businessKey: req.user.businessKey };
    if (productKey) { query += ' AND sm.product_key = @productKey'; params.productKey = productKey; }
    if (movementType) { query += ' AND sm.movement_type = @movementType'; params.movementType = movementType; }
    if (location) { query += ' AND sm.warehouse_location = @location'; params.location = location; }
    if (dateFrom) { query += ' AND sm.created_at >= @dateFrom'; params.dateFrom = dateFrom; }
    if (dateTo) { query += ' AND sm.created_at <= @dateTo'; params.dateTo = dateTo; }
    query += ' ORDER BY sm.created_at DESC';

    const result = await executeQuery(query, params);
    return res.json({ success: true, count: result.recordset.length, data: result.recordset });
  } catch (err) {
    return fail(res, err, 'Failed to fetch movements', '[WH] movements list error:');
  }
});

// POST /api/warehouse/movements - Manual adjustment / transfer / damage / expiry
router.post('/movements', authenticateToken, requireWarehouseManager, async (req, res) => {
  try {
    const { mobileDeviceId } = req.body || {};
    const data = await warehouseService.recordStockMovement(
      { userKey: req.user.userKey, businessKey: req.user.businessKey, deviceId: mobileDeviceId },
      req.body || {}
    );
    return res.status(201).json({ success: true, message: 'Stock movement recorded', data });
  } catch (err) {
    return serviceErrorResponse(res, err, '[WH] movement create error:');
  }
});

/* ============================================================================
   STOCK COUNT / RECONCILIATION
   ============================================================================ */

// POST /api/warehouse/counts - Record a stock count (variance computed server-side)
router.post('/counts', authenticateToken, requireWarehouseStaff, async (req, res) => {
  try {
    const { mobileDeviceId } = req.body || {};
    const data = await warehouseService.recordStockCount(
      { userKey: req.user.userKey, businessKey: req.user.businessKey, deviceId: mobileDeviceId },
      req.body || {}
    );
    return res.status(201).json({ success: true, message: 'Stock count recorded', data });
  } catch (err) {
    return serviceErrorResponse(res, err, '[WH] count create error:');
  }
});

// GET /api/warehouse/counts - List counts (variances highlighted)
router.get('/counts', authenticateToken, requireWarehouseStaff, async (req, res) => {
  try {
    const { onlyVariances, dateFrom, dateTo } = req.query;
    let query = `
      SELECT sc.*, p.sku_code, p.product_name, c.full_name AS counted_by_name
        FROM fact_stock_count sc
        JOIN dim_product p ON sc.product_key = p.product_key
        JOIN dim_user c ON sc.counted_by_key = c.user_key
       WHERE sc.business_key = @businessKey
    `;
    const params = { businessKey: req.user.businessKey };
    if (onlyVariances === 'true' || onlyVariances === '1') { query += ' AND sc.variance != 0'; }
    if (dateFrom) { query += ' AND sc.created_at >= @dateFrom'; params.dateFrom = dateFrom; }
    if (dateTo) { query += ' AND sc.created_at <= @dateTo'; params.dateTo = dateTo; }
    query += ' ORDER BY sc.created_at DESC';

    const result = await executeQuery(query, params);
    return res.json({ success: true, count: result.recordset.length, data: result.recordset });
  } catch (err) {
    return fail(res, err, 'Failed to fetch counts', '[WH] counts list error:');
  }
});

/* ============================================================================
   GOODS RETURNS
   ============================================================================ */

// POST /api/warehouse/returns - Record a goods return
router.post('/returns', authenticateToken, requireWarehouseStaff, async (req, res) => {
  try {
    const { mobileDeviceId } = req.body || {};
    const data = await warehouseService.recordGoodsReturn(
      { userKey: req.user.userKey, businessKey: req.user.businessKey, deviceId: mobileDeviceId },
      req.body || {}
    );
    return res.status(201).json({ success: true, message: 'Goods return recorded', data });
  } catch (err) {
    return serviceErrorResponse(res, err, '[WH] return create error:');
  }
});

// GET /api/warehouse/returns - List returns
router.get('/returns', authenticateToken, requireWarehouseStaff, async (req, res) => {
  try {
    const { status, dateFrom, dateTo } = req.query;
    let query = `
      SELECT gr.*, c.customer_name, p.sku_code, p.product_name, u.full_name AS returned_by_name
        FROM fact_goods_return gr
        JOIN dim_customer c ON gr.customer_key = c.customer_key
        JOIN dim_product p ON gr.product_key = p.product_key
        JOIN dim_user u ON gr.returned_by_key = u.user_key
       WHERE gr.business_key = @businessKey
    `;
    const params = { businessKey: req.user.businessKey };
    if (status) { query += ' AND gr.return_status = @status'; params.status = status; }
    if (dateFrom) { query += ' AND gr.created_at >= @dateFrom'; params.dateFrom = dateFrom; }
    if (dateTo) { query += ' AND gr.created_at <= @dateTo'; params.dateTo = dateTo; }
    query += ' ORDER BY gr.created_at DESC';

    const result = await executeQuery(query, params);
    return res.json({ success: true, count: result.recordset.length, data: result.recordset });
  } catch (err) {
    return fail(res, err, 'Failed to fetch returns', '[WH] returns list error:');
  }
});

/* ============================================================================
   STOCK POSITION (read from vw_stock_position)
   ============================================================================ */

// GET /api/warehouse/stock-position - Current stock by SKU
router.get('/stock-position', authenticateToken, requireWarehouseStaff, async (req, res) => {
  try {
    const { skuCode, category, location } = req.query;
    let query = `
      SELECT *
        FROM vw_stock_position
       WHERE business_key = @businessKey
    `;
    const params = { businessKey: req.user.businessKey };
    if (skuCode) { query += ' AND sku_code LIKE @skuCode'; params.skuCode = `%${skuCode}%`; }
    if (category) { query += ' AND category = @category'; params.category = category; }
    if (location) { query += ' AND warehouse_location = @location'; params.location = location; }
    query += ' ORDER BY product_name';

    const result = await executeQuery(query, params);
    return res.json({ success: true, count: result.recordset.length, data: result.recordset });
  } catch (err) {
    return fail(res, err, 'Failed to fetch stock position', '[WH] stock position error:');
  }
});

module.exports = router;
