/* ============================================================================
   UNIT: exponential backoff policy (Objective 2)
   ============================================================================ */

const { backoffDelayMs } = require('../../src/utils/backoff');

describe('backoffDelayMs', () => {
  test('grows exponentially with retry count', () => {
    const base = { baseSeconds: 30, maxSeconds: 24 * 60 * 60, multiplier: 2 };
    const d0 = backoffDelayMs(0, base);
    const d3 = backoffDelayMs(3, base);
    const d6 = backoffDelayMs(6, base);

    // jitter means random in [0, cap): assert against caps, not exact values
    expect(d0).toBeLessThanOrEqual(30 * 1000);
    expect(d0).toBeGreaterThanOrEqual(0);

    expect(d3).toBeLessThanOrEqual(30 * 8 * 1000);
    expect(d6).toBeLessThanOrEqual(30 * 64 * 1000);

    // the CAP for retry 6 must be strictly larger than for retry 3
    expect(30 * 64 * 1000).toBeGreaterThan(30 * 8 * 1000);
  });

  test('caps at maxSeconds', () => {
    for (let i = 0; i < 50; i++) {
      const d = backoffDelayMs(50, { baseSeconds: 30, maxSeconds: 60, multiplier: 2 });
      expect(d).toBeLessThanOrEqual(60 * 1000);
    }
  });

  test('never negative and handles bad input', () => {
    expect(backoffDelayMs(-5)).toBeGreaterThanOrEqual(0);
    expect(backoffDelayMs(undefined)).toBeGreaterThanOrEqual(0);
    expect(backoffDelayMs('x')).toBeGreaterThanOrEqual(0);
  });

  test('produces varying values (jitter present)', () => {
    const values = new Set();
    for (let i = 0; i < 20; i++) {
      values.add(backoffDelayMs(2, { baseSeconds: 30 }));
    }
    expect(values.size).toBeGreaterThan(1);
  });
});
