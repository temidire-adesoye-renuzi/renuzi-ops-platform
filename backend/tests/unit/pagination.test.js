/* ============================================================================
   UNIT: pagination utilities (cursor codec, validators, parsing, responses)
   ============================================================================ */

const {
  PAGINATION_DEFAULTS,
  encodeCursor,
  decodeCursor,
  validateLimit,
  validatePaginationParams,
  parsePaginationParams,
  buildPaginatedResponse
} = require('../../src/utils/pagination');
const { HttpError } = require('../../src/utils/httpError');

const REQ = (query = {}, body = {}) => ({ query, body });

describe('cursor codec', () => {
  test('round-trips a bare id anchor', () => {
    const token = encodeCursor(88101);
    expect(decodeCursor(token)).toEqual({ id: 88101 });
  });

  test('round-trips { id, ts } and omits absent ts', () => {
    const token = encodeCursor({ id: 42, ts: 1757500000000 });
    expect(decodeCursor(token)).toEqual({ id: 42, ts: 1757500000000 });
    expect(decodeCursor(encodeCursor({ id: 7 }))).toEqual({ id: 7 });
  });

  test('cursor is opaque (no plaintext anchor)', () => {
    const token = encodeCursor({ id: 123 });
    expect(token).not.toContain('123');
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  test('rejects a tampered payload with 400 and a generic message', () => {
    const token = encodeCursor({ id: 5 });
    const [body] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ v: 1, id: 999 })).toString('base64url');
    const tampered = `${forged}.${token.split('.')[1]}`;
    expect(token).not.toBe(tampered);
    expect(() => decodeCursor(tampered)).toThrow(HttpError);
    try {
      decodeCursor(tampered);
    } catch (err) {
      expect(err.status).toBe(400);
      expect(err.publicMessage).not.toContain('999');
    }
    expect(body.length).toBeGreaterThan(0); // sanity for the split above
  });

  test('rejects garbage, empty, oversized and structurally-broken tokens', () => {
    for (const bad of ['', null, undefined, 'garbage', 'a.b.c', '.sig', 'body.']) {
      expect(() => decodeCursor(bad)).toThrow(HttpError);
    }
    expect(() => decodeCursor(`${'x'.repeat(PAGINATION_DEFAULTS.maxCursorChars + 1)}.sig`)).toThrow(HttpError);
  });

  test('rejects a valid-looking token signed with a different secret', () => {
    const crypto = require('crypto');
    const body = Buffer.from(JSON.stringify({ v: 1, id: 1 })).toString('base64url');
    const foreign = crypto.createHmac('sha256', 'not-the-real-secret').update(body).digest('base64url');
    expect(() => decodeCursor(`${body}.${foreign}`)).toThrow(HttpError);
  });

  test('rejects a wrong-version payload even with a valid signature', () => {
    const crypto = require('crypto');
    const body = Buffer.from(JSON.stringify({ v: 99, id: 1 })).toString('base64url');
    const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(body).digest('base64url');
    expect(() => decodeCursor(`${body}.${sig}`)).toThrow(HttpError);
  });

  test('encodeCursor throws TypeError on malformed server-side anchors', () => {
    for (const bad of [{ id: -1 }, { id: 1.5 }, { id: 'x' }, { id: 1, ts: -5 }, null, {}]) {
      expect(() => encodeCursor(bad)).toThrow(TypeError);
    }
  });
});

describe('validateLimit', () => {
  test('defaults when absent or empty', () => {
    expect(validateLimit(undefined)).toBe(PAGINATION_DEFAULTS.defaultLimit);
    expect(validateLimit(null)).toBe(PAGINATION_DEFAULTS.defaultLimit);
    expect(validateLimit('')).toBe(PAGINATION_DEFAULTS.defaultLimit);
    expect(validateLimit('   ')).toBe(PAGINATION_DEFAULTS.defaultLimit);
  });

  test('accepts integers and numeric strings', () => {
    expect(validateLimit(25)).toBe(25);
    expect(validateLimit('25')).toBe(25);
    expect(validateLimit(' 25 ')).toBe(25);
  });

  test('rejects fractional, non-numeric, NaN and below-min values', () => {
    for (const bad of [0, -5, 1.5, 'abc', '12.5', NaN, Infinity, '1e3']) {
      expect(() => validateLimit(bad)).toThrow(HttpError);
    }
  });

  test('clamps above max by default, rejects when clampMax is false', () => {
    expect(validateLimit(5000)).toBe(PAGINATION_DEFAULTS.maxLimit);
    expect(() => validateLimit(5000, { clampMax: false })).toThrow(HttpError);
    expect(() => validateLimit(5000, { clampMax: false, maxLimit: 10 })).toThrow(HttpError);
    expect(validateLimit(5000, { maxLimit: 10 })).toBe(10);
  });

  test('honors custom min/default/max', () => {
    const opts = { minLimit: 5, defaultLimit: 7, maxLimit: 9 };
    expect(validateLimit(undefined, opts)).toBe(7);
    expect(validateLimit(5, opts)).toBe(5);
    expect(validateLimit(9, opts)).toBe(9);
    expect(() => validateLimit(4, opts)).toThrow(HttpError);
    expect(validateLimit(99, opts)).toBe(9);
  });
});

describe('validatePaginationParams', () => {
  test('empty params give defaults with no cursor', () => {
    expect(validatePaginationParams({})).toEqual({
      limit: PAGINATION_DEFAULTS.defaultLimit,
      cursorRaw: null,
      cursor: null
    });
  });

  test('decodes a provided cursor; explicit cursor wins over after alias', () => {
    const token = encodeCursor({ id: 10, ts: 20 });
    const result = validatePaginationParams({ cursor: token, after: encodeCursor(999) });
    expect(result.cursor).toEqual({ id: 10, ts: 20 });
    expect(result.cursorRaw).toBe(token);
  });

  test('after is accepted as a legacy cursor alias', () => {
    const result = validatePaginationParams({ after: encodeCursor(3) });
    expect(result.cursor).toEqual({ id: 3 });
  });

  test('invalid cursor -> 400 HttpError', () => {
    expect(() => validatePaginationParams({ cursor: 'tampered.???' })).toThrow(HttpError);
  });
});

describe('parsePaginationParams', () => {
  test('reads limit and cursor from query', () => {
    const token = encodeCursor(77);
    const p = parsePaginationParams(REQ({ limit: '5', cursor: token }));
    expect(p).toEqual({ limit: 5, cursorRaw: token, cursor: { id: 77 } });
  });

  test('body wins over query; pageSize is a limit alias', () => {
    const token = encodeCursor(2);
    const p = parsePaginationParams(REQ({ limit: '5', cursor: 'zzz' }, { pageSize: 9, cursor: token }));
    expect(p.limit).toBe(9);
    expect(p.cursorRaw).toBe(token);
    expect(p.cursor).toEqual({ id: 2 });
  });

  test('after is accepted from query', () => {
    const token = encodeCursor(4);
    expect(parsePaginationParams(REQ({ after: token })).cursor).toEqual({ id: 4 });
  });

  test('handles missing req parts and non-Express input gracefully', () => {
    expect(parsePaginationParams({}).cursor).toBeNull();
    expect(parsePaginationParams(null).limit).toBe(PAGINATION_DEFAULTS.defaultLimit);
  });

  test('propagates 400 for a bad limit', () => {
    expect(() => parsePaginationParams(REQ({ limit: 'oops' }))).toThrow(HttpError);
  });
});

describe('buildPaginatedResponse', () => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];

  test('derives has_more from an over-fetch and trims the extra row', () => {
    const over = [...rows, { id: 4 }];
    const resp = buildPaginatedResponse({ data: over, limit: 3, cursorOf: (r) => r.id });
    expect(resp.data).toHaveLength(3);
    expect(resp.count).toBe(3);
    expect(resp.pagination.has_more).toBe(true);
    expect(resp.pagination.next_cursor).toBe(encodeCursor(3));
    expect(resp.pagination.limit).toBe(3);
    expect(resp.success).toBe(true);
    expect(typeof resp.message).toBe('string');
  });

  test('no more pages -> next_cursor null', () => {
    const resp = buildPaginatedResponse({ data: rows, limit: 10, cursorOf: (r) => r.id });
    expect(resp.pagination.has_more).toBe(false);
    expect(resp.pagination.next_cursor).toBeNull();
  });

  test('explicit hasMore overrides row-count inference', () => {
    const resp = buildPaginatedResponse({ data: rows, hasMore: false });
    expect(resp.pagination.has_more).toBe(false);
    expect(resp.pagination).not.toHaveProperty('limit');
    expect(resp.data).toHaveLength(3);
  });

  test('mint cursor from ts anchor; pre-encoded nextCursor overrides', () => {
    const resp = buildPaginatedResponse({
      data: rows, limit: 2, cursorOf: (r) => ({ id: r.id, ts: r.id * 1000 })
    });
    // cursor anchors on the last RETURNED row (id 2), not the trimmed over-fetch
    expect(resp.pagination.next_cursor).toBe(encodeCursor({ id: 2, ts: 2000 }));

    const pre = buildPaginatedResponse({
      data: rows, limit: 2, hasMore: true, nextCursor: encodeCursor(99)
    });
    expect(pre.pagination.next_cursor).toBe(encodeCursor(99));
  });

  test('includes total when supplied and omits it otherwise', () => {
    const withTotal = buildPaginatedResponse({ data: rows, hasMore: false, total: 150 });
    expect(withTotal.pagination.total).toBe(150);
    const without = buildPaginatedResponse({ data: rows, hasMore: false });
    expect(without.pagination).not.toHaveProperty('total');
  });

  test('accepts a custom message', () => {
    const resp = buildPaginatedResponse({ data: [], hasMore: false, message: 'No vehicles found' });
    expect(resp.message).toBe('No vehicles found');
    expect(resp.data).toEqual([]);
    expect(resp.count).toBe(0);
  });

  test('throws TypeError on server-side misuse, never HttpError', () => {
    expect(() => buildPaginatedResponse({ data: {} })).toThrow(TypeError);
    expect(() => buildPaginatedResponse({ data: rows })).toThrow(TypeError); // no limit, no hasMore
    expect(() => buildPaginatedResponse({ data: rows, limit: 2, cursorOf: null })).toThrow(TypeError);
    expect(() => buildPaginatedResponse({ data: [], limit: 2, hasMore: true })).toThrow(TypeError);
    expect(() => buildPaginatedResponse({ data: rows, hasMore: false, total: -1 })).toThrow(TypeError);
    expect(() => buildPaginatedResponse({ data: rows, hasMore: true, nextCursor: '' })).toThrow(TypeError);
  });
});
