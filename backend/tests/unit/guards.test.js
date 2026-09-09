/* ============================================================================
   UNIT: GRN receipt-status derivation + odometer/processor registry wiring
   These are the pure pieces of the service layer - verifying them without
   a database locks the shared business rules for both online + offline paths.
   ============================================================================ */

const { deriveReceiptStatus } = require('../../src/services/guards');
const { getProcessor, REGISTRY } = require('../../src/sync/processorRegistry');
const { SYNC_ENTITY_TYPES } = require('../../src/constants');

describe('deriveReceiptStatus (single source of truth)', () => {
  test('complete when received + rejected covers invoice', () => {
    expect(deriveReceiptStatus({
      totalInvoiceQty: 100, totalReceivedQty: 90, totalRejectedQty: 10
    })).toBe('COMPLETE');
  });

  test('partial when short', () => {
    expect(deriveReceiptStatus({
      totalInvoiceQty: 100, totalReceivedQty: 50, totalRejectedQty: 10
    })).toBe('PARTIAL');
  });

  test('rejected when nothing received', () => {
    expect(deriveReceiptStatus({
      totalInvoiceQty: 100, totalReceivedQty: 0, totalRejectedQty: 100
    })).toBe('REJECTED');
  });

  test('derives from lines when totals absent', () => {
    expect(deriveReceiptStatus({
      lines: [
        { invoiceQty: 50, receivedQty: 50, rejectedQty: 0 },
        { invoiceQty: 50, receivedQty: 40, rejectedQty: 0 }
      ]
    })).toBe('PARTIAL');
  });
});

describe('processor registry (Objective 1a)', () => {
  test('registers every entity type the batch route accepts', () => {
    for (const t of SYNC_ENTITY_TYPES) {
      expect(typeof REGISTRY[t]).toBe('function');
    }
  });

  test('the five warehouse processors are present', () => {
    ['GRN', 'DISPATCH_ACK', 'STOCK_COUNT', 'STOCK_MOVEMENT', 'GOODS_RETURN']
      .forEach((t) => expect(getProcessor(t)).toBe(REGISTRY[t]));
  });

  test('returns null for unknown types', () => {
    expect(getProcessor('NOT_A_REAL_TYPE')).toBeNull();
  });
});
