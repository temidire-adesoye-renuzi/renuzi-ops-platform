/* ============================================================================
   INTEGRATION: Conflict generation (Objective 4b)
   Verifies the two required conflict scenarios park as CONFLICT rows with
   both versions logged:
   - odometer regressions (TRIP_START below vehicle odometer, FUEL_LOG)
   - active-trip collisions (second TRIP_START while one is open)
   - custody-chain prereq violations (DISPATCH_ACK out of order)
   ============================================================================ */

const db = require('../helpers/dbTestHelper');
const { authed, login, clearRotationFlags } = require('../helpers/apiClient');
const { executeQuery } = require('../../src/config/db');

beforeAll(async () => {
  await db.migrate();
  await clearRotationFlags();
});

beforeEach(async () => {
  await db.cleanOperationalData();
});

afterAll(async () => {
  await db.close();
});

async function push(token, deviceId, items) {
  const { request, app } = require('../helpers/apiClient');
  return authed(token).post('/api/sync/batch').send({ deviceId, items });
}

describe('conflict generation: odometer regression', () => {
  test('TRIP_START below vehicle odometer parks as CONFLICT, not FAILED', async () => {
    const { token } = await login('driver');

    const res = await push(token, 'device-C', [{
      clientRef: 'conflict-odo-001',
      entityType: 'TRIP_START',
      payload: { vehicleKey: 1, startOdometer: 100, startTime: new Date().toISOString() } // vehicle odometer is 45230.50
    }]);

    expect(res.status).toBe(200);
    expect(res.body.data.processing.conflicts).toBe(1);
    expect(res.body.data.processing.failed).toBe(0);

    const queue = await executeQuery(
      "SELECT sync_status, error_message FROM sync_queue WHERE client_ref = 'conflict-odo-001'"
    );
    expect(queue.recordset[0].sync_status).toBe('CONFLICT');
    expect(queue.recordset[0].error_message).toMatch(/odometer/i);

    const conflict = await executeQuery(
      `SELECT c.server_version_json, c.client_version_json, c.resolution
         FROM sync_conflict_log c JOIN sync_queue q ON c.queue_id = q.queue_id
        WHERE q.client_ref = 'conflict-odo-001'`
    );
    expect(conflict.recordset.length).toBe(1);
    expect(conflict.recordset[0].resolution).toBe('PENDING');

    const server = JSON.parse(conflict.recordset[0].server_version_json);
    expect(server.current_odometer).toBe(45230.5);

    const client = JSON.parse(conflict.recordset[0].client_version_json);
    expect(client.startOdometer).toBe(100);
  });

  test('FUEL_LOG odometer regression parks as CONFLICT', async () => {
    const { token } = await login('driver');
    const res = await push(token, 'device-C2', [{
      clientRef: 'conflict-fuel-001',
      entityType: 'FUEL_LOG',
      payload: { vehicleKey: 1, odometerReading: 10, litersFilled: 20, refuelTime: new Date().toISOString() }
    }]);

    expect(res.body.data.processing.conflicts).toBe(1);
    const row = await executeQuery(
      "SELECT sync_status FROM sync_queue WHERE client_ref = 'conflict-fuel-001'"
    );
    expect(row.recordset[0].sync_status).toBe('CONFLICT');
  });
});

describe('conflict generation: active-trip collision', () => {
  test('second TRIP_START while one is active parks as CONFLICT', async () => {
    const { token } = await login('driver');

    // First trip starts cleanly
    const ok = await push(token, 'device-D', [{
      clientRef: 'trip-ok-001',
      entityType: 'TRIP_START',
      payload: { vehicleKey: 1, startOdometer: 46000, startTime: new Date().toISOString() }
    }]);
    expect(ok.body.data.processing.synced).toBe(1);

    // Second trip on the same vehicle -> active-trip conflict
    const clash = await push(token, 'device-D2', [{
      clientRef: 'trip-clash-001',
      entityType: 'TRIP_START',
      payload: { vehicleKey: 1, startOdometer: 46100, startTime: new Date().toISOString() }
    }]);
    expect(clash.body.data.processing.conflicts).toBe(1);

    const queue = await executeQuery(
      "SELECT sync_status, error_message FROM sync_queue WHERE client_ref = 'trip-clash-001'"
    );
    expect(queue.recordset[0].sync_status).toBe('CONFLICT');
    expect(queue.recordset[0].error_message).toMatch(/active trip/i);

    const conflict = await executeQuery(
      `SELECT c.server_version_json FROM sync_conflict_log c
         JOIN sync_queue q ON c.queue_id = q.queue_id
        WHERE q.client_ref = 'trip-clash-001'`
    );
    const server = JSON.parse(conflict.recordset[0].server_version_json);
    expect(server.active_trip).toBeDefined();

    // Exactly one trip row exists in the fact table
    const trips = await executeQuery('SELECT COUNT(*) AS n FROM fact_trip');
    expect(trips.recordset[0].n).toBe(1);
  });
});

describe('conflict generation: custody-chain out of order', () => {
  test('DISPATCH_ACK security stamp without warehouse stamp parks as CONFLICT', async () => {
    const wm = await login('warehouseManager');
    const { request, app } = require('../helpers/apiClient');

    const created = await authed(wm.token).post('/api/warehouse/dispatch').send({
      customerKey: 1,
      invoiceNumber: 'INV-CUSTODY-001',
      lines: [{ productKey: 1, invoiceQty: 5, pickedQty: 5 }]
    });
    expect(created.status).toBe(201);
    const dispatchKey = created.body.data.dispatchKey;

    const res = await push(wm.token, 'device-E', [{
      clientRef: 'ack-premature-001',
      entityType: 'DISPATCH_ACK',
      payload: { dispatchKey, stage: 'SECURITY' } // warehouse stamp missing
    }]);

    expect(res.body.data.processing.conflicts).toBe(1);
    const row = await executeQuery(
      "SELECT sync_status, error_message FROM sync_queue WHERE client_ref = 'ack-premature-001'"
    );
    expect(row.recordset[0].sync_status).toBe('CONFLICT');
    expect(row.recordset[0].error_message).toMatch(/Warehouse must stamp/i);
  });
});
