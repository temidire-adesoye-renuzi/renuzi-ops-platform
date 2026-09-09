/* ============================================================================
   INTEGRATION: Conflict resolution loop closure (Objective 3)
   Verifies the winning version is ACTIVELY re-applied:
   - SERVER_WINS: queue row leaves CONFLICT without touching facts
   - CLIENT_WINS: the client payload is re-applied THROUGH the processor
     (odometer regression deliberately accepted) and the fact table changes
   - MERGED: the merged payload is applied
   - mobile reconciliation feed exposes both versions (GET /conflicts)
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

describe('conflict feed (mobile reconciliation)', () => {
  test('GET /api/sync/conflicts exposes both versions with PENDING resolution', async () => {
    const { token } = await login('driver');

    await authed(token).post('/api/sync/batch').send({
      deviceId: 'device-F',
      items: [{
        clientRef: 'feed-001',
        entityType: 'TRIP_START',
        payload: { vehicleKey: 1, startOdometer: 1 } // regression -> conflict
      }]
    });

    const res = await authed(token).get('/api/sync/conflicts');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);

    const c = res.body.data[0];
    expect(c.resolution).toBe('PENDING');
    expect(c.device_id).toBe('device-F');
    expect(JSON.parse(c.server_version_json).current_odometer).toBe(45230.5);
    expect(JSON.parse(c.client_version_json).startOdometer).toBe(1);
  });
});

describe('loop closure: resolutions actively re-apply the winner', () => {
  async function makeOdometerConflict() {
    const driver = await login('driver');
    await authed(driver.token).post('/api/sync/batch').send({
      deviceId: 'device-G',
      items: [{
        clientRef: 'resolve-001',
        entityType: 'TRIP_START',
        payload: { vehicleKey: 1, startOdometer: 30000, startTime: new Date().toISOString() }
      }]
    });
    const conflict = await executeQuery(
      `SELECT c.conflict_key FROM sync_conflict_log c
         JOIN sync_queue q ON c.queue_id = q.queue_id
        WHERE q.client_ref = 'resolve-001' AND c.resolution = 'PENDING'`
    );
    return { conflictKey: conflict.recordset[0].conflict_key, driver };
  }

  test('SERVER_WINS closes the conflict WITHOUT applying the stale client payload', async () => {
    const { conflictKey, driver } = await makeOdometerConflict();

    const admin = await login('admin');
    const res = await authed(admin.token)
      .put(`/api/sync/conflicts/${conflictKey}/resolve`)
      .send({ resolution: 'SERVER_WINS', resolutionNotes: 'Server odometer is authoritative' });

    expect(res.status).toBe(200);
    expect(res.body.data.applied).toBe('SERVER_KEPT');

    // The parked row is out of CONFLICT and no trip was created
    const queue = await executeQuery(
      "SELECT sync_status FROM sync_queue WHERE client_ref = 'resolve-001'"
    );
    expect(queue.recordset[0].sync_status).toBe('SYNCED');
    const trips = await executeQuery('SELECT COUNT(*) AS n FROM fact_trip');
    expect(trips.recordset[0].n).toBe(0);

    // The conflict feed no longer lists it
    const feed = await authed(driver.token).get('/api/sync/conflicts');
    expect(feed.body.count).toBe(0);
  });

  test('CLIENT_WINS re-applies the client payload through the processor', async () => {
    const { conflictKey } = await makeOdometerConflict();

    const admin = await login('admin');
    const res = await authed(admin.token)
      .put(`/api/sync/conflicts/${conflictKey}/resolve`)
      .send({ resolution: 'CLIENT_WINS', resolutionNotes: 'Driver recorded the true odometer' });

    expect(res.status).toBe(200);
    expect(res.body.data.applied).toBe('CLIENT_APPLIED');
    expect(res.body.data.entityKey).toBeDefined();

    // The trip fact table now carries the client's version
    const trip = await executeQuery(
      'SELECT start_odometer, trip_status FROM fact_trip'
    );
    expect(trip.recordset.length).toBe(1);
    expect(Number(trip.recordset[0].start_odometer)).toBe(30000);
    expect(trip.recordset[0].trip_status).toBe('STARTED');

    const queue = await executeQuery(
      "SELECT sync_status, entity_key FROM sync_queue WHERE client_ref = 'resolve-001'"
    );
    expect(queue.recordset[0].sync_status).toBe('SYNCED');
    expect(queue.recordset[0].entity_key).toBe(res.body.data.entityKey);
  });

  test('MERGED applies the merged payload and records the notes', async () => {
    const { conflictKey } = await makeOdometerConflict();

    const admin = await login('admin');
    const res = await authed(admin.token)
      .put(`/api/sync/conflicts/${conflictKey}/resolve`)
      .send({
        resolution: 'MERGED',
        mergedPayload: { startOdometer: 45231, driverNotes: 'Merged reading after reconciliation' },
        resolutionNotes: 'Manager merged both readings'
      });

    expect(res.status).toBe(200);
    expect(res.body.data.applied).toBe('MERGE_APPLIED');

    const trip = await executeQuery('SELECT start_odometer, driver_notes FROM fact_trip');
    expect(trip.recordset.length).toBe(1);
    expect(Number(trip.recordset[0].start_odometer)).toBe(45231);
    expect(trip.recordset[0].driver_notes).toBe('Merged reading after reconciliation');

    const log = await executeQuery(
      "SELECT resolution, resolution_notes FROM sync_conflict_log WHERE conflict_key = @k",
      { k: conflictKey }
    );
    expect(log.recordset[0].resolution).toBe('MERGED');
    expect(log.recordset[0].resolution_notes).toBe('Manager merged both readings');
  });

  test('resolving twice is rejected (already resolved)', async () => {
    const { conflictKey } = await makeOdometerConflict();
    const admin = await login('admin');

    const first = await authed(admin.token)
      .put(`/api/sync/conflicts/${conflictKey}/resolve`)
      .send({ resolution: 'SERVER_WINS' });
    expect(first.status).toBe(200);

    const second = await authed(admin.token)
      .put(`/api/sync/conflicts/${conflictKey}/resolve`)
      .send({ resolution: 'CLIENT_WINS' });
    expect(second.status).toBe(409);
  });

  test('MERGED without mergedPayload is a 400', async () => {
    const { conflictKey } = await makeOdometerConflict();
    const admin = await login('admin');

    const res = await authed(admin.token)
      .put(`/api/sync/conflicts/${conflictKey}/resolve`)
      .send({ resolution: 'MERGED' });
    expect(res.status).toBe(400);
  });
});
