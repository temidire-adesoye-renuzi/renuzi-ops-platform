/* ============================================================================
   EXPONENTIAL BACKOFF POLICY (Objective 2)
   Shared by the sync queue retry scheduling and any future job that must
   retry transient failures without hammering the database.

   delay(retryCount) = base * 2^retryCount, capped at max, with full jitter
   (random between 0 and the computed value) so that a fleet of devices or
   multiple instances that failed together do not retry in perfect lockstep.
   ============================================================================ */

const DEFAULT_BASE_SECONDS = 30;
const DEFAULT_MAX_SECONDS = 24 * 60 * 60; // 24h ceiling
const DEFAULT_MULTIPLIER = 2;

/**
 * Compute the backoff delay in milliseconds for the NEXT retry attempt.
 *
 * @param {number} retryCount - retries already attempted (0-based: the delay
 *   before the FIRST retry is computed with retryCount=0).
 * @param {object} [opts]
 * @param {number} [opts.baseSeconds]  - base delay in seconds
 * @param {number} [opts.maxSeconds]   - upper bound in seconds
 * @param {number} [opts.multiplier]   - growth factor (classic exponential = 2)
 * @returns {number} milliseconds to wait (>= 0)
 */
function backoffDelayMs(retryCount, opts = {}) {
  const base = Number.isFinite(opts.baseSeconds) ? opts.baseSeconds : DEFAULT_BASE_SECONDS;
  const max = Number.isFinite(opts.maxSeconds) ? opts.maxSeconds : DEFAULT_MAX_SECONDS;
  const multiplier = Number.isFinite(opts.multiplier) ? opts.multiplier : DEFAULT_MULTIPLIER;

  const parsed = Number(retryCount);
  const n = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  const raw = base * Math.pow(multiplier, n);
  const capped = Math.min(raw, max);
  const withJitter = Math.random() * capped;

  return Math.max(0, Math.round(withJitter * 1000));
}

/**
 * Convert a backoff delay (ms) into a SQL DATETIME2 next_retry_at value.
 * Returns a JS Date that can be bound directly to a datetime2 parameter.
 */
function nextRetryAtFromDelay(delayMs) {
  return new Date(Date.now() + delayMs);
}

module.exports = { backoffDelayMs, nextRetryAtFromDelay, DEFAULT_BASE_SECONDS };
