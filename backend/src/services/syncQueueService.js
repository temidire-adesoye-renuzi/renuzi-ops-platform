/* ============================================================================
   SYNC QUEUE SERVICE (Service Layer)
   The queue engine. Consumers: routes/sync.js, jobs/scheduler.js, tests.

   ─── MULTI-INSTANCE SAFETY (Objective 2) ───────────────────────────────
   The legacy "soft claim" (SELECT then UPDATE-to-PROCESSING) allowed two
   instances to claim the same PENDING row and double-apply it. The claim
   below is a SINGLE atomic statement:

     UPDATE sync_queue
        SET sync_status = 'PROCESSING', claimed_at = GETDATE(), claimed_by = @worker
       OUTPUT INSERTED.*
      WHERE sync_status IN ('PENDING','FAILED')
        AND (next_retry_at IS NULL OR next_retry_at <= GETDATE())
        AND retry_count < @maxRetry
        AND business_key = @businessKey

   SQL Server takes the row-update lock BEFORE returning the row; exactly
   one UPDATE ever flips a given PENDING row, and only that instance
   receives it in the OUTPUT set. The row itself is the mutex - no
   sp_getapplock (which would need extra permissions on the least-privilege
   login) and no distributed coordinator.

   ─── RETRY POLICY (Objective 2) ────────────────────────────────────────
   Failures are NOT retried immediately. next_retry_at is scheduled with
   exponential backoff + jitter (utils/backoff), so a database brownout is
   not hammered by every failed row at once.

   ─── BUG FIX (was sync.js:331) ──────────────────────────────────────────
   The old failure CASE was:
     sync_status = CASE WHEN retry_count + 1 >= @maxRetry THEN 'FAILED' ELSE 'FAILED' END
   Both branches said 'FAILED', so nothing ever distinguished "retryable
   failure" from "permanently dead". Corrected semantics:
     - retry_count + 1 <  maxRetry  -> FAILED (retryable, next_retry_at set)
     - retry_count + 1 >= maxRetry  -> DEAD_LETTER (terminal, manual review)
   ============================================================================ */

const { executeQuery } = require('../config/db');
const { env } = require('../config/env');
const { SYNC_STATUS } = require('../constants');
const { backoffDelayMs } = require('../utils/backoff');
const { isSyncConflict } = require('../utils/syncError');
const { HttpError } = require('../utils/httpError');
const { getProcessor } = require('../sync/processorRegistry');

const WORKER_ID = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/* ---------------------------------------------------------------------------
   Idempotent batch enqueue
   --------------------------------------------------------------------------- */

/**
 * Enqueue one item. Returns { status: 'QUEUED' | 'DUPLICATE_ACK' | 'ALREADY_QUEUED', queueId }.
 * The unique filtered index UX_sync_queue_client_ref is the idempotency
 * backstop: even two racing devices with the same clientRef cannot both
 * insert (the second gets a constraint violation which we translate into
 * ALREADY_QUEUED rather than a 500).
 */
async function enqueueItem({ deviceId, userKey, businessKey, clientRef, entityType, payload }) {
  try {
    const inserted = await executeQuery(
      `INSERT INTO sync_queue (
         device_id, user_key, business_key, entity_type,
         client_ref, payload_json, sync_status, retry_count
       ) OUTPUT INSERTED.queue_id
       VALUES (
         @deviceId, @userKey, @businessKey, @entityType,
         @clientRef, @payloadJson, @syncStatus, 0
       )`,
      {
        deviceId,
        userKey,
        businessKey,
        entityType,
        clientRef,
        payloadJson: JSON.stringify({ clientRef, ...payload }),
        syncStatus: SYNC_STATUS.PENDING
      }
    );
    return { status: 'QUEUED', queueId: inserted.recordset[0].queue_id };
  } catch (err) {
    // 2601 = unique index violation -> duplicate push, treat as ack
    if (err && (err.number === 2601 || err.number === 2627 ||
        /unique index|UX_sync_queue_client_ref/i.test(String(err.message)))) {
      const existing = await executeQuery(
        `SELECT queue_id, sync_status FROM sync_queue
          WHERE device_id = @deviceId AND user_key = @userKey
            AND entity_type = @entityType AND client_ref = @clientRef`,
        { deviceId, userKey, entityType, clientRef }
      );
      const row = existing.recordset[0];
      return {
        status: row && row.sync_status === SYNC_STATUS.SYNCED ? 'DUPLICATE_ACK' : 'ALREADY_QUEUED',
        queueId: row ? row.queue_id : null
      };
    }
    throw err;
  }
}

/* ---------------------------------------------------------------------------
   Atomic claim (multi-instance safe)
   --------------------------------------------------------------------------- */

/**
 * Atomically claim a batch of runnable rows.
 *
 * Multi-instance safety: the IN (SELECT TOP ... WITH (UPDLOCK, HOLDLOCK))
 * subquery takes update locks on candidates for the duration of the
 * statement; a second instance blocks, then re-evaluates the predicate and
 * sees the rows already claimed, so claimers always receive DISJOINT sets.
 * `ignoreBackoff` (tests) drops the next_retry_at gate.
 */
async function claimBatch(businessKey, { batchSize, maxRetry, stuckMinutes, ignoreBackoff = false }) {
  const backoffGate = ignoreBackoff
    ? '' : 'AND (next_retry_at IS NULL OR next_retry_at <= GETDATE())';

  const result = await executeQuery(
    `UPDATE sync_queue
        SET sync_status = 'PROCESSING',
            claimed_at = GETDATE(),
            claimed_by = @workerId,
            error_message = NULL
       OUTPUT INSERTED.queue_id, INSERTED.device_id, INSERTED.user_key,
              INSERTED.business_key, INSERTED.entity_type, INSERTED.client_ref,
              INSERTED.payload_json, INSERTED.retry_count
      WHERE queue_id IN (
        SELECT TOP (@batchSize) queue_id
          FROM sync_queue WITH (UPDLOCK, HOLDLOCK)
         WHERE business_key = @businessKey
           AND (
             ( sync_status IN ('PENDING','FAILED')
               AND retry_count < @maxRetry
               ${backoffGate} )
             OR
             ( sync_status = 'PROCESSING'
               AND claimed_at IS NOT NULL
               AND DATEDIFF(MINUTE, claimed_at, GETDATE()) >= @stuckMinutes )
           )
         ORDER BY queue_id ASC
      );`,
    {
      workerId: WORKER_ID,
      businessKey,
      maxRetry,
      stuckMinutes,
      batchSize
    }
  );
  return result.recordset;
}

/* ---------------------------------------------------------------------------
   Terminal/failure transitions
   --------------------------------------------------------------------------- */

async function markSynced(queueId, entityKey) {
  await executeQuery(
    `UPDATE sync_queue SET
       sync_status = 'SYNCED', processed_at = GETDATE(),
       entity_key = @entityKey, error_message = NULL
     WHERE queue_id = @queueId`,
    { entityKey: entityKey ?? null, queueId }
  );
}

async function markConflict(queueId, entityType, errorMessage, serverVersion, clientPayload) {
  await executeQuery(
    `UPDATE sync_queue SET
       sync_status = 'CONFLICT', error_message = @errorMessage, processed_at = GETDATE()
     WHERE queue_id = @queueId`,
    { errorMessage: String(errorMessage).slice(0, 500), queueId }
  );
  await executeQuery(
    `INSERT INTO sync_conflict_log (queue_id, entity_type, server_version_json, client_version_json, resolution)
     VALUES (@queueId, @entityType, @serverVersion, @clientVersion, 'PENDING')`,
    {
      queueId,
      entityType,
      serverVersion: serverVersion ? JSON.stringify(serverVersion) : null,
      clientVersion: clientVersion !== undefined ? JSON.stringify(clientVersion) : null
    }
  );
}

/**
 * Record a non-conflict failure with the CORRECTED exhaustion semantics
 * (bug fix for the old sync.js:331 CASE that marked everything FAILED).
 * Backoff GROWS with retry_count: delay = base * 2^retryCount (jittered),
 * so a persistently failing row backs off progressively instead of
 * hammering once per cron tick.
 */
async function markFailed(queueId, maxRetry, errorMessage, retryCount = 0) {
  const delayMs = backoffDelayMs(retryCount, { baseSeconds: env.sync.backoffBaseSeconds });
  await executeQuery(
    `UPDATE sync_queue
        SET retry_count = retry_count + 1,
            sync_status = CASE WHEN retry_count + 1 >= @maxRetry THEN 'DEAD_LETTER' ELSE 'FAILED' END,
            next_retry_at = CASE WHEN retry_count + 1 >= @maxRetry THEN NULL ELSE @nextRetryAt END,
            error_message = @errorMessage,
            processed_at = GETDATE()
      WHERE queue_id = @queueId`,
    {
      maxRetry,
      nextRetryAt: new Date(Date.now() + delayMs),
      errorMessage: String(errorMessage).slice(0, 500),
      queueId
    }
  );
}

/* ---------------------------------------------------------------------------
   Queue runner
   --------------------------------------------------------------------------- */

/**
 * Claim and process one batch for a business.
 * Exposed for: POST /api/sync/process, the cron scheduler, and tests.
 *
 * @returns {{ processed:number, synced:number, failed:number, conflicts:number,
 *             deadLettered:number, reclaimed:number }}
 */
async function processQueue(businessKey, opts = {}) {
  const batchSize = opts.batchSize ?? await getConfig('SYNC_BATCH_SIZE', 50);
  const maxRetry = opts.maxRetry ?? await getConfig('SYNC_RETRY_MAX', env.sync.retryMaxDefault);
  const stuckMinutes = opts.stuckMinutes ?? env.sync.stuckProcessingMinutes;
  const skipBackoff = opts.skipBackoff === true; // tests use instant retry

  const claimed = await claimBatch(businessKey, {
    batchSize, maxRetry, stuckMinutes, ignoreBackoff: skipBackoff
  });

  let synced = 0, failed = 0, conflicts = 0, deadLettered = 0, reclaimed = 0;
  let processed = 0;

  for (const row of claimed) {
    processed++;
    if (row.retry_count > 0) reclaimed++; // this attempt came from a retry/stuck path

    try {
      const payload = JSON.parse(row.payload_json);
      const processor = getProcessor(row.entity_type);
      if (!processor) {
        throw new Error(`No server processor for entity type ${row.entity_type}`);
      }

      const entityKey = await processor(
        { userKey: row.user_key, businessKey: row.business_key, deviceId: row.device_id },
        payload
      );

      await markSynced(row.queue_id, entityKey ?? null);
      synced++;
    } catch (err) {
      if (isSyncConflict(err)) {
        conflicts++;
        await markConflict(
          row.queue_id, row.entity_type, err.message, err.serverVersion,
          err.extra && err.extra.clientPayload !== undefined ? err.extra.clientPayload : row.payload_json
        );
      } else {
        failed++;
        // Determine whether this failure exhausts the budget (for reporting)
        const willDead = row.retry_count + 1 >= maxRetry;
        if (willDead) deadLettered++;
        if (skipBackoff) {
          await executeQuery(
            `UPDATE sync_queue
                SET retry_count = retry_count + 1,
                    sync_status = CASE WHEN retry_count + 1 >= @maxRetry THEN 'DEAD_LETTER' ELSE 'FAILED' END,
                    next_retry_at = NULL,
                    error_message = @errorMessage,
                    processed_at = GETDATE()
              WHERE queue_id = @queueId`,
            { maxRetry, errorMessage: String(err.message).slice(0, 500), queueId: row.queue_id }
          );
        } else {
          await markFailed(row.queue_id, maxRetry, err.message, row.retry_count);
        }
      }
    }
  }

  return { processed, synced, failed, conflicts, deadLettered, reclaimed };
}

/* ---------------------------------------------------------------------------
   Admin/status helpers
   --------------------------------------------------------------------------- */

async function getConfig(name, fallback) {
  const result = await executeQuery(
    'SELECT config_value FROM app_config WHERE config_name = @name',
    { name }
  );
  const row = result.recordset[0];
  if (!row) return fallback;
  const v = parseInt(row.config_value, 10);
  return Number.isNaN(v) ? fallback : v;
}

/** Device-level queue status (route: GET /api/sync/status). */
async function getQueueStatus(businessKey, deviceId) {
  let query = `
    SELECT device_id,
           COUNT(*) AS total_queued,
           SUM(CASE WHEN sync_status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN sync_status = 'PROCESSING' THEN 1 ELSE 0 END) AS processing,
           SUM(CASE WHEN sync_status = 'SYNCED' THEN 1 ELSE 0 END) AS synced,
           SUM(CASE WHEN sync_status = 'FAILED' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN sync_status = 'CONFLICT' THEN 1 ELSE 0 END) AS conflict,
           SUM(CASE WHEN sync_status = 'DEAD_LETTER' THEN 1 ELSE 0 END) AS dead_letter,
           MAX(created_at) AS last_push_at,
           MAX(processed_at) AS last_processed_at
      FROM sync_queue
     WHERE business_key = @businessKey
  `;
  const params = { businessKey };
  if (deviceId) { query += ' AND device_id = @deviceId'; params.deviceId = deviceId; }
  query += ' GROUP BY device_id ORDER BY MAX(created_at) DESC';
  const result = await executeQuery(query, params);
  return result.recordset;
}

/**
 * Requeue a DEAD_LETTER or FAILED row to PENDING (manual admin action or test).
 * @returns {boolean} true when a row was actually reset.
 */
async function requeueQueueRow(businessKey, queueId) {
  const result = await executeQuery(
    `UPDATE sync_queue
        SET sync_status = 'PENDING', retry_count = 0, next_retry_at = NULL, error_message = NULL
       OUTPUT INSERTED.queue_id
      WHERE queue_id = @queueId AND business_key = @businessKey
        AND sync_status IN ('FAILED','DEAD_LETTER')`,
    { queueId, businessKey }
  );
  return result.recordset.length > 0;
}

/** Assert an entityType is known (route validation). */
function assertValidEntityType(entityType) {
  const { SYNC_ENTITY_TYPES } = require('../constants');
  if (!SYNC_ENTITY_TYPES.includes(entityType)) {
    throw new HttpError(400, `Unknown entityType ${entityType}`);
  }
}

module.exports = {
  WORKER_ID,
  enqueueItem,
  claimBatch,
  markSynced,
  markConflict,
  markFailed,
  processQueue,
  getQueueStatus,
  requeueQueueRow,
  assertValidEntityType
};
