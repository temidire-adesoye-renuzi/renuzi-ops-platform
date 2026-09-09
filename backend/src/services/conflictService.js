/* ============================================================================
   CONFLICT RESOLUTION SERVICE (Objective 3 - loop closure)

   The legacy flow had a fatal gap: resolving a conflict only updated the
   sync_conflict_log row (resolution = SERVER_WINS etc.) - the WINNING
   version was never re-applied to the fact tables, and the parked sync_queue
   row stayed CONFLICT forever. The "loop" never closed: data was decided
   but never written.

   This service closes the loop atomically:
     1. Load conflict + parked queue row (with resolved version guards).
     2. Re-apply the WINNING version:
          SERVER_WINS -> nothing to write (server state already stands);
                         mark queue row SYNCED-superseded.
          CLIENT_WINS -> re-run the SAME processor that detected the
                         conflict, this time with conflictOverride=true so
                         the conflicting guard is bypassed deliberately
                         (e.g. odometer regression accepted as truth).
          MERGED      -> apply the client payload PATCHES carried in
                         mergedPayload, then the queue row is synced.
     3. Update conflict log + queue row status IN ONE TRANSACTION so a crash
        between them cannot produce a resolved-but-still-parked state.

   If re-application fails, the conflict stays PENDING and the error is
   reported to the resolver - never silently lost.
   ============================================================================ */

const { executeQuery, withTransaction } = require('../config/db');
const { CONFLICT_RESOLUTION, SYNC_STATUS } = require('../constants');
const { HttpError } = require('../utils/httpError');
const { SyncConflictError } = require('../utils/syncError');
const { getProcessor } = require('../sync/processorRegistry');

/**
 * List unresolved conflicts for a business (route: GET /api/sync/conflicts).
 * Exposes BOTH versions so the mobile app / web UI can render a side-by-side
 * reconciliation screen.
 */
async function listPendingConflicts(businessKey) {
  const result = await executeQuery(
    `SELECT c.conflict_key, c.queue_id, c.entity_type, c.entity_key,
            c.server_version_json, c.client_version_json,
            c.resolution, c.created_at,
            q.device_id, q.retry_count, q.created_at AS queued_at
       FROM sync_conflict_log c
       JOIN sync_queue q ON c.queue_id = q.queue_id
      WHERE q.business_key = @businessKey AND c.resolution = 'PENDING'
      ORDER BY c.created_at DESC`,
    { businessKey }
  );
  return result.recordset;
}

/**
 * Resolve a conflict and CLOSE THE LOOP by re-applying the winner.
 *
 * @param {object} actor      { userKey, businessKey }
 * @param {number} conflictKey
 * @param {string} resolution 'SERVER_WINS' | 'CLIENT_WINS' | 'MERGED'
 * @param {object} [mergedPayload] required for MERGED: the merged payload to apply
 * @param {string} [resolutionNotes]
 * @returns {{ conflictKey:number, resolution:string, applied:'SERVER_KEPT'|'CLIENT_APPLIED'|'MERGE_APPLIED', entityKey:number|null }}
 */
async function resolveConflict(actor, conflictKey, resolution, mergedPayload, resolutionNotes) {
  if (![CONFLICT_RESOLUTION.SERVER_WINS, CONFLICT_RESOLUTION.CLIENT_WINS, CONFLICT_RESOLUTION.MERGED].includes(resolution)) {
    throw new HttpError(400, 'resolution must be SERVER_WINS, CLIENT_WINS or MERGED');
  }
  if (resolution === CONFLICT_RESOLUTION.MERGED && !mergedPayload) {
    throw new HttpError(400, 'mergedPayload is required for MERGED resolution');
  }

  const found = await executeQuery(
    `SELECT c.conflict_key, c.queue_id, c.entity_type, c.resolution AS current_resolution,
            q.entity_type AS queue_entity_type, q.user_key, q.device_id, q.sync_status
       FROM sync_conflict_log c
       JOIN sync_queue q ON c.queue_id = q.queue_id
      WHERE c.conflict_key = @conflictKey AND q.business_key = @businessKey`,
    { conflictKey, businessKey: actor.businessKey }
  );
  if (found.recordset.length === 0) throw new HttpError(404, 'Conflict not found');
  const conflict = found.recordset[0];

  if (conflict.current_resolution !== 'PENDING') {
    throw new HttpError(409, `Conflict already resolved as ${conflict.current_resolution}`);
  }

  /* --- SERVER_WINS: the server fact state is already the truth; the
         parked client payload is discarded. We still must transition the
         queue row out of CONFLICT so it stops appearing in the loop. --- */
  if (resolution === CONFLICT_RESOLUTION.SERVER_WINS) {
    await finalizeResolution(conflict, resolution, actor, {
      queueStatus: SYNC_STATUS.SYNCED,
      entityKey: null
    });
    return { conflictKey, resolution, applied: 'SERVER_KEPT', entityKey: null };
  }

  /* --- CLIENT_WINS / MERGED: re-apply the winning client version through
         the SAME processor, with conflictOverride so the guard that
         originally detected the conflict deliberately yields. --- */
  const queueRow = await executeQuery(
    'SELECT payload_json FROM sync_queue WHERE queue_id = @queueId',
    { queueId: conflict.queue_id }
  );
  const clientPayload = JSON.parse(queueRow.recordset[0].payload_json);
  const payloadToApply = resolution === CONFLICT_RESOLUTION.MERGED
    ? { ...clientPayload, ...mergedPayload }
    : clientPayload;

  const processor = getProcessor(conflict.entity_type);
  if (!processor) {
    throw new HttpError(500, `No processor available to re-apply entity type ${conflict.entity_type}`);
  }

  let entityKey = null;
  try {
    entityKey = await processor(
      {
        userKey: conflict.user_key,
        businessKey: actor.businessKey,
        deviceId: conflict.device_id,
        conflictOverride: true // deliberate: accept the client version over the guard
      },
      payloadToApply
    );
  } catch (err) {
    if (err instanceof SyncConflictError) {
      // A merge that still violates a hard invariant must not be forced.
      throw new HttpError(409, `Cannot apply resolved version: ${err.message}`);
    }
    throw err;
  }

  await finalizeResolution(conflict, resolution, actor, {
    queueStatus: SYNC_STATUS.SYNCED,
    entityKey
  });

  return {
    conflictKey,
    resolution,
    applied: resolution === CONFLICT_RESOLUTION.MERGED ? 'MERGE_APPLIED' : 'CLIENT_APPLIED',
    entityKey
  };
}

/**
 * Persist the resolution + queue transition atomically.
 */
async function finalizeResolution(conflict, resolution, actor, { queueStatus, entityKey }) {
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE sync_conflict_log SET
         resolution = @resolution,
         resolved_by_key = @resolvedByKey,
         resolved_at = GETDATE(),
         resolution_notes = @resolutionNotes
       WHERE conflict_key = @conflictKey AND resolution = 'PENDING'`,
      {
        resolution,
        resolvedByKey: actor.userKey,
        resolutionNotes: resolutionNotes || null,
        conflictKey: conflict.conflict_key
      }
    );
    await tx.query(
      `UPDATE sync_queue SET
         sync_status = @queueStatus,
         processed_at = GETDATE(),
         entity_key = COALESCE(@entityKey, entity_key)
       WHERE queue_id = @queueId`,
      { queueStatus, entityKey, queueId: conflict.queue_id }
    );
  });
}

module.exports = { listPendingConflicts, resolveConflict };
