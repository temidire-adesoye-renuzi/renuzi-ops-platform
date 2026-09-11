/* ============================================================================
   PAGINATION UTILITIES
   Shared cursor-based (keyset) pagination toolkit for list endpoints:

     1. Cursor codec      - opaque, HMAC-signed anchors (tamper-proof)
     2. Validators        - limit + cursor shape constraints
     3. Param parsing     - normalize limit/cursor/after (pageSize alias)
                            from req.query / req.body in one call
     4. Response factory  - the standard page envelope:
                            { success, message, data, count, pagination }

   Cursor format: "<base64url payload>.<HMAC-SHA256 signature>" where the
   payload is JSON { v: 1, id, ts? }: id = the last row's surrogate sort key,
   ts = an optional epoch-ms anchor for (created_at, id) keysets. It is
   signed with JWT_SECRET (same key material as the upload service's signed
   URLs) and compared timing-safely, so a client cannot forge or alter a
   cursor without invalidating the signature. NOTE: cursors are signed, not
   encrypted - never embed secrets or tenant data in a cursor payload.

   Typical route usage:

     const { limit, cursor } = parsePaginationParams(req, { maxLimit: 50 });
     // service SELECTs limit + 1 rows for the keyset after cursor.id
     const rows = await someService.listPage(businessKey, limit, cursor);
     res.json(buildPaginatedResponse({ data: rows, limit, cursorOf: (r) => r.id }));
   ============================================================================ */

const crypto = require('crypto');
const { env } = require('../config/env');
const { HttpError } = require('./httpError');

/* Endpoint defaults; override per call via the opts argument. */
const PAGINATION_DEFAULTS = Object.freeze({
  minLimit: 1,
  defaultLimit: 20,
  maxLimit: 100,
  maxCursorChars: 1024
});

const CURSOR_VERSION = 1;

/* ============================================================================
   1. CURSOR CODEC
   ============================================================================ */

function cursorSignature(body) {
  return crypto.createHmac('sha256', env.jwt.secret).update(body).digest('base64url');
}

function invalidCursor(internal) {
  return new HttpError(400, 'Invalid pagination cursor', internal);
}

/**
 * True when payload is a usable keyset anchor: a non-negative safe-integer
 * id plus an optional non-negative finite ts (epoch ms). Pure check - never
 * throws; used on both the encode (server-side) and decode (client-side)
 * paths.
 *
 * @param {*} payload
 * @returns {boolean}
 */
function isValidCursorPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (!Number.isSafeInteger(payload.id) || payload.id < 0) return false;
  if (payload.ts !== undefined &&
      (typeof payload.ts !== 'number' || !Number.isFinite(payload.ts) || payload.ts < 0)) {
    return false;
  }
  return true;
}

function toCursorPayload(input) {
  const payload = typeof input === 'number' ? { id: input } : input;
  if (!isValidCursorPayload(payload)) {
    throw new TypeError(
      'encodeCursor: payload must be { id: <non-negative safe integer>, ts?: <non-negative number> } or a bare id number'
    );
  }
  return {
    v: CURSOR_VERSION,
    id: payload.id,
    ...(payload.ts !== undefined ? { ts: payload.ts } : {})
  };
}

/**
 * Encode a keyset anchor into an opaque client-facing cursor string.
 *
 * @param {object|number} input { id, ts? } anchor or a bare id number
 * @returns {string} "<base64url payload>.<signature>" token
 * @throws {TypeError} on a malformed anchor (server-side programming error)
 */
function encodeCursor(input) {
  const payload = toCursorPayload(input);
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${cursorSignature(body)}`;
}

/**
 * Decode + signature-verify a client-supplied cursor back into its anchor.
 * Any tampering, structural damage or version drift -> HttpError 400 with a
 * generic public message, so cursor internals never leak through errors.
 *
 * @param {string} token cursor exactly as received from the client
 * @returns {{ id: number, ts?: number }} the keyset anchor
 * @throws {HttpError} 400 when the cursor is invalid
 */
function decodeCursor(token) {
  const raw = token === undefined || token === null ? '' : String(token);
  if (raw === '' || raw.length > PAGINATION_DEFAULTS.maxCursorChars) {
    throw invalidCursor(
      `decodeCursor: ${raw === '' ? 'empty token' : `token length ${raw.length} exceeds ${PAGINATION_DEFAULTS.maxCursorChars}`}`
    );
  }

  const parts = raw.split('.');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw invalidCursor('decodeCursor: malformed token structure');
  }

  const [body, signature] = parts;
  const expected = Buffer.from(cursorSignature(body));
  const received = Buffer.from(signature);
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    throw invalidCursor('decodeCursor: signature mismatch (tampered cursor or rotated secret)');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (err) {
    throw invalidCursor(`decodeCursor: undecodable payload (${err.message})`);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      payload.v !== CURSOR_VERSION || !isValidCursorPayload(payload)) {
    throw invalidCursor(`decodeCursor: unsupported payload (v=${payload && payload.v})`);
  }

  return {
    id: payload.id,
    ...(payload.ts !== undefined ? { ts: payload.ts } : {})
  };
}

/* ============================================================================
   2. VALIDATORS
   ============================================================================ */

/**
 * Validate + normalize a client-supplied page-size value.
 *
 *   absent / empty           -> defaultLimit
 *   integer in [min, max]    -> that integer (numeric strings accepted)
 *   fractional / non-numeric / below minLimit -> HttpError 400
 *   above maxLimit           -> clamped to maxLimit (400 when clampMax:false)
 *
 * @param {*} raw value as received from the client
 * @param {object} [opts] { minLimit, defaultLimit, maxLimit, clampMax }
 * @returns {number} the effective page size
 * @throws {HttpError} 400 on values that cannot be honored
 */
function validateLimit(raw, opts = {}) {
  const {
    minLimit = PAGINATION_DEFAULTS.minLimit,
    defaultLimit = PAGINATION_DEFAULTS.defaultLimit,
    maxLimit = PAGINATION_DEFAULTS.maxLimit,
    clampMax = true
  } = opts;

  if (raw === undefined || raw === null) return defaultLimit;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return defaultLimit;
    if (!/^[+-]?\d+$/.test(trimmed)) {
      throw new HttpError(400, `limit must be an integer between ${minLimit} and ${maxLimit}`);
    }
    raw = parseInt(trimmed, 10);
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < minLimit) {
    throw new HttpError(400, `limit must be an integer between ${minLimit} and ${maxLimit}`);
  }
  if (raw > maxLimit) {
    if (!clampMax) throw new HttpError(400, `limit must be an integer between ${minLimit} and ${maxLimit}`);
    return maxLimit;
  }
  return raw;
}

/* First non-empty of primary/alias, else null. */
function pickParam(primary, alias) {
  if (primary !== undefined && primary !== null && primary !== '') return primary;
  if (alias !== undefined && alias !== null && alias !== '') return alias;
  return null;
}

/**
 * Validate a combined pagination parameter set (already extracted from a
 * request). `after` is a legacy alias for `cursor`; an explicit cursor wins.
 *
 * @param {object} [params] { limit?, cursor?, after? }
 * @param {object} [opts]   forwarded to validateLimit
 * @returns {{ limit: number, cursorRaw: string|null, cursor: {id:number, ts?:number}|null }}
 * @throws {HttpError} 400 on any invalid value
 */
function validatePaginationParams(params, opts = {}) {
  const { limit, cursor, after } = params || {};
  const cursorRaw = pickParam(cursor, after);
  return {
    limit: validateLimit(limit, opts),
    cursorRaw,
    cursor: cursorRaw === null ? null : decodeCursor(cursorRaw)
  };
}

/* ============================================================================
   3. PARAMETER PARSING
   ============================================================================ */

/**
 * Extract + normalize pagination inputs from an Express request in one call.
 *
 * Sources (body params win over query params; primary names win over
 * aliases):
 *   limit | pageSize -> page size (validated, clamped)
 *   cursor | after   -> opaque cursor (decoded + signature-verified)
 *
 * @param {object} req Express request (req.query and/or req.body)
 * @param {object} [opts] forwarded to validatePaginationParams / validateLimit
 * @returns {{ limit: number, cursorRaw: string|null, cursor: {id:number, ts?:number}|null }}
 * @throws {HttpError} 400 on any invalid value
 */
function parsePaginationParams(req, opts = {}) {
  const body = (req && req.body) || {};
  const query = (req && req.query) || {};
  /* Precedence: body over query, primary name over alias. */
  const limit = pickParam(pickParam(body.limit, body.pageSize), pickParam(query.limit, query.pageSize));
  const cursor = pickParam(pickParam(body.cursor, body.after), pickParam(query.cursor, query.after));
  return validatePaginationParams({ limit, cursor }, opts);
}

/* ============================================================================
   4. RESPONSE BUILDER
   ============================================================================ */

/**
 * Factory for the standard paginated list envelope. Implements the
 * over-fetch convention: services SELECT limit + 1 rows and hand the full
 * array here; the extra row only proves has_more and is trimmed before the
 * response is built - one round trip, no COUNT(*) required.
 *
 * @param {object} [args]
 * @param {Array}    [args.data]      page rows (possibly a limit + 1 over-fetch)
 * @param {number}   [args.limit]     page size in effect (enables trimming +
 *                                    has_more derivation when hasMore is absent)
 * @param {boolean}  [args.hasMore]   explicit "more pages exist" flag
 * @param {Function} [args.cursorOf]  (lastRow) => { id, ts? } | <id> anchor
 *                                    extractor used to mint the next cursor
 * @param {string}   [args.nextCursor] pre-encoded cursor (overrides cursorOf)
 * @param {number}   [args.total]     total rows matching the filter, if known
 * @param {string}   [args.message]   human-readable response message
 * @returns {{ success: true, message: string, data: Array, count: number,
 *             pagination: { limit?: number, has_more: boolean,
 *                           next_cursor: string|null, total?: number } }}
 * @throws {TypeError} on server-side misuse (non-array data, undeducible
 *                     hasMore / next cursor, invalid total) - never on client input
 */
function buildPaginatedResponse(args = {}) {
  const { data, limit, hasMore, cursorOf, nextCursor, total, message } = args;

  if (!Array.isArray(data)) {
    throw new TypeError('buildPaginatedResponse: data must be an array of page rows');
  }

  const pageSize = Number.isInteger(limit) && limit > 0 ? limit : null;

  /* Over-fetch trim: never return more than `limit` rows. */
  const rows = pageSize && data.length > pageSize ? data.slice(0, pageSize) : data;

  let more;
  if (hasMore !== undefined) {
    more = Boolean(hasMore);
  } else if (pageSize) {
    more = data.length > pageSize;
  } else {
    throw new TypeError('buildPaginatedResponse: hasMore is required when limit is not supplied');
  }

  let nextCursorValue = null;
  if (more) {
    if (nextCursor !== undefined) {
      if (typeof nextCursor !== 'string' || nextCursor === '') {
        throw new TypeError('buildPaginatedResponse: nextCursor must be a non-empty pre-encoded cursor string');
      }
      nextCursorValue = nextCursor;
    } else if (typeof cursorOf === 'function' && rows.length > 0) {
      nextCursorValue = encodeCursor(cursorOf(rows[rows.length - 1]));
    } else {
      throw new TypeError(
        'buildPaginatedResponse: hasMore is true but no next cursor could be derived - provide cursorOf(row) or nextCursor'
      );
    }
  }

  let totalCount;
  if (total !== undefined && total !== null) {
    totalCount = Number(total);
    if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
      throw new TypeError('buildPaginatedResponse: total must be a non-negative integer count');
    }
  }

  return {
    success: true,
    message: message || `${rows.length} item(s) returned${more ? ' (more pages pending)' : ''}`,
    data: rows,
    count: rows.length,
    pagination: {
      ...(pageSize ? { limit: pageSize } : {}),
      has_more: more,
      next_cursor: nextCursorValue,
      ...(totalCount !== undefined ? { total: totalCount } : {})
    }
  };
}

module.exports = {
  PAGINATION_DEFAULTS,
  encodeCursor,
  decodeCursor,
  isValidCursorPayload,
  validateLimit,
  validatePaginationParams,
  parsePaginationParams,
  buildPaginatedResponse
};
