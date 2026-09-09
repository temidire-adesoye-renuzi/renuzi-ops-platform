/* ============================================================================
   FLEET API ROUTES   All endpoints prefixed with /api/fleet

   REFACTORED: thin HTTP adapter over services/fleetService.js, which is
   the exact same logic the offline sync processors run. Fixes preserved:
   - TD-3: date_key computed in Africa/Lagos (service layer)
   - TD-4: trip start/end + vehicle status updates transactional (service layer)
   - TD-5: no err.message/err.stack leaks; generic 500s in production
   - TD-6: vehicle status uses VEHICLE_STATUS enum (service layer)
   - TD-7: maintenance approval CASE logic corrected (service layer)
    - TD-12: every query scoped by business_key (guards)
    - TD-13: odometer monotonicity enforced (guards)
    - TD-16: dim_date coverage guard (guards)
    - PULL:  dim_vehicle writes emit change-log rows in-transaction
             (service layer; see fleetService.js)
    ============================================================================ */

const express = require('express');
const router = express.Router();
const { executeQuery } = require('../config/db');
const { authenticateToken } = require('../middleware/auth');
const { requireDriver, requireFleetManager, requireAny } = require('../middleware/roleCheck');
const { HttpError } = require('../utils/httpError');
const fleetService = require('../services/fleetService');
const g = require('../services/guards');

function fail(res, err, fallback, internal) {
  console.error(internal || fallback, err.message);
  return res.status(500).json({ success: false, message: fallback });
}

function serviceErrorResponse(res, err, internal) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ success: false, message: err.publicMessage });
  }
  return fail(res, err, 'Request failed', internal);
}

/* ============================================================================
   VEHICLES
   ============================================================================ */

// GET /api/fleet/vehicles - List all vehicles for the user's business
router.get('/vehicles', authenticateToken, requireAny, async (req, res) => {
  try {
    const result = await executeQuery(
      `SELECT v.*, d.full_name AS assigned_driver_name
         FROM dim_vehicle v
         LEFT JOIN dim_user d ON v.assigned_driver_key = d.user_key
        WHERE v.business_key = @businessKey
        ORDER BY v.vehicle_id`,
      { businessKey: req.user.businessKey }
    );
    res.json({ success: true, count: result.recordset.length, data: result.recordset });
  } catch (err) {
    return fail(res, err, 'Failed to fetch vehicles', '[FLEET] vehicles error:');
  }
});

// GET /api/fleet/vehicles/:vehicleKey
router.get('/vehicles/:vehicleKey', authenticateToken, requireAny, async (req, res) => {
  try {
    const result = await executeQuery(
      `SELECT v.*, d.full_name AS assigned_driver_name
         FROM dim_vehicle v
         LEFT JOIN dim_user d ON v.assigned_driver_key = d.user_key
        WHERE v.vehicle_key = @vehicleKey AND v.business_key = @businessKey`,
      { vehicleKey: req.params.vehicleKey, businessKey: req.user.businessKey }
    );
    if (result.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }
    res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    return fail(res, err, 'Failed to fetch vehicle', '[FLEET] vehicle error:');
  }
});

// PUT /api/fleet/vehicles/:vehicleKey/odometer - TD-13 monotonicity
// Transaction + VEHICLES outbox emit live in fleetService.updateVehicleOdometer.
router.put('/vehicles/:vehicleKey/odometer', authenticateToken, requireDriver, async (req, res) => {
  try {
    const { odometerReading } = req.body || {};
    await fleetService.updateVehicleOdometer(
      { userKey: req.user.userKey, businessKey: req.user.businessKey },
      { vehicleKey: Number(req.params.vehicleKey), odometerReading }
    );
    res.json({ success: true, message: 'Odometer updated' });
  } catch (err) {
    return serviceErrorResponse(res, err, '[FLEET] odometer error:');
  }
});

/* ============================================================================
   VEHICLE CHECKS (Digital Checklist)
   ============================================================================ */

// POST /api/fleet/checks - Submit a vehicle daily check (Driver App)
router.post('/checks', authenticateToken, requireDriver, async (req, res) => {
  try {
    const { mobileDeviceId } = req.body || {};
    const data = await fleetService.recordVehicleCheck(
      { userKey: req.user.userKey, businessKey: req.user.businessKey, deviceId: mobileDeviceId },
      req.body || {}
    );
    res.status(201).json({ success: true, message: 'Vehicle check recorded', data });
  } catch (err) {
    return serviceErrorResponse(res, err, '[FLEET] check error:');
  }
});

// GET /api/fleet/checks - List checks (Fleet Manager view)
router.get('/checks', authenticateToken, requireFleetManager, async (req, res) => {
  try {
    const { vehicleKey, dateFrom, dateTo, status } = req.query;

    let query = `
      SELECT vc.*, v.vehicle_id, v.plate_number, d.full_name AS driver_name
        FROM fact_vehicle_check vc
        JOIN dim_vehicle v ON vc.vehicle_key = v.vehicle_key
        JOIN dim_user d ON vc.driver_key = d.user_key
       WHERE vc.business_key = @businessKey
    `;
    const params = { businessKey: req.user.businessKey };

    if (vehicleKey) { query += ' AND vc.vehicle_key = @vehicleKey'; params.vehicleKey = vehicleKey; }
    if (status) { query += ' AND vc.check_status = @status'; params.status = status; }
    if (dateFrom) { query += ' AND vc.check_datetime >= @dateFrom'; params.dateFrom = dateFrom; }
    if (dateTo) { query += ' AND vc.check_datetime <= @dateTo'; params.dateTo = dateTo; }

    query += ' ORDER BY vc.check_datetime DESC';

    const result = await executeQuery(query, params);
    res.json({ success: true, count: result.recordset.length, data: result.recordset });
  } catch (err) {
    return fail(res, err, 'Failed to fetch checks', '[FLEET] checks list error:');
  }
});

/* ============================================================================
   TRIPS
   ============================================================================ */

// POST /api/fleet/trips/start - Start a new trip (Driver App)
router.post('/trips/start', authenticateToken, requireDriver, async (req, res) => {
  try {
    const { mobileDeviceId } = req.body || {};
    const data = await fleetService.startTrip(
      { userKey: req.user.userKey, businessKey: req.user.businessKey, deviceId: mobileDeviceId },
      req.body || {}
    );
    res.status(201).json({ success: true, message: 'Trip started', data });
  } catch (err) {
    return serviceErrorResponse(res, err, '[FLEET] start trip error:');
  }
});

// POST /api/fleet/trips/:tripKey/end - End a trip
router.post('/trips/:tripKey/end', authenticateToken, requireDriver, async (req, res) => {
  try {
    const { mobileDeviceId } = req.body || {};
    const data = await fleetService.endTrip(
      { userKey: req.user.userKey, businessKey: req.user.businessKey, deviceId: mobileDeviceId },
      { ...req.body, tripKey: Number(req.params.tripKey) }
    );
    res.json({ success: true, message: 'Trip completed', data });
  } catch (err) {
    return serviceErrorResponse(res, err, '[FLEET] end trip error:');
  }
});

// GET /api/fleet/trips - List trips
router.get('/trips', authenticateToken, requireAny, async (req, res) => {
  try {
    const { vehicleKey, driverKey, status, dateFrom, dateTo } = req.query;

    let query = `
      SELECT t.*, v.vehicle_id, v.plate_number, d.full_name AS driver_name, r.route_name
        FROM fact_trip t
        JOIN dim_vehicle v ON t.vehicle_key = v.vehicle_key
        JOIN dim_user d ON t.driver_key = d.user_key
        LEFT JOIN dim_route r ON t.route_key = r.route_key
       WHERE t.business_key = @businessKey
    `;
    const params = { businessKey: req.user.businessKey };

    if (vehicleKey) { query += ' AND t.vehicle_key = @vehicleKey'; params.vehicleKey = vehicleKey; }
    if (driverKey) { query += ' AND t.driver_key = @driverKey'; params.driverKey = driverKey; }
    if (status) { query += ' AND t.trip_status = @status'; params.status = status; }
    if (dateFrom) { query += ' AND t.trip_start_time >= @dateFrom'; params.dateFrom = dateFrom; }
    if (dateTo) { query += ' AND t.trip_start_time <= @dateTo'; params.dateTo = dateTo; }

    query += ' ORDER BY t.trip_start_time DESC';

    const result = await executeQuery(query, params);
    res.json({ success: true, count: result.recordset.length, data: result.recordset });
  } catch (err) {
    return fail(res, err, 'Failed to fetch trips', '[FLEET] trips list error:');
  }
});

/* ============================================================================
   FUEL REQUESTS
   ============================================================================ */

// POST /api/fleet/fuel-requests - Driver requests fuel
router.post('/fuel-requests', authenticateToken, requireDriver, async (req, res) => {
  try {
    const { mobileDeviceId } = req.body || {};
    const data = await fleetService.createFuelRequest(
      { userKey: req.user.userKey, businessKey: req.user.businessKey, deviceId: mobileDeviceId },
      req.body || {}
    );
    res.status(201).json({ success: true, message: 'Fuel request submitted', data });
  } catch (err) {
    return serviceErrorResponse(res, err, '[FLEET] fuel request error:');
  }
});

// GET /api/fleet/fuel-requests - List fuel requests (Fleet Manager view)
router.get('/fuel-requests', authenticateToken, requireFleetManager, async (req, res) => {
  try {
    const { status, vehicleKey, dateFrom, dateTo } = req.query;

    let query = `
      SELECT fr.*, v.vehicle_id, v.plate_number, d.full_name AS driver_name,
             a.full_name AS approved_by_name
        FROM fact_fuel_request fr
        JOIN dim_vehicle v ON fr.vehicle_key = v.vehicle_key
        JOIN dim_user d ON fr.driver_key = d.user_key
        LEFT JOIN dim_user a ON fr.approved_by_key = a.user_key
       WHERE fr.business_key = @businessKey
    `;
    const params = { businessKey: req.user.businessKey };
    if (status) { query += ' AND fr.approval_status = @status'; params.status = status; }
    if (vehicleKey) { query += ' AND fr.vehicle_key = @vehicleKey'; params.vehicleKey = vehicleKey; }
    if (dateFrom) { query += ' AND fr.request_datetime >= @dateFrom'; params.dateFrom = dateFrom; }
    if (dateTo) { query += ' AND fr.request_datetime <= @dateTo'; params.dateTo = dateTo; }
    query += ' ORDER BY fr.request_datetime DESC';

    const result = await executeQuery(query, params);
    res.json({ success: true, count: result.recordset.length, data: result.recordset });
  } catch (err) {
    return fail(res, err, 'Failed to fetch fuel requests', '[FLEET] fuel requests list error:');
  }
});

// PUT /api/fleet/fuel-requests/:fuelRequestKey/approve - Approve/Reject
router.put('/fuel-requests/:fuelRequestKey/approve', authenticateToken, requireFleetManager, async (req, res) => {
  try {
    const { approvalStatus, approvalNotes, disbursedAmount } = req.body || {};
    const { FUEL_REQUEST_STATUS } = require('../constants');
    if (![FUEL_REQUEST_STATUS.APPROVED, FUEL_REQUEST_STATUS.REJECTED].includes(approvalStatus)) {
      return res.status(400).json({ success: false, message: 'approvalStatus must be APPROVED or REJECTED' });
    }

    await fleetService.decideFuelRequest(
      { userKey: req.user.userKey, businessKey: req.user.businessKey },
      Number(req.params.fuelRequestKey),
      { approvalStatus, approvalNotes, disbursedAmount }
    );
    res.json({ success: true, message: `Fuel request ${approvalStatus.toLowerCase()}` });
  } catch (err) {
    return serviceErrorResponse(res, err, '[FLEET] fuel approve error:');
  }
});

// POST /api/fleet/fuel-logs - Log actual refueling (Driver)
router.post('/fuel-logs', authenticateToken, requireDriver, async (req, res) => {
  try {
    const { mobileDeviceId } = req.body || {};
    const data = await fleetService.recordFuelLog(
      { userKey: req.user.userKey, businessKey: req.user.businessKey, deviceId: mobileDeviceId },
      req.body || {}
    );
    res.status(201).json({ success: true, message: 'Fuel log recorded', data });
  } catch (err) {
    return serviceErrorResponse(res, err, '[FLEET] fuel log error:');
  }
});

/* ============================================================================
   MAINTENANCE
   ============================================================================ */

// POST /api/fleet/maintenance - Report maintenance issue
router.post('/maintenance', authenticateToken, requireAny, async (req, res) => {
  try {
    const { mobileDeviceId } = req.body || {};
    const data = await fleetService.reportMaintenance(
      { userKey: req.user.userKey, businessKey: req.user.businessKey, deviceId: mobileDeviceId },
      req.body || {}
    );
    res.status(201).json({
      success: true,
      message: `Maintenance ticket created${data.needsMdApproval ? ' (requires MD approval)' : ''}`,
      data
    });
  } catch (err) {
    return serviceErrorResponse(res, err, '[FLEET] maintenance create error:');
  }
});

// GET /api/fleet/maintenance - List maintenance tickets
router.get('/maintenance', authenticateToken, requireFleetManager, async (req, res) => {
  try {
    const { status, vehicleKey, priority } = req.query;

    let query = `
      SELECT m.*, v.vehicle_id, v.plate_number, r.full_name AS reported_by_name,
             ops.full_name AS ops_approved_by_name, md.full_name AS md_approved_by_name
        FROM fact_maintenance m
        JOIN dim_vehicle v ON m.vehicle_key = v.vehicle_key
        JOIN dim_user r ON m.reported_by_key = r.user_key
        LEFT JOIN dim_user ops ON m.ops_approved_by_key = ops.user_key
        LEFT JOIN dim_user md ON m.md_approved_by_key = md.user_key
       WHERE m.business_key = @businessKey
    `;
    const params = { businessKey: req.user.businessKey };
    if (status) { query += ' AND m.maintenance_status = @status'; params.status = status; }
    if (vehicleKey) { query += ' AND m.vehicle_key = @vehicleKey'; params.vehicleKey = vehicleKey; }
    if (priority) { query += ' AND m.priority = @priority'; params.priority = priority; }
    query += ' ORDER BY m.created_at DESC';

    const result = await executeQuery(query, params);
    res.json({ success: true, count: result.recordset.length, data: result.recordset });
  } catch (err) {
    return fail(res, err, 'Failed to fetch maintenance', '[FLEET] maintenance list error:');
  }
});

// PUT /api/fleet/maintenance/:maintenanceKey/approve - TD-7 corrected approval
router.put('/maintenance/:maintenanceKey/approve', authenticateToken, requireFleetManager, async (req, res) => {
  try {
    const { approvalLevel } = req.body || {};
    if (!['OPS', 'MD'].includes(approvalLevel)) {
      return res.status(400).json({ success: false, message: 'approvalLevel must be OPS or MD' });
    }

    const { needsMd } = await fleetService.approveMaintenance(
      { userKey: req.user.userKey, businessKey: req.user.businessKey },
      Number(req.params.maintenanceKey),
      approvalLevel
    );

    res.json({
      success: true,
      message: needsMd
        ? 'OPS approval recorded. MD approval still required (above threshold).'
        : 'OPS approval recorded. Ticket fully approved (within threshold).'
    });
  } catch (err) {
    return serviceErrorResponse(res, err, '[FLEET] maintenance approve error:');
  }
});

// PUT /api/fleet/maintenance/:maintenanceKey/status - Workflow status
router.put('/maintenance/:maintenanceKey/status', authenticateToken, requireFleetManager, async (req, res) => {
  try {
    const { maintenanceStatus, completionNotes, actualCost, vendorName, invoiceNumber } = req.body || {};
    const { MAINTENANCE_STATUS, APPROVAL_STATUS } = require('../constants');

    if (!Object.values(MAINTENANCE_STATUS).includes(maintenanceStatus)) {
      return res.status(400).json({
        success: false,
        message: `maintenanceStatus must be one of: ${Object.values(MAINTENANCE_STATUS).join(', ')}`
      });
    }

    const maintenanceKey = Number(req.params.maintenanceKey);
    const ticket = await executeQuery(
      'SELECT approval_status FROM fact_maintenance WHERE maintenance_key = @maintenanceKey AND business_key = @businessKey',
      { maintenanceKey, businessKey: req.user.businessKey }
    );
    if (ticket.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    if (maintenanceStatus === MAINTENANCE_STATUS.IN_PROGRESS || maintenanceStatus === MAINTENANCE_STATUS.COMPLETED) {
      const s = ticket.recordset[0].approval_status;
      if (s !== APPROVAL_STATUS.MD_APPROVED && s !== APPROVAL_STATUS.OPS_APPROVED) {
        return res.status(409).json({ success: false, message: 'Ticket must be approved before work can progress' });
      }
    }

    await executeQuery(
      `UPDATE fact_maintenance SET
         maintenance_status = @maintenanceStatus,
         completion_notes = COALESCE(@completionNotes, completion_notes),
         actual_cost = COALESCE(@actualCost, actual_cost),
         vendor_name = COALESCE(@vendorName, vendor_name),
         invoice_number = COALESCE(@invoiceNumber, invoice_number),
         work_start_date = CASE WHEN @maintenanceStatus = 'IN_PROGRESS' AND work_start_date IS NULL THEN CAST(GETDATE() AS DATE) ELSE work_start_date END,
         work_completion_date = CASE WHEN @maintenanceStatus = 'COMPLETED' THEN CAST(GETDATE() AS DATE) ELSE work_completion_date END,
         updated_at = GETDATE()
       WHERE maintenance_key = @maintenanceKey AND business_key = @businessKey`,
      {
        maintenanceStatus,
        completionNotes: completionNotes || null,
        actualCost: actualCost === undefined ? null : actualCost,
        vendorName: vendorName || null,
        invoiceNumber: invoiceNumber || null,
        maintenanceKey,
        businessKey: req.user.businessKey
      }
    );

    res.json({ success: true, message: `Maintenance marked ${maintenanceStatus}` });
  } catch (err) {
    return fail(res, err, 'Status update failed', '[FLEET] maintenance status error:');
  }
});

/* ============================================================================
   ROUTES (delivery route dimension)
   ============================================================================ */

router.get('/routes', authenticateToken, requireAny, async (req, res) => {
  try {
    const result = await executeQuery(
      `SELECT r.*, v.vehicle_id, v.plate_number, d.full_name AS driver_name
         FROM dim_route r
         LEFT JOIN dim_vehicle v ON r.assigned_vehicle_key = v.vehicle_key
         LEFT JOIN dim_user d ON v.assigned_driver_key = d.user_key
        WHERE r.business_key = @businessKey`,
      { businessKey: req.user.businessKey }
    );
    res.json({ success: true, count: result.recordset.length, data: result.recordset });
  } catch (err) {
    return fail(res, err, 'Failed to fetch routes', '[FLEET] routes error:');
  }
});

module.exports = router;
