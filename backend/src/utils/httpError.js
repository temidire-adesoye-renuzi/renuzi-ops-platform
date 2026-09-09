/* ============================================================================
   HTTP ERROR HELPER  (TD-5 fix)
   Route handlers throw HttpError with a safe public message; the global
   error handler in server.js logs the real error server-side and never
   leaks err.message / err.stack to clients in production.
   ============================================================================ */

class HttpError extends Error {
  /**
   * @param {number} status - HTTP status code (4xx/5xx)
   * @param {string} publicMessage - Safe message shown to the client
   * @param {string} [internalDetail] - Extra context for server logs only
   */
  constructor(status, publicMessage, internalDetail) {
    super(publicMessage);
    this.name = 'HttpError';
    this.status = status;
    this.publicMessage = publicMessage;
    this.internalDetail = internalDetail;
    Error.captureStackTrace?.(this, HttpError);
  }
}

module.exports = { HttpError };
