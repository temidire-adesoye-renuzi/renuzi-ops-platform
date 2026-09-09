/* ============================================================================
   DATE UTILITIES  (TD-3 fix)
   All business dates must be computed in Africa/Lagos local time, never UTC.
   date_key (YYYYMMDD) drives every fact table, so a UTC-based key would
   shift records to the wrong day for any event between 00:00 and 01:00 WAT.
   ============================================================================ */

const { GEO_REGION } = require('../constants');

/**
 * Format an ISO timestamp (or Date) as a 'YYYY-MM-DD' calendar date in Lagos.
 * Uses Intl with timeZone so no external tz library is needed.
 */
function getLagosDateString(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: GEO_REGION,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d); // en-CA yields YYYY-MM-DD
}

/**
 * TD-3 fix: date_key computed in Africa/Lagos local time.
 * Returns integer YYYYMMDD (e.g. 20260829).
 */
function getDateKey(input = new Date()) {
  const s = getLagosDateString(input);
  if (!s) return null;
  return parseInt(s.replace(/-/g, ''), 10);
}

/**
 * Parse a 'YYYY-MM-DD' date-key string (or YYYYMMDD int) back to a
 * Lagos-local date string, useful for validating query params.
 */
function parseDateKeyParam(value) {
  if (value === undefined || value === null || value === '') return null;
  const m = String(value).match(/^(\d{4})(\d{2})(\d{2})$/) ||
            String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  return isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * TD-16 fix (part 1): verify a date_key exists in dim_date before inserting
 * a fact row. Callers must handle a false result by rejecting the write.
 */
async function assertDateKeyExists(executeQueryFn, dateKey) {
  const result = await executeQueryFn(
    'SELECT 1 AS ok FROM dim_date WHERE date_key = @dateKey',
    { dateKey }
  );
  return result.recordset.length > 0;
}

module.exports = {
  getLagosDateString,
  getDateKey,
  parseDateKeyParam,
  assertDateKeyExists
};
