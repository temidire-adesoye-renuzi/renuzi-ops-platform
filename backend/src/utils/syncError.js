/* ============================================================================
   SYNC-SPECIFIC ERROR TYPES
   Processors throw these; the queue runner interprets them:

   - SyncConflictError: the payload collides with newer server truth
     (odometer regression, active-trip collision, already-ended trip...).
     The queue row is parked as CONFLICT and a sync_conflict_log row is
     written with BOTH versions so a manager can resolve it.
     These are NEVER retried automatically: retrying cannot fix a genuine
     data conflict, only a human decision can.

   - SyncRetryableError: a transient failure (deadlock victim, timeout,
     guard condition that may clear). The queue row goes back to retryable
     FAILED with a backoff-scheduled next_retry_at.
   ============================================================================ */

class SyncConflictError extends Error {
  /**
   * @param {string} message
   * @param {object|null} serverVersion - current server state snapshot
   * @param {object|null} [extra]       - extra detail merged into the log row
   */
  constructor(message, serverVersion = null, extra = {}) {
    super(message);
    this.name = 'SyncConflictError';
    this.code = 'SYNC_CONFLICT';
    this.serverVersion = serverVersion;
    this.extra = extra;
    Error.captureStackTrace?.(this, SyncConflictError);
  }
}

class SyncRetryableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SyncRetryableError';
    this.code = 'SYNC_RETRYABLE';
    Error.captureStackTrace?.(this, SyncRetryableError);
  }
}

/** True when an error represents a sync conflict (never auto-retried). */
function isSyncConflict(err) {
  return Boolean(err) && err.code === 'SYNC_CONFLICT';
}

module.exports = { SyncConflictError, SyncRetryableError, isSyncConflict };
