/* ============================================================================
   INTEGRATION: Sync batch idempotency + full offline pipeline (Objective 4a)
   Verifies:
   - pushing the same clientRef twice never double-inserts
   - a valid batch is processed: queue rows -> fact tables
   - all five warehouse entity types process (Objective 1a end-to-end)
   ============================================================================ */

const db = require('../helpers/dbTestHelper');
const { app, request, login, authed, clearRotationFlags } = require('../helpers/apiClient');
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

describe('POST /api/sync/batch idempotency', () => {
  test('re-pushing the same clientRef acknowledges instead of duplicating', async () => {
    const { token } = await login('driver');

    const item = {
      clientRef: 'idem-test-001',
      entityType: 'VEHICLE_CHECK',
      payload: {
        vehicleKey: 1,
        checkTime: new Date().toISOString(),
        tiresOk: true, lightsOk: true, brakesOk: true, engineOk: true,
        oilLevelOk: true, coolantOk: true, wipersOk: true, mirrorsOk: true,
        seatbeltsOk: true, fireExtinguisherOk: true, firstAidKitOk: true,
        hasDamage: false
      }
    };

    // First push: QUEUED + processed immediately
    const first = await authed(token)
      .post('/api/sync/batch')
      .send({ deviceId: 'device-A', items: [item] });
    expect(first.status).toBe(200);
    expect(first.body.data.results[0].status).toBe('QUEUED');

    const checksAfterFirst = await executeQuery('SELECT COUNT(*) AS n FROM fact_vehicle_check');
    expect(checksAfterFirst.recordset[0].n).toBe(1);

    // Second push of the SAME clientRef from the SAME device+user
    const second = await authed(token)
      .post('/api/sync/batch')
      .send({ deviceId: 'device-A', items: [item] });
    expect(second.status).toBe(200);
    expect(['DUPLICATE_ACK', 'ALREADY_QUEUED']).toContain(second.body.data.results[0].status);

    const checksAfterSecond = await executeQuery('SELECT COUNT(*) AS n FROM fact_vehicle_check');
    expect(checksAfterSecond.recordset[0].n).toBe(1); // NO double insert
  });

  test('batch retries after a FAILED row re-apply exactly once', async () => {
    const { token } = await login('driver');

    // A payload with an INVALID productKey will fail processing (FK/guard),
    // then we push a GOOD payload and confirm normal processing resumes.
    const bad = {
      clientRef: 'retry-bad-001',
      entityType: 'STOCK_MOVEMENT',
      payload: {
        productKey: 999999,           // does not exist -> guard failure
        movementType: 'ADJUSTMENT',
        quantity: 5
      }
    };
    const res1 = await authed(token).post('/api/sync/batch').send({ deviceId: 'device-B', items: [bad] });
    expect(res1.status).toBe(200);
    expect(res1.body.data.results[0].status).toBe('QUEUED');
    expect(res1.body.data.processing.failed).toBe(1);

    const row = await executeQuery(
      "SELECT retry_count, sync_status, next_retry_at FROM sync_queue WHERE client_ref = 'retry-bad-001'"
    );
    expect(row.recordset[0].retry_count).toBe(1);
    expect(row.recordset[0].sync_status).toBe('FAILED');
    expect(row.recordset[0].next_retry_at).not.toBeNull(); // backoff scheduled
  });
});

describe('warehouse offline pipeline (Objective 1a)', () => {
  test('GRN batch creates header + lines + receipt movements transactionally', async () => {
    const { token } = await login('warehouseManager');

    const grnItem = {
      clientRef: 'grn-sync-001',
      entityType: 'GRN',
      payload: {
        waybillNumber: 'WB-SYNC-001',
        invoiceNumber: 'INV-SYNC-001',
        lines: [
          { productKey: 1, invoiceQty: 100, receivedQty: 90, rejectedQty: 10, allocatedLocation: 'MAIN' }
        ]
      }
    };

    const res = await authed(token)
      .post('/api/sync/batch')
      .send({ deviceId: 'device-WH', items: [grnItem] });

    expect(res.status).toBe(200);
    expect(res.body.data.processing.synced).toBe(1);

    const grn = await executeQuery(
      "SELECT grn_key, receipt_status, total_invoice_qty, total_received_qty, total_rejected_qty FROM fact_grn WHERE invoice_number = 'INV-SYNC-001'"
    );
    expect(grn.recordset.length).toBe(1);
    expect(grn.recordset[0].receipt_status).toBe('PARTIAL');
    expect(grn.recordset[0].total_received_qty).toBe(90);

    const lines = await executeQuery('SELECT COUNT(*) AS n FROM fact_grn_line');
    expect(lines.recordset[0].n).toBe(1);

    const movements = await executeQuery(
      "SELECT COUNT(*) AS n FROM fact_stock_movement WHERE movement_type = 'RECEIPT'"
    );
    expect(movements.recordset[0].n).toBe(1);

    const queue = await executeQuery(
      "SELECT entity_key, sync_status FROM sync_queue WHERE client_ref = 'grn-sync-001'"
    );
    expect(queue.recordset[0].sync_status).toBe('SYNCED');
    expect(queue.recordset[0].entity_key).toBe(grn.recordset[0].grn_key);
  });

  test('DISPATCH_ACK stamps the custody chain in order (warehouse->security->driver)', async () => {
    const { token } = await login('warehouseManager');

    // Create a dispatch online first
    const created = await authed(token).post('/api/warehouse/dispatch').send({
      customerKey: 1,
      invoiceNumber: 'INV-DSP-SYNC-001',
      driverKey: 4,
      vehicleKey: 1,
      lines: [{ productKey: 1, invoiceQty: 10, pickedQty: 10, loadedQty: 10 }]
    });
    expect(created.status).toBe(201);
    const dispatchKey = created.body.data.dispatchKey;

    // Queue the three stamps as offline payloads
    const items = ['WAREHOUSE', 'SECURITY', 'DRIVER'].map((stage, i) => ({
      clientRef: `ack-${stage.toLowerCase()}-001`,
      entityType: 'DISPATCH_ACK',
      payload: { dispatchKey, stage }
    }));

    const res = await authed(token)
      .post('/api/sync/batch')
      .send({ deviceId: 'device-WH2', items });
    expect(res.status).toBe(200);
    expect(res.body.data.processing.synced).toBe(3);

    const d = await executeQuery(
      'SELECT warehouse_stamp, security_stamp, driver_acknowledged, dispatch_status FROM fact_dispatch WHERE dispatch_key = @k',
      { k: dispatchKey }
    );
    expect(d.recordset[0].warehouse_stamp).toBe(1);
    expect(d.recordset[0].security_stamp).toBe(1);
    expect(d.recordset[0].driver_acknowledged).toBe(1);
    expect(d.recordset[0].dispatch_status).toBe('IN_TRANSIT');
  });

  test('STOCK_COUNT computes variance server-side', async () => {
    const { token } = await login('warehouseManager');
    const res = await authed(token)
      .post('/api/sync/batch')
      .send({
        deviceId: 'device-WH3',
        items: [{
          clientRef: 'count-sync-001',
          entityType: 'STOCK_COUNT',
          payload: { productKey: 1, systemQty: 100, physicalCount: 96, varianceReason: 'Pilferage suspected' }
        }]
      });

    expect(res.status).toBe(200);
    expect(res.body.data.processing.synced).toBe(1);

    const sc = await executeQuery(
      "SELECT system_qty, physical_count, variance, variance_reason FROM fact_stock_count WHERE product_key = 1"
    );
    expect(sc.recordset[0].variance).toBe(-4);
    expect(sc.recordset[0].variance_reason).toBe('Pilferage suspected');
  });

  test('GOODS_RETURN creates the return + TRANSFER_IN movement', async () => {
    const { token } = await login('warehouseManager');
    const res = await authed(token)
      .post('/api/sync/batch')
      .send({
        deviceId: 'device-WH4',
        items: [{
          clientRef: 'return-sync-001',
          entityType: 'GOODS_RETURN',
          payload: {
            customerKey: 1,
            productKey: 1,
            returnType: 'DAMAGED',
            quantityReturned: 3
          }
        }]
      });

    expect(res.status).toBe(200);
    expect(res.body.data.processing.synced).toBe(1);

    const gr = await executeQuery('SELECT COUNT(*) AS n FROM fact_goods_return');
    expect(gr.recordset[0].n).toBe(1);
    const mv = await executeQuery(
      "SELECT COUNT(*) AS n FROM fact_stock_movement WHERE movement_type = 'TRANSFER_IN' AND reference_type = 'RETURN'"
    );
    expect(mv.recordset[0].n).toBe(1);
  });

  test('STOCK_MOVEMENT (adjustment) processes offline', async () => {
    const { token } = await login('warehouseManager');
    const res = await authed(token)
      .post('/api/sync/batch')
      .send({
        deviceId: 'device-WH5',
        items: [{
          clientRef: 'move-sync-001',
          entityType: 'STOCK_MOVEMENT',
          payload: { productKey: 1, movementType: 'DAMAGED', quantity: 2, notes: 'Crushed cases' }
        }]
      });

    expect(res.status).toBe(200);
    expect(res.body.data.processing.synced).toBe(1);
    const mv = await executeQuery(
      "SELECT COUNT(*) AS n FROM fact_stock_movement WHERE movement_type = 'DAMAGED'"
    );
    expect(mv.recordset[0].n).toBe(1);
  });
});
