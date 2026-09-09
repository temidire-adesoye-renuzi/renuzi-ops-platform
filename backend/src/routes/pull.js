/* ============================================================================
   PULL API ROUTES   All endpoints prefixed with /api/pull
   The download-side mirror of routes/sync.js. THIN HTTP ADAPTER only -
   all mechanics live in services/syncPullService.js and
   services/changeLogService.js.

      GET  /api/pull/meta?datasets=ROUTES,CUSTOMERS   - cheap reconnect probe
      POST /api/pull                                   - paged delta pull
           body: { cursor: { ROUTES: 88101, ... }, pageSize?, datasets?,
                   snapshotAfterKey?: { ROUTES: 1205, ... } }
           resp: { changes, nextCursor, hasMore, snapshotAfterKey?, resetRequired? }

    Reconnect choreography (client contract): drain the push queue first
    (POST /api/sync/batch), probe /pull/meta, page /pull until hasMore=false,
    apply each page locally with the version guard, honoring tombstones.

    Snapshot paging (cursor 0 with hasMore=true): while a dataset's snapshot
    still has pages, the response carries snapshotAfterKey: { DATASET: key },
    the last entityKey of that page. Echo it back unchanged on the next POST
    /api/pull (with cursor still 0) to resume the keyset scan where the last
    page ended - the same pass-back contract as nextCursor for delta pages.
   ============================================================================ */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { requireAny } = require('../middleware/roleCheck');
const { HttpError } = require('../utils/httpError');
const { PULL_DATASETS } = require('../constants');
const syncPullService = require('../services/syncPullService');

function fail(res, err, fallback, internal) {
  console.error(internal || fallback, err.message);
  return res.status(500).json({ success: false, message: fallback });
}

/* ============================================================================
   GET /api/pull/meta - Cheap "is anything pending" probe
   ============================================================================ */

router.get('/meta', authenticateToken, requireAny, async (req, res) => {
  try {
    const data = await syncPullService.getPullMeta(
      req.user.businessKey,
      req.query.datasets
    );
    return res.json({ success: true, data });
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ success: false, message: err.publicMessage });
    }
    return fail(res, err, 'Failed to fetch pull metadata', '[PULL] meta error:');
  }
});

/* ============================================================================
   POST /api/pull - Paged delta pull (cursor-based, resumable)
   ============================================================================ */

router.post('/', authenticateToken, requireAny, async (req, res) => {
  try {
    const { cursor, pageSize, datasets, snapshotAfterKey } = req.body || {};

    if (cursor !== undefined && cursor !== null && typeof cursor !== 'object') {
      return res.status(400).json({
        success: false,
        message: 'cursor must be an object like { ROUTES: 123, CUSTOMERS: 456 } (use 0 for a full snapshot)'
      });
    }

    if (snapshotAfterKey !== undefined && snapshotAfterKey !== null) {
      if (typeof snapshotAfterKey !== 'object' || Array.isArray(snapshotAfterKey)) {
        return res.status(400).json({
          success: false,
          message: 'snapshotAfterKey must be an object like { ROUTES: 1205 } - the snapshotAfterKey value returned by the previous page'
        });
      }
      for (const dataset of Object.keys(snapshotAfterKey)) {
        if (!PULL_DATASETS[dataset]) {
          return res.status(400).json({
            success: false,
            message: `Unknown dataset ${dataset} in snapshotAfterKey. Valid: ${Object.keys(PULL_DATASETS).join(', ')}`
          });
        }
        const key = Number(snapshotAfterKey[dataset]);
        if (!Number.isFinite(key) || key < 0) {
          return res.status(400).json({
            success: false,
            message: `snapshotAfterKey.${dataset} must be a non-negative number (the entityKey of the last row of the previous snapshot page)`
          });
        }
      }
    }

    const data = await syncPullService.pullChanges(
      req.user.businessKey,
      cursor || {},
      { pageSize, datasets, snapshotAfterKey: snapshotAfterKey || {} }
    );

    const message = data.resetRequired
      ? `Cursor stale for: ${data.resetRequired.join(', ')}. Re-bootstrap those datasets with cursor 0.`
      : `Pulled ${data.changes.length} change(s)${data.hasMore ? ' (more pages pending)' : ''}`;

    return res.json({
      success: true,
      message,
      data: {
        changes: data.changes,
        nextCursor: data.nextCursor,
        hasMore: data.hasMore,
        ...(data.snapshotAfterKey ? { snapshotAfterKey: data.snapshotAfterKey } : {}),
        ...(data.resetRequired ? { resetRequired: data.resetRequired } : {})
      }
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ success: false, message: err.publicMessage });
    }
    return fail(res, err, 'Failed to pull changes', '[PULL] pull error:');
  }
});

module.exports = router;
