/* ============================================================================
   ASYNC ROUTE HANDLER WRAPPER
   Forwards rejected promises from async route handlers to the global error
   handler in app.js. Without this, an async throw crashes the request with
   an unhandled rejection instead of producing a clean 500.

   Routes keep their try/catch ONLY where they translate service errors into
   specific status codes; generic wrapping lives here.
   ============================================================================ */

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
