/* ============================================================================
   INTEGRATION: Retry-count exhaustion (Objective 4c)
   Verifies the CORRECTED failure semantics (the old sync.js:331 bug):
   - failures before the budget are FAILED + retryable with backoff
   - at the budget the row becomes DEAD_LETTER (terminal)
   - a requeue resets the row for another lifecycle
   ============================================================================ */

const db = require('../helpers/dbTestHelper');
const { authed, login, clearRotationFlags } = require('../helpers/apiClient');
const { executeQuery } = require('../../src/config/db');
const syncQueueService = require('../../src/services/syncQueueService');

beforeAll(async () => {
  await db.migrate();
  await clearRotationFlags();
  // Set a low retry budget for this suite
  await executeQuery("UPDATE app_config SET config_value = '3' WHERE config_name = 'SYNC_RETRY_MAX'");
});

beforeEach(async () => {
  await db.cleanOperationalData();
});

afterAll(async () => {
  await executeQuery("UPDATE app_config SET config_value = '5' WHERE config_name = 'SYNC_RETRY_MAX'");
  await db.close();
});

describe('retry exhaustion (corrected sync.js:331 semantics)', () => {
  test('a failing row retries FAILED then becomes DEAD_LETTER at the budget', async () => {
    const { token } = await login('warehouseManager');

    // Enqueue a payload that always fails (product does not exist)
    const res = await authed(token).post('/api/sync/batch').send({
      deviceId: 'device-R',
      items: [{
        clientRef: 'exhaust-001',
        entityType: 'STOCK_MOVEMENT',
        payload: { productKey: 424242, movementType: 'ADJUSTMENT', quantity: 1 }
      }]
    });
    expect(res.status).toBe(200);
    expect(res.body.data.processing.failed).toBe(1);

    let row = await executeQuery(
      "SELECT retry_count, sync_status, next_retry_at FROM sync_queue WHERE client_ref = 'exhaust-001'"
    );
    expect(row.recordset[0].retry_count).toBe(1);
    expect(row.recordset[0].sync_status).toBe('FAILED');          // still retryable
    expect(row.recordset[0].next_retry_at).not.toBeNull();        // backoff set

    // Drain retries with backoff bypassed (test mode) until exhaustion
    for (let attempt = 2; attempt <= 3; attempt++) {
      const summary = await syncQueueService.processQueue(1, { skipBackoff: true });
      row = await executeQuery(
        "SELECT retry_count, sync_status FROM sync_queue WHERE client_ref = 'exhaust-001'"
      );
      expect(row.recordset[0].retry_count).toBe(attempt);
      expect(row.recordset[0].sync_status)
        .toBe(attempt >= 3 ? 'DEAD_LETTER' : 'FAILED');
    }

    // Terminal: further processing never picks it up again
    const idle = await syncQueueService.processQueue(1, { skipBackoff: true });
    expect(idle.processed).toBe(0);

    row = await executeQuery("SELECT retry_count, sync_status FROM sync_queue WHERE client_ref = 'exhaust-001'");
    expect(row.recordset[0].sync_status).toBe('DEAD_LETTER');
    expect(row.recordset[0].retry_count).toBe(3);
  });

  test('backoff window gates reprocessing (FAILED row is not retried before next_retry_at)', async () => {
    const { token } = await login('warehouseManager');

    await authed(token).post('/api/sync/batch').send({
      deviceId: 'device-R2',
      items: [{
        clientRef: 'backoff-001',
        entityType: 'STOCK_MOVEMENT',
        payload: { productKey: 987654, movementType: 'ADJUSTMENT', quantity: 1 }
      }]
    });

    // First failure happened during the batch push. A normal (non-test)
    // process pass must NOT re-claim the row: next_retry_at is in the future.
    const summary = await syncQueueService.processQueue(1, { skipBackoff: false });
    expect(summary.processed).toBe(0);
  });

  test('requeue resets a DEAD_LETTER row to PENDING for a fresh lifecycle', async () => {
    const { token } = await login('warehouseManager');

    await authed(token).post('/api/sync/batch').send({
      deviceId: 'device-R3',
      items: [{
        clientRef: 'requeue-001',
        entityType: 'STOCK_MOVEMENT',
        payload: { productKey: 555555, movementType: 'ADJUSTMENT', quantity: 1 }
      }]
    });

    // Exhaust to DEAD_LETTER
    await syncQueueService.processQueue(1, { skipBackoff: true });
    await syncQueueService.processQueue(1, { skipBackoff: true });
    await syncQueueService.processQueue(1, { skipBackoff: true });

    let row = await executeQuery("SELECT sync_status FROM sync_queue WHERE client_ref = 'requeue-001'");
    expect(row.recordset[0].sync_status).toBe('DEAD_LETTER');

    // Admin requeue
    const { request, app } = require('../helpers/apiClient');
    const queueIdRow = await executeQuery("SELECT queue_id FROM sync_queue WHERE client_ref = 'requeue-001'");
    const queueId = queueIdRow.recordset[0].queue_id;

    const admin = await login('admin');
    const rq = await authed(admin.token).post(`/api/sync/queue/${queueId}/requeue`).send({});
    expect(rq.status).toBe(200);

    row = await executeQuery("SELECT sync_status, retry_count FROM sync_queue WHERE client_ref = 'requeue-001'");
    expect(row.recordset[0].sync_status).toBe('PENDING');
    expect(row.recordset[0].retry_count).toBe(0);
  });
});
