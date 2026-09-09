/* ============================================================================
   SYNC API ROUTES   All endpoints prefixed with /api/sync

     POST /api/sync/batch                    - Push queued payloads (idempotent)
     GET  /api/sync/status                   - Device pending/synced state
     POST /api/sync/process                  - Process queue (admin/tests)
     GET  /api/sync/conflicts                - Unresolved conflicts (client reconciliation feed)
     PUT  /api/sync/conflicts/:key/resolve   - Resolve + re-apply winner (loop closure)
     POST /api/sync/queue/:queueId/requeue   - Reset a FAILED/DEAD_LETTER row

   This file is now a THIN HTTP ADAPTER. All mechanics live in:
   - services/syncQueueService.js  (atomic claims, backoff, exhaustion)
   - services/conflictService.js   (resolution loop closure)
   - sync/processorRegistry.js     (entity processors)

   Route-level responsibilities only: auth, request shape validation,
   status-code mapping, JSON envelopes.
   ============================================================================ */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { requireAny, requireOpsOrAdmin } = require('../middleware/roleCheck');
const { HttpError } = require('../utils/httpError');
const syncQueueService = require('../services/syncQueueService');
const conflictService = require('../services/conflictService');
const { SYNC_ENTITY_TYPES } = require('../constants');

function fail(res, err, fallback, internal) {
  console.error(internal || fallback, err.message);
  return res.status(500).json({ success: false, message: fallback });
}

/* ============================================================================
   POST /api/sync/batch - Push a batch of queued payloads (idempotent)
   ============================================================================ */

router.post('/batch', authenticateToken, requireAny, async (req, res) => {
  try {
    const { deviceId, items } = req.body || {};

    if (!deviceId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'deviceId and a non-empty items array are required' });
    }

    const { executeQuery } = require('../config/db');
    const cfg = await executeQuery(
      "SELECT config_value FROM app_config WHERE config_name = 'SYNC_BATCH_SIZE'"
    );
    const maxBatchSize = parseInt(cfg.recordset[0]?.config_value, 10) || 50;
    if (items.length > maxBatchSize) {
      return res.status(400).json({ success: false, message: `Batch too large. Max ${maxBatchSize} items per batch.` });
    }

    const results = [];

    for (const item of items) {
      const { clientRef, entityType, payload } = item || {};

      if (!clientRef || !entityType || !payload) {
        results.push({ clientRef: clientRef || null, status: 'REJECTED', message: 'clientRef, entityType and payload are required' });
        continue;
      }
      if (!SYNC_ENTITY_TYPES.includes(entityType)) {
        results.push({ clientRef, status: 'REJECTED', message: `Unknown entityType ${entityType}` });
        continue;
      }

      try {
        const outcome = await syncQueueService.enqueueItem({
          deviceId,
          userKey: req.user.userKey,
          businessKey: req.user.businessKey,
          clientRef,
          entityType,
          payload
        });
        results.push({
          clientRef,
          queueId: outcome.queueId,
          status: outcome.status,
          message: outcome.status === 'QUEUED' ? undefined : 'Item already received'
        });
      } catch (err) {
        results.push({ clientRef, status: 'REJECTED', message: 'Queue write failed' });
        console.error('[SYNC] enqueue error:', err.message);
      }
    }

    // Process immediately after accepting the batch (best-effort; cron drains too)
    let processing = { processed: 0, synced: 0, failed: 0, conflicts: 0, deadLettered: 0, reclaimed: 0 };
    try {
      processing = await syncQueueService.processQueue(req.user.businessKey, { skipBackoff: false });
    } catch (err) {
      console.error('[SYNC] immediate processing failed (cron will retry):', err.message);
    }

    return res.json({
      success: true,
      message: `Batch received: ${results.filter((r) => r.status === 'QUEUED').length} queued, ${processing.processed} processed`,
      data: { results, processing }
    });
  } catch (err) {
    return fail(res, err, 'Failed to accept sync batch', '[SYNC] batch error:');
  }
});

/* ============================================================================
   GET /api/sync/status - Device pending state
   ============================================================================ */

router.get('/status', authenticateToken, requireAny, async (req, res) => {
  try {
    const { deviceId } = req.query;
    const data = await syncQueueService.getQueueStatus(req.user.businessKey, deviceId);
    return res.json({ success: true, count: data.length, data });
  } catch (err) {
    return fail(res, err, 'Failed to fetch sync status', '[SYNC] status error:');
  }
});

/* ============================================================================
   POST /api/sync/process - Process the queue (manual/admin trigger)
   The cron scheduler (jobs/scheduler.js) drives this automatically; the
   endpoint stays for admin intervention and tests.
   ============================================================================ */

router.post('/process', authenticateToken, requireAny, async (req, res) => {
  try {
    const summary = await syncQueueService.processQueue(req.user.businessKey);
    return res.json({ success: true, message: `Processed ${summary.processed} items`, data: summary });
  } catch (err) {
    return fail(res, err, 'Failed to process sync queue', '[SYNC] process error:');
  }
});

/* ============================================================================
   GET /api/sync/conflicts - Unresolved conflicts
   Objective 3: exposes BOTH versions (server + client) so the mobile app
   can render a reconciliation screen and re-submit local state after
   resolution.
   ============================================================================ */

router.get('/conflicts', authenticateToken, requireAny, async (req, res) => {
  try {
    const data = await conflictService.listPendingConflicts(req.user.businessKey);
    return res.json({ success: true, count: data.length, data });
  } catch (err) {
    return fail(res, err, 'Failed to fetch conflicts', '[SYNC] conflicts error:');
  }
});

/* ============================================================================
   PUT /api/sync/conflicts/:conflictKey/resolve - Resolve + RE-APPLY winner
   Body: { resolution: 'SERVER_WINS'|'CLIENT_WINS'|'MERGED',
           mergedPayload?: object (required for MERGED),
           resolutionNotes? }
   ============================================================================ */

router.put('/conflicts/:conflictKey/resolve', authenticateToken, requireOpsOrAdmin, async (req, res) => {
  try {
    const conflictKey = Number(req.params.conflictKey);
    const { resolution, mergedPayload, resolutionNotes } = req.body || {};

    const outcome = await conflictService.resolveConflict(
      { userKey: req.user.userKey, businessKey: req.user.businessKey },
      conflictKey,
      resolution,
      mergedPayload,
      resolutionNotes
    );

    return res.json({
      success: true,
      message: `Conflict resolved as ${resolution}; winner re-applied (${outcome.applied})`,
      data: outcome
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ success: false, message: err.publicMessage });
    }
    return fail(res, err, 'Failed to resolve conflict', '[SYNC] conflict resolve error:');
  }
});

/* ============================================================================
   POST /api/sync/queue/:queueId/requeue - Reset a FAILED/DEAD_LETTER row
   Admin escape hatch for rows that exhausted their retry budget after the
   underlying cause was fixed.
   ============================================================================ */

router.post('/queue/:queueId/requeue', authenticateToken, requireOpsOrAdmin, async (req, res) => {
  try {
    const queueId = Number(req.params.queueId);
    const reset = await syncQueueService.requeueQueueRow(req.user.businessKey, queueId);
    if (!reset) {
      return res.status(404).json({ success: false, message: 'No retryable row found for that queueId' });
    }
    return res.json({ success: true, message: 'Queue row reset to PENDING' });
  } catch (err) {
    return fail(res, err, 'Failed to requeue row', '[SYNC] requeue error:');
  }
});

module.exports = router;
