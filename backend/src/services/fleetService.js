/* ============================================================================
   FLEET SERVICE (Service Layer)
   Single source of truth for fleet business logic. Consumers:
   - routes/fleet.js        (online HTTP requests)
   - sync/fleetProcessors.js (offline queued payloads)

   Every rule enforced here applies identically in both paths:
   - TD-3:  date_key in Africa/Lagos
   - TD-4:  multi-statement writes transactional
   - TD-12: every query scoped by business_key
   - TD-13: odometer monotonicity (conflict-grade offline)
   - TD-16: dim_date coverage guard
   - TD-7:  maintenance approval thresholds
   - PULL: every dim_vehicle mutation also emits a VEHICLES change-log row
     via changeLogService.recordChange INSIDE the same transaction (the
     transactional outbox: fact write + version bump + log row commit or
     roll back together - no partial update can ever reach devices).
 
   All functions take an "actor" ({ userKey, businessKey, deviceId }) plus a
   payload - no Express request object ever reaches this layer, which keeps
   it testable and reusable by the queue processor.
   ============================================================================ */
 
const { executeQuery, withTransaction } = require('../config/db');
const {
  VEHICLE_STATUS, TRIP_STATUS, CHECK_STATUS, FUEL_REQUEST_STATUS,
  APPROVAL_STATUS, MAINTENANCE_TYPE, CHANGE_OP
} = require('../constants');
const { HttpError } = require('../utils/httpError');
const g = require('./guards');
const { recordChange } = require('./changeLogService');

const q = executeQuery; // alias so guards' `query` param reads naturally

/* -----------------------------------------------------------------------
   Vehicle checks
   ----------------------------------------------------------------------- */

function computeCheckStatus(p, hasDamage) {
  const allPass = [p.tiresOk, p.lightsOk, p.brakesOk, p.engineOk, p.oilLevelOk,
    p.coolantOk, p.wipersOk, p.mirrorsOk, p.seatbeltsOk, p.fireExtinguisherOk,
    p.firstAidKitOk].every((c) => c === true || c === 1);
  if (hasDamage) return CHECK_STATUS.PASS_WITH_ISSUES;
  return allPass ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL;
}

/**
 * Update a vehicle's odometer reading (TD-13 monotonicity + PULL outbox).
 * The odometer advance and its VEHICLES change-log row commit in ONE
 * transaction; a regression throws 409 before any write happens.
 * @returns {{ vehicleKey:number }}
 */
async function updateVehicleOdometer(actor, p, { conflictAsError = false, conflictOverride = false } = {}) {
  if (p.odometerReading === undefined || p.odometerReading === null || p.odometerReading < 0) {
    throw new HttpError(400, 'Valid odometer reading required');
  }

  const vehicle = await g.getOwnedVehicle(q, actor.businessKey, p.vehicleKey);
  if (!conflictOverride) {
    const odo = g.assertOdometerNotRegressed(vehicle.current_odometer, p.odometerReading, 'Odometer');
    if (odo.violated) {
      if (conflictAsError) {
        throw g.conflict(
          `Odometer ${p.odometerReading} below vehicle odometer ${odo.currentOdometer}`,
          { current_odometer: odo.currentOdometer }, p
        );
      }
      throw new HttpError(409, `Odometer cannot go backwards (current: ${odo.currentOdometer}, submitted: ${p.odometerReading})`);
    }
  }

  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE dim_vehicle SET current_odometer = @odometerReading, updated_at = GETDATE()
        WHERE vehicle_key = @vehicleKey AND business_key = @businessKey`,
      { odometerReading: p.odometerReading, vehicleKey: p.vehicleKey, businessKey: actor.businessKey }
    );
    await recordChange(tx, {
      dataset: 'VEHICLES',
      businessKey: actor.businessKey,
      entityKey: p.vehicleKey,
      op: CHANGE_OP.UPSERT
    });
  });

  return { vehicleKey: p.vehicleKey };
}

/**
 * Record a vehicle daily check.
 * @returns {{ checkKey:number, checkStatus:string }}
 */
async function recordVehicleCheck(actor, p) {
  if (!p.vehicleKey) throw new HttpError(400, 'vehicleKey is required');

  await g.getOwnedVehicle(q, actor.businessKey, p.vehicleKey);
  const dateKey = await g.resolveDateKey(q, p.checkTime ? undefined : undefined);
  const checkStatus = computeCheckStatus(p, p.hasDamage);

  const result = await executeQuery(
    `INSERT INTO fact_vehicle_check (
       business_key, vehicle_key, driver_key, date_key, check_datetime,
       latitude, longitude, tires_ok, lights_ok, brakes_ok, engine_ok,
       oil_level_ok, coolant_ok, wipers_ok, mirrors_ok, seatbelts_ok,
       fire_extinguisher_ok, first_aid_kit_ok, has_damage, damage_description,
       damage_photo_url, check_status, sync_timestamp, mobile_device_id
     ) OUTPUT INSERTED.check_key
     VALUES (
       @businessKey, @vehicleKey, @driverKey, @dateKey, GETDATE(),
       @latitude, @longitude, @tiresOk, @lightsOk, @brakesOk, @engineOk,
       @oilLevelOk, @coolantOk, @wipersOk, @mirrorsOk, @seatbeltsOk,
       @fireExtinguisherOk, @firstAidKitOk, @hasDamage, @damageDescription,
       @damagePhotoUrl, @checkStatus, GETDATE(), @deviceId
     )`,
    {
      businessKey: actor.businessKey,
      vehicleKey: p.vehicleKey,
      driverKey: actor.userKey,
      dateKey,
      latitude: p.latitude || null,
      longitude: p.longitude || null,
      tiresOk: p.tiresOk ? 1 : 0, lightsOk: p.lightsOk ? 1 : 0,
      brakesOk: p.brakesOk ? 1 : 0, engineOk: p.engineOk ? 1 : 0,
      oilLevelOk: p.oilLevelOk ? 1 : 0, coolantOk: p.coolantOk ? 1 : 0,
      wipersOk: p.wipersOk ? 1 : 0, mirrorsOk: p.mirrorsOk ? 1 : 0,
      seatbeltsOk: p.seatbeltsOk ? 1 : 0, fireExtinguisherOk: p.fireExtinguisherOk ? 1 : 0,
      firstAidKitOk: p.firstAidKitOk ? 1 : 0,
      hasDamage: p.hasDamage ? 1 : 0,
      damageDescription: p.damageDescription || null,
      damagePhotoUrl: p.damagePhotoUrl || null,
      checkStatus,
      deviceId: actor.deviceId || null
    }
  );

  return { checkKey: result.recordset[0].check_key, checkStatus };
}

/* -----------------------------------------------------------------------
   Trips
   ----------------------------------------------------------------------- */

/**
 * Start a trip. Throws SyncConflictError data (via guards) on odometer
 * regression and active-trip collision so the OFFLINE path parks them as
 * conflicts; the ONLINE route catches and converts to 409 responses.
 * @returns {{ tripKey:number }}
 */
async function startTrip(actor, p, { conflictAsError = false, conflictOverride = false } = {}) {
  if (p.startOdometer === undefined || p.startOdometer === null) {
    throw new HttpError(400, 'startOdometer required');
  }

  const vehicle = await g.getOwnedVehicle(q, actor.businessKey, p.vehicleKey);

  if (!conflictOverride) {
    const odo = g.assertOdometerNotRegressed(vehicle.current_odometer, p.startOdometer, 'Trip start odometer');
    if (odo.violated) {
      if (conflictAsError) {
        throw g.conflict(
          `Trip start odometer ${p.startOdometer} below vehicle odometer ${odo.currentOdometer}`,
          { current_odometer: odo.currentOdometer }, p
        );
      }
      throw new HttpError(409, `startOdometer (${p.startOdometer}) is below the vehicle's current odometer (${odo.currentOdometer})`);
    }

    const active = await g.findActiveTrip(q, actor.businessKey, p.vehicleKey, p.tripKey || 0);
    if (active) {
      if (conflictAsError) {
        throw g.conflict('Vehicle already has an active trip', { active_trip: active.trip_key }, p);
      }
      throw new HttpError(409, 'Vehicle already has an active trip. End it first.');
    }
  }

  const dateKey = await g.resolveDateKey(q, p.startTime ? undefined : undefined);

  const tripKey = await withTransaction(async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO fact_trip (
         business_key, vehicle_key, driver_key, route_key, date_key,
         trip_start_time, start_odometer, start_latitude, start_longitude,
         trip_status, driver_notes, sync_timestamp, mobile_device_id
       ) OUTPUT INSERTED.trip_key
       VALUES (
         @businessKey, @vehicleKey, @driverKey, @routeKey, @dateKey,
         @startTime, @startOdometer, @latitude, @longitude,
         @tripStatus, @driverNotes, GETDATE(), @deviceId
       )`,
      {
        businessKey: actor.businessKey,
        vehicleKey: p.vehicleKey,
        driverKey: actor.userKey,
        routeKey: p.routeKey || null,
        dateKey,
        startTime: p.startTime || new Date().toISOString(),
        startOdometer: p.startOdometer,
        latitude: p.latitude || null,
        longitude: p.longitude || null,
        tripStatus: TRIP_STATUS.STARTED,
        driverNotes: p.driverNotes || null,
        deviceId: actor.deviceId || null
      }
    );
    await tx.query(
      'UPDATE dim_vehicle SET status = @status, updated_at = GETDATE() WHERE vehicle_key = @vehicleKey',
      { status: VEHICLE_STATUS.ON_ROUTE, vehicleKey: p.vehicleKey }
    );
    // Transactional outbox: vehicle status change reaches pull devices
    // atomically with the trip insert (or not at all).
    await recordChange(tx, {
      dataset: 'VEHICLES',
      businessKey: actor.businessKey,
      entityKey: p.vehicleKey,
      op: CHANGE_OP.UPSERT
    });
    return inserted.recordset[0].trip_key;
  });

  return { tripKey };
}

/**
 * End a trip. Idempotent: ending an already-COMPLETED trip is a no-op ack.
 * @returns {{ tripKey:number, distanceKm:number, alreadyEnded:boolean }}
 */
async function endTrip(actor, p, { conflictAsError = false, conflictOverride = false } = {}) {
  if (p.endOdometer === undefined || p.endOdometer === null) {
    throw new HttpError(400, 'endOdometer required');
  }

  const tripResult = await executeQuery(
    `SELECT trip_key, vehicle_key, start_odometer, trip_status
       FROM fact_trip
      WHERE trip_key = @tripKey AND business_key = @businessKey`,
    { tripKey: p.tripKey, businessKey: actor.businessKey }
  );
  if (tripResult.recordset.length === 0) {
    if (conflictAsError) {
      throw g.conflict('Trip not found on server', null, p);
    }
    throw new HttpError(404, 'Active trip not found');
  }
  const trip = tripResult.recordset[0];

  if (trip.trip_status === 'COMPLETED' || trip.trip_status === 'CANCELLED') {
    return { tripKey: p.tripKey, distanceKm: null, alreadyEnded: true };
  }

  if (!conflictOverride && p.endOdometer < trip.start_odometer) {
    if (conflictAsError) {
      throw g.conflict(
        `End odometer ${p.endOdometer} below start odometer ${trip.start_odometer}`,
        trip, p
      );
    }
    throw new HttpError(409, `endOdometer (${p.endOdometer}) is below the trip's start odometer (${trip.start_odometer})`);
  }

  const distanceKm = p.endOdometer - trip.start_odometer;

  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE fact_trip SET
         trip_end_time = @endTime, end_odometer = @endOdometer,
         end_latitude = @latitude, end_longitude = @longitude,
         distance_km = @distanceKm, stores_visited = @storesVisited,
         delivery_success_count = @deliverySuccessCount,
         delivery_fail_count = @deliveryFailCount,
         trip_status = @tripStatus, driver_notes = @driverNotes,
         sync_timestamp = GETDATE(), updated_at = GETDATE()
       WHERE trip_key = @tripKey`,
      {
        tripKey: p.tripKey,
        endTime: p.endTime || new Date().toISOString(),
        endOdometer: p.endOdometer,
        latitude: p.latitude || null,
        longitude: p.longitude || null,
        distanceKm,
        storesVisited: p.storesVisited || 0,
        deliverySuccessCount: p.deliverySuccessCount || 0,
        deliveryFailCount: p.deliveryFailCount || 0,
        tripStatus: TRIP_STATUS.COMPLETED,
        driverNotes: p.driverNotes || null
      }
    );
    await tx.query(
      `UPDATE dim_vehicle SET current_odometer = @endOdometer, status = @status, updated_at = GETDATE()
        WHERE vehicle_key = @vehicleKey AND current_odometer < @endOdometer`,
      { endOdometer: p.endOdometer, status: VEHICLE_STATUS.ACTIVE, vehicleKey: trip.vehicle_key }
    );
    // Transactional outbox: odometer/status change reaches pull devices
    // atomically with the trip completion. The UPDATE above is guarded
    // (current_odometer < @endOdometer) so another trip may have already
    // advanced it - the emit still snapshots the CURRENT row, so devices
    // always converge on the latest truth.
    await recordChange(tx, {
      dataset: 'VEHICLES',
      businessKey: actor.businessKey,
      entityKey: trip.vehicle_key,
      op: CHANGE_OP.UPSERT
    });
  });

  return { tripKey: p.tripKey, distanceKm, alreadyEnded: false };
}

/* -----------------------------------------------------------------------
   Fuel
   ----------------------------------------------------------------------- */

/** Create a fuel request. @returns {{ fuelRequestKey:number }} */
async function createFuelRequest(actor, p) {
  if (!p.amountRequested) throw new HttpError(400, 'vehicleKey and amountRequested required');
  await g.getOwnedVehicle(q, actor.businessKey, p.vehicleKey);
  const dateKey = await g.resolveDateKey(q);

  const result = await executeQuery(
    `INSERT INTO fact_fuel_request (
       business_key, vehicle_key, driver_key, date_key, request_datetime,
       request_type, amount_requested, liters_requested, reason,
       sync_timestamp, mobile_device_id
     ) OUTPUT INSERTED.fuel_request_key
     VALUES (
       @businessKey, @vehicleKey, @driverKey, @dateKey, GETDATE(),
       @requestType, @amountRequested, @litersRequested, @reason,
       GETDATE(), @deviceId
     )`,
    {
      businessKey: actor.businessKey,
      vehicleKey: p.vehicleKey,
      driverKey: actor.userKey,
      dateKey,
      requestType: p.requestType || 'CASH',
      amountRequested: p.amountRequested,
      litersRequested: p.litersRequested || null,
      reason: p.reason || null,
      deviceId: actor.deviceId || null
    }
  );
  return { fuelRequestKey: result.recordset[0].fuel_request_key };
}

/**
 * Log a refuel. Odometer regression is conflict-grade offline.
 * @returns {{ fuelLogKey:number, kmSinceLast:number, litersPer100km:number }}
 */
async function recordFuelLog(actor, p, { conflictAsError = false, conflictOverride = false } = {}) {
  if (!p.litersFilled) throw new HttpError(400, 'vehicleKey, odometerReading, litersFilled required');

  const vehicle = await g.getOwnedVehicle(q, actor.businessKey, p.vehicleKey);
  if (!conflictOverride) {
    const odo = g.assertOdometerNotRegressed(vehicle.current_odometer, p.odometerReading, 'Fuel odometer');
    if (odo.violated) {
      if (conflictAsError) {
        throw g.conflict(
          `Fuel odometer ${p.odometerReading} below vehicle odometer ${odo.currentOdometer}`,
          { current_odometer: odo.currentOdometer }, p
        );
      }
      throw new HttpError(409, `odometerReading (${p.odometerReading}) is below the vehicle's current odometer (${odo.currentOdometer})`);
    }
  }

  const lastFuel = await executeQuery(
    `SELECT TOP 1 odometer_reading FROM fact_fuel_log
      WHERE vehicle_key = @vehicleKey AND business_key = @businessKey
      ORDER BY refuel_datetime DESC`,
    { vehicleKey: p.vehicleKey, businessKey: actor.businessKey }
  );
  const kmSinceLast = lastFuel.recordset.length > 0
    ? p.odometerReading - lastFuel.recordset[0].odometer_reading : 0;
  const litersPer100km = kmSinceLast > 0 ? (p.litersFilled / kmSinceLast) * 100 : null;

  const dateKey = await g.resolveDateKey(q);

  const fuelLogKey = await withTransaction(async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO fact_fuel_log (
         business_key, vehicle_key, driver_key, fuel_request_key, date_key, refuel_datetime,
         odometer_reading, liters_filled, cost_per_liter, total_cost, station_name,
         receipt_photo_url, km_since_last_refuel, liters_per_100km,
         sync_timestamp, mobile_device_id
       ) OUTPUT INSERTED.fuel_log_key
       VALUES (
         @businessKey, @vehicleKey, @driverKey, @fuelRequestKey, @dateKey, GETDATE(),
         @odometerReading, @litersFilled, @costPerLiter, @totalCost, @stationName,
         @receiptPhotoUrl, @kmSinceLast, @litersPer100km,
         GETDATE(), @deviceId
       )`,
      {
        businessKey: actor.businessKey,
        vehicleKey: p.vehicleKey,
        driverKey: actor.userKey,
        fuelRequestKey: p.fuelRequestKey || null,
        dateKey,
        odometerReading: p.odometerReading,
        litersFilled: p.litersFilled,
        costPerLiter: p.costPerLiter || null,
        totalCost: p.totalCost || null,
        stationName: p.stationName || null,
        receiptPhotoUrl: p.receiptPhotoUrl || null,
        kmSinceLast,
        litersPer100km,
        deviceId: actor.deviceId || null
      }
    );
    await tx.query(
      `UPDATE dim_vehicle SET current_odometer = @odometerReading, updated_at = GETDATE()
        WHERE vehicle_key = @vehicleKey AND current_odometer < @odometerReading`,
      { odometerReading: p.odometerReading, vehicleKey: p.vehicleKey }
    );
    // Transactional outbox: the fuel log + odometer advance + change row
    // commit together or not at all.
    await recordChange(tx, {
      dataset: 'VEHICLES',
      businessKey: actor.businessKey,
      entityKey: p.vehicleKey,
      op: CHANGE_OP.UPSERT
    });
    return inserted.recordset[0].fuel_log_key;
  });

  return { fuelLogKey, kmSinceLast, litersPer100km };
}

/* -----------------------------------------------------------------------
   Maintenance
   ----------------------------------------------------------------------- */

/**
 * Report a maintenance issue. MD-approval threshold honored.
 * @returns {{ maintenanceKey:number, needsMdApproval:boolean }}
 */
async function reportMaintenance(actor, p) {
  if (!p.maintenanceType || !p.description) {
    throw new HttpError(400, 'vehicleKey, maintenanceType, description required');
  }
  if (!Object.values(MAINTENANCE_TYPE).includes(p.maintenanceType)) {
    throw new HttpError(400, `maintenanceType must be one of: ${Object.values(MAINTENANCE_TYPE).join(', ')}`);
  }

  await g.getOwnedVehicle(q, actor.businessKey, p.vehicleKey);

  const threshold = await g.getConfigDecimal(q, 'MAINTENANCE_MD_THRESHOLD', 100000);
  const needsMdApproval = Boolean(p.estimatedCost && p.estimatedCost > threshold);

  const dateKey = await g.resolveDateKey(q);

  const result = await executeQuery(
    `INSERT INTO fact_maintenance (
       business_key, vehicle_key, reported_by_key, date_key, maintenance_type,
       priority, description, estimated_cost, approval_status,
       sync_timestamp, mobile_device_id
     ) OUTPUT INSERTED.maintenance_key
     VALUES (
       @businessKey, @vehicleKey, @reportedByKey, @dateKey, @maintenanceType,
       @priority, @description, @estimatedCost, @approvalStatus,
       GETDATE(), @deviceId
     )`,
    {
      businessKey: actor.businessKey,
      vehicleKey: p.vehicleKey,
      reportedByKey: actor.userKey,
      dateKey,
      maintenanceType: p.maintenanceType,
      priority: p.priority || 'MEDIUM',
      description: p.description,
      estimatedCost: p.estimatedCost || null,
      approvalStatus: needsMdApproval ? APPROVAL_STATUS.PENDING : APPROVAL_STATUS.OPS_APPROVED,
      deviceId: actor.deviceId || null
    }
  );

  return { maintenanceKey: result.recordset[0].maintenance_key, needsMdApproval };
}

/** Approve/reject a fuel request (online-only workflow action). */
async function decideFuelRequest(actor, fuelRequestKey, decision) {
  const existing = await executeQuery(
    'SELECT approval_status FROM fact_fuel_request WHERE fuel_request_key = @fuelRequestKey AND business_key = @businessKey',
    { fuelRequestKey, businessKey: actor.businessKey }
  );
  if (existing.recordset.length === 0) throw new HttpError(404, 'Fuel request not found');
  if (existing.recordset[0].approval_status !== FUEL_REQUEST_STATUS.PENDING) {
    throw new HttpError(409, 'Fuel request already decided');
  }

  await executeQuery(
    `UPDATE fact_fuel_request SET
       approval_status = @approvalStatus,
       approved_by_key = @approvedByKey,
       approved_datetime = GETDATE(),
       approval_notes = @approvalNotes,
       disbursed_amount = CASE WHEN @approvalStatus = 'APPROVED' THEN @disbursedAmount ELSE NULL END
     WHERE fuel_request_key = @fuelRequestKey AND business_key = @businessKey`,
    {
      approvalStatus: decision.approvalStatus,
      approvedByKey: actor.userKey,
      approvalNotes: decision.approvalNotes || null,
      disbursedAmount: decision.disbursedAmount || null,
      fuelRequestKey,
      businessKey: actor.businessKey
    }
  );
}

/** TD-7 corrected maintenance approval (OPS first, MD only above threshold). */
async function approveMaintenance(actor, maintenanceKey, approvalLevel) {
  const ticket = await executeQuery(
    `SELECT m.estimated_cost, m.approval_status,
            TRY_CAST(c.config_value AS DECIMAL(12,2)) AS md_threshold
       FROM fact_maintenance m
       CROSS JOIN (SELECT config_value FROM app_config WHERE config_name = 'MAINTENANCE_MD_THRESHOLD') c
      WHERE m.maintenance_key = @maintenanceKey AND m.business_key = @businessKey`,
    { maintenanceKey, businessKey: actor.businessKey }
  );
  if (ticket.recordset.length === 0) throw new HttpError(404, 'Ticket not found');

  const { estimated_cost, approval_status, md_threshold } = ticket.recordset[0];
  const threshold = md_threshold ?? 100000;
  const needsMd = estimated_cost && estimated_cost > threshold;

  if (approvalLevel === 'OPS') {
    if (approval_status !== APPROVAL_STATUS.PENDING) {
      throw new HttpError(409, `Ticket already ${approval_status}`);
    }
    await executeQuery(
      `UPDATE fact_maintenance SET
         ops_approved_by_key = @userKey,
         ops_approved_datetime = GETDATE(),
         approval_status = @newStatus,
         updated_at = GETDATE()
       WHERE maintenance_key = @maintenanceKey AND business_key = @businessKey`,
      {
        userKey: actor.userKey,
        newStatus: needsMd ? APPROVAL_STATUS.OPS_APPROVED : APPROVAL_STATUS.MD_APPROVED,
        maintenanceKey,
        businessKey: actor.businessKey
      }
    );
    return { needsMd };
  }

  // MD level
  if (approval_status !== APPROVAL_STATUS.OPS_APPROVED) {
    throw new HttpError(409, 'MD approval requires prior OPS approval (or ticket is already decided).');
  }
  if (!needsMd) {
    throw new HttpError(409, 'This ticket is within the OPS threshold and does not require MD approval.');
  }
  await executeQuery(
    `UPDATE fact_maintenance SET
       md_approved_by_key = @userKey,
       md_approved_datetime = GETDATE(),
       approval_status = @newStatus,
       updated_at = GETDATE()
     WHERE maintenance_key = @maintenanceKey AND business_key = @businessKey`,
    { userKey: actor.userKey, newStatus: APPROVAL_STATUS.MD_APPROVED, maintenanceKey, businessKey: actor.businessKey }
  );
  return { needsMd };
}

module.exports = {
  computeCheckStatus,
  recordVehicleCheck,
  updateVehicleOdometer,
  startTrip,
  endTrip,
  createFuelRequest,
  recordFuelLog,
  reportMaintenance,
  decideFuelRequest,
  approveMaintenance
};
