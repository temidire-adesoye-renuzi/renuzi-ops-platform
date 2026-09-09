/* ============================================================================
   DASHBOARD API ROUTES   All endpoints prefixed with /api/dashboard
   Read-only aggregations for the ops web dashboard (Power BI views reused
   where possible). Every query is business-scoped (TD-12).

   GET /api/dashboard/fleet-daily      - Trips & checks summary for a date
   GET /api/dashboard/fuel-efficiency   - Fuel metrics per vehicle
   GET /api/dashboard/maintenance-queue - Open/pending maintenance tickets
   GET /api/dashboard/stock-position    - Current stock by SKU
   GET /api/dashboard/dispatch-performance - Delivery KPIs
   GET /api/dashboard/variances         - Stock count variances
   ============================================================================ */

const express = require('express');
const router = express.Router();
const { executeQuery } = require('../config/db');
const { authenticateToken } = require('../middleware/auth');
const { requireAny } = require('../middleware/roleCheck');
const { getDateKey, parseDateKeyParam } = require('../utils/date');

function fail(res, err, fallback, internal) {
  console.error(internal || fallback, err.message);
  return res.status(500).json({ success: false, message: fallback });
}

// GET /api/dashboard/fleet-daily
// Query: ?dateKey=YYYYMMDD (defaults to today, Lagos time)
router.get('/fleet-daily', authenticateToken, requireAny, async (req, res) => {
  try {
    let dateKey;
    if (req.query.dateKey) {
      const parsed = parseDateKeyParam(req.query.dateKey);
      if (!parsed) {
        return res.status(400).json({ success: false, message: 'dateKey must be YYYYMMDD or YYYY-MM-DD' });
      }
      dateKey = parseInt(parsed.replace(/-/g, ''), 10);
    } else {
      dateKey = getDateKey();
    }

    const trips = await executeQuery(
      `SELECT
         COUNT(*) AS total_trips,
         SUM(CASE WHEN trip_status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_trips,
         SUM(CASE WHEN trip_status IN ('STARTED','IN_PROGRESS') THEN 1 ELSE 0 END) AS active_trips,
         SUM(CASE WHEN trip_status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled_trips,
         SUM(CASE WHEN trip_status = 'COMPLETED' THEN ISNULL(distance_km, 0) ELSE 0 END) AS total_distance_km,
         SUM(ISNULL(stores_visited, 0)) AS stores_visited,
         SUM(ISNULL(delivery_success_count, 0)) AS deliveries_ok,
         SUM(ISNULL(delivery_fail_count, 0)) AS deliveries_failed
       FROM fact_trip
       WHERE business_key = @businessKey AND date_key = @dateKey`,
      { businessKey: req.user.businessKey, dateKey }
    );

    const checks = await executeQuery(
      `SELECT
         COUNT(*) AS total_checks,
         SUM(CASE WHEN check_status = 'PASS' THEN 1 ELSE 0 END) AS passed,
         SUM(CASE WHEN check_status = 'FAIL' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN check_status = 'PASS_WITH_ISSUES' THEN 1 ELSE 0 END) AS pass_with_issues,
         SUM(CASE WHEN has_damage = 1 THEN 1 ELSE 0 END) AS damage_reports
       FROM fact_vehicle_check
       WHERE business_key = @businessKey AND date_key = @dateKey`,
      { businessKey: req.user.businessKey, dateKey }
    );

    return res.json({
      success: true,
      data: { dateKey, trips: trips.recordset[0], checks: checks.recordset[0] }
    });
  } catch (err) {
    return fail(res, err, 'Failed to build fleet summary', '[DASH] fleet-daily error:');
  }
});

// GET /api/dashboard/fuel-efficiency
// Query: ?dateFrom&dateTo (datetimes) or ?dateKeyFrom&dateKeyTo (YYYYMMDD)
router.get('/fuel-efficiency', authenticateToken, requireAny, async (req, res) => {
  try {
    const { dateFrom, dateTo, dateKeyFrom, dateKeyTo } = req.query;

    let query = `
      SELECT
        v.vehicle_id, v.plate_number,
        COUNT(fl.fuel_log_key) AS refuel_events,
        SUM(fl.liters_filled) AS total_liters,
        SUM(ISNULL(fl.total_cost, 0)) AS total_cost,
        SUM(ISNULL(fl.km_since_last_refuel, 0)) AS total_km,
        AVG(CASE WHEN fl.liters_per_100km > 0 THEN fl.liters_per_100km END) AS avg_liters_per_100km
      FROM fact_fuel_log fl
      JOIN dim_vehicle v ON fl.vehicle_key = v.vehicle_key
      WHERE fl.business_key = @businessKey
    `;
    const params = { businessKey: req.user.businessKey };

    if (dateKeyFrom) {
      const d = parseDateKeyParam(dateKeyFrom);
      if (!d) return res.status(400).json({ success: false, message: 'dateKeyFrom must be YYYYMMDD' });
      query += ' AND fl.date_key >= @dateKeyFrom';
      params.dateKeyFrom = parseInt(d.replace(/-/g, ''), 10);
    }
    if (dateKeyTo) {
      const d = parseDateKeyParam(dateKeyTo);
      if (!d) return res.status(400).json({ success: false, message: 'dateKeyTo must be YYYYMMDD' });
      query += ' AND fl.date_key <= @dateKeyTo';
      params.dateKeyTo = parseInt(d.replace(/-/g, ''), 10);
    }
    if (dateFrom) { query += ' AND fl.refuel_datetime >= @dateFrom'; params.dateFrom = dateFrom; }
    if (dateTo) { query += ' AND fl.refuel_datetime <= @dateTo'; params.dateTo = dateTo; }

    query += ' GROUP BY v.vehicle_id, v.plate_number ORDER BY v.vehicle_id';

    const result = await executeQuery(query, params);
    return res.json({ success: true, count: result.recordset.length, data: result.recordset });
  } catch (err) {
    return fail(res, err, 'Failed to build fuel report', '[DASH] fuel-efficiency error:');
  }
});

// GET /api/dashboard/maintenance-queue
router.get('/maintenance-queue', authenticateToken, requireAny, async (req, res) => {
  try {
    const summary = await executeQuery(
      `SELECT
         SUM(CASE WHEN maintenance_status = 'OPEN' THEN 1 ELSE 0 END) AS open_tickets,
         SUM(CASE WHEN maintenance_status = 'IN_PROGRESS' THEN 1 ELSE 0 END) AS in_progress,
         SUM(CASE WHEN maintenance_status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN approval_status = 'PENDING' THEN 1 ELSE 0 END) AS awaiting_ops_approval,
         SUM(CASE WHEN approval_status = 'OPS_APPROVED' THEN 1 ELSE 0 END) AS awaiting_md_approval,
         SUM(ISNULL(estimated_cost, 0)) AS total_estimated_cost,
         SUM(ISNULL(actual_cost, 0)) AS total_actual_cost
       FROM fact_maintenance
       WHERE business_key = @businessKey`,
      { businessKey: req.user.businessKey }
    );

    const openTickets = await executeQuery(
      `SELECT m.maintenance_key, m.maintenance_type, m.priority, m.description,
              m.estimated_cost, m.approval_status, m.maintenance_status, m.created_at,
              v.vehicle_id, v.plate_number, r.full_name AS reported_by_name
         FROM fact_maintenance m
         JOIN dim_vehicle v ON m.vehicle_key = v.vehicle_key
         JOIN dim_user r ON m.reported_by_key = r.user_key
        WHERE m.business_key = @businessKey
          AND m.maintenance_status IN ('OPEN','IN_PROGRESS')
        ORDER BY CASE m.priority WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 3 ELSE 4 END,
                 m.created_at`,
      { businessKey: req.user.businessKey }
    );

    return res.json({
      success: true,
      data: { summary: summary.recordset[0], queue: openTickets.recordset }
    });
  } catch (err) {
    return fail(res, err, 'Failed to build maintenance queue', '[DASH] maintenance-queue error:');
  }
});

// GET /api/dashboard/stock-position
// Query: ?lowStockOnly=true (current_stock <= 10)
router.get('/stock-position', authenticateToken, requireAny, async (req, res) => {
  try {
    const { lowStockOnly } = req.query;

    let query = `
      SELECT business_key, business_name, product_key, sku_code, product_name,
             brand, category, warehouse_location,
             total_in, total_out, current_stock, last_movement_date
        FROM vw_stock_position
       WHERE business_key = @businessKey
    `;
    const params = { businessKey: req.user.businessKey };
    if (lowStockOnly === 'true' || lowStockOnly === '1') {
      query += ' AND current_stock <= 10';
    }
    query += ' ORDER BY product_name, warehouse_location';

    const result = await executeQuery(query, params);
    return res.json({ success: true, count: result.recordset.length, data: result.recordset });
  } catch (err) {
    return fail(res, err, 'Failed to build stock position', '[DASH] stock-position error:');
  }
});

// GET /api/dashboard/dispatch-performance
// Query: ?dateKey=YYYYMMDD or ?dateFrom&dateTo
router.get('/dispatch-performance', authenticateToken, requireAny, async (req, res) => {
  try {
    const { dateKey, dateFrom, dateTo } = req.query;

    let where = ' WHERE d.business_key = @businessKey';
    const params = { businessKey: req.user.businessKey };

    if (dateKey) {
      const d = parseDateKeyParam(dateKey);
      if (!d) return res.status(400).json({ success: false, message: 'dateKey must be YYYYMMDD or YYYY-MM-DD' });
      where += ' AND d.date_key = @dateKey';
      params.dateKey = parseInt(d.replace(/-/g, ''), 10);
    }
    if (dateFrom) { where += ' AND d.created_at >= @dateFrom'; params.dateFrom = dateFrom; }
    if (dateTo) { where += ' AND d.created_at <= @dateTo'; params.dateTo = dateTo; }

    const summary = await executeQuery(
      `SELECT
         COUNT(*) AS total_dispatches,
         SUM(CASE WHEN dispatch_status = 'DELIVERED' THEN 1 ELSE 0 END) AS delivered,
         SUM(CASE WHEN dispatch_status = 'IN_TRANSIT' THEN 1 ELSE 0 END) AS in_transit,
         SUM(CASE WHEN dispatch_status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN dispatch_status = 'RETURNED' THEN 1 ELSE 0 END) AS returned,
         AVG(CASE WHEN delivery_datetime IS NOT NULL
                  THEN DATEDIFF(HOUR, d.created_at, d.delivery_datetime) END) AS avg_hours_to_deliver
       FROM fact_dispatch d
       ${where}`,
      params
    );

    const byStatus = await executeQuery(
      `SELECT dispatch_status, COUNT(*) AS count
         FROM fact_dispatch d
        ${where}
        GROUP BY dispatch_status`,
      params
    );

    return res.json({
      success: true,
      data: { summary: summary.recordset[0], byStatus: byStatus.recordset }
    });
  } catch (err) {
    return fail(res, err, 'Failed to build dispatch report', '[DASH] dispatch-performance error:');
  }
});

// GET /api/dashboard/variances - Stock count variances
router.get('/variances', authenticateToken, requireAny, async (req, res) => {
  try {
    const summary = await executeQuery(
      `SELECT
         COUNT(*) AS total_counts,
         SUM(CASE WHEN variance != 0 THEN 1 ELSE 0 END) AS counts_with_variance,
         SUM(CASE WHEN variance > 0 THEN 1 ELSE 0 END) AS surpluses,
         SUM(CASE WHEN variance < 0 THEN 1 ELSE 0 END) AS shortfalls,
         SUM(CASE WHEN variance < 0 THEN -variance ELSE 0 END) AS total_units_short,
         SUM(CASE WHEN variance > 0 THEN variance ELSE 0 END) AS total_units_over
       FROM fact_stock_count
       WHERE business_key = @businessKey`,
      { businessKey: req.user.businessKey }
    );

    const openInvestigations = await executeQuery(
      `SELECT sc.count_key, sc.system_qty, sc.physical_count, sc.variance,
              sc.variance_reason, sc.investigation_status, sc.manager_decision, sc.created_at,
              p.sku_code, p.product_name, c.full_name AS counted_by_name
         FROM fact_stock_count sc
         JOIN dim_product p ON sc.product_key = p.product_key
         JOIN dim_user c ON sc.counted_by_key = c.user_key
        WHERE sc.business_key = @businessKey AND sc.investigation_status != 'RESOLVED'
        ORDER BY sc.created_at DESC`,
      { businessKey: req.user.businessKey }
    );

    return res.json({
      success: true,
      data: { summary: summary.recordset[0], open: openInvestigations.recordset }
    });
  } catch (err) {
    return fail(res, err, 'Failed to build variance report', '[DASH] variances error:');
  }
});

module.exports = router;
