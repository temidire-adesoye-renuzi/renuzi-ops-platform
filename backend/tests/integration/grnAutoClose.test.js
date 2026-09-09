/* ============================================================================
   INTEGRATION: GRN auto-close escalation job (Objective 4d)
   Verifies:
   - GRNs inside the signoff window are untouched
   - GRNs past GRN_AUTO_CLOSE_HOURS without finance signoff are escalated
   - signed-off GRNs are never escalated
   ============================================================================ */

const db = require('../helpers/dbTestHelper');
const { clearRotationFlags } = require('../helpers/apiClient');
const { executeQuery } = require('../../src/config/db');
const { runGRNAutoClose } = require('../../src/jobs/grnAutoCloseJob');

beforeAll(async () => {
  await db.migrate();
  await clearRotationFlags();
});

beforeEach(async () => {
  await db.cleanOperationalData();
  await executeQuery("UPDATE app_config SET config_value = '24' WHERE config_name = 'GRN_AUTO_CLOSE_HOURS'");
});

afterAll(async () => {
  await db.close();
});

async function seedGRN({ invoiceNumber, createdHoursAgo, signedOff }) {
  const dateKey = 20260101;
  const existingDate = await executeQuery('SELECT 1 AS ok FROM dim_date WHERE date_key = @d', { d: dateKey });
  if (existingDate.recordset.length === 0) {
    await executeQuery(
      `INSERT INTO dim_date (date_key, full_date, calendar_year, calendar_quarter, calendar_month,
         month_name, month_name_short, week_of_year, day_of_week, day_name, day_name_short, is_weekend)
       VALUES (@d, '2026-01-01', 2026, 1, 1, 'January', 'Jan', 1, 4, 'Thursday', 'Thu', 0)`,
      { d: dateKey }
    );
  }

  const inserted = await executeQuery(
    `INSERT INTO fact_grn (
       business_key, received_by_key, date_key, grn_number,
       invoice_number, receipt_status, created_at, finance_signoff
     ) OUTPUT INSERTED.grn_key
     VALUES (
       1, 1, @dateKey, @grnNumber,
       @invoiceNumber, 'COMPLETE', DATEADD(HOUR, -@hoursAgo, GETDATE()), @signedOff
     )`,
    {
      dateKey,
      grnNumber: `GRN-AUTO-${invoiceNumber}`,
      invoiceNumber,
      hoursAgo: createdHoursAgo,
      signedOff: signedOff ? 1 : 0
    }
  );
  return inserted.recordset[0].grn_key;
}

describe('GRN auto-close escalation job', () => {
  test('escalates only unsigned GRNs past the window', async () => {
    const freshKey = await seedGRN({ invoiceNumber: 'INV-FRESH', createdHoursAgo: 2, signedOff: false });
    const staleKey = await seedGRN({ invoiceNumber: 'INV-STALE', createdHoursAgo: 30, signedOff: false });
    const staleSignedKey = await seedGRN({ invoiceNumber: 'INV-SIGNED', createdHoursAgo: 30, signedOff: true });

    const { escalated, grnKeys } = await runGRNAutoClose(1);

    expect(escalated).toBe(1);
    expect(grnKeys).toContain(staleKey);
    expect(grnKeys).not.toContain(freshKey);
    expect(grnKeys).not.toContain(staleSignedKey);
  });

  test('respects a changed GRN_AUTO_CLOSE_HOURS config', async () => {
    await executeQuery("UPDATE app_config SET config_value = '1' WHERE config_name = 'GRN_AUTO_CLOSE_HOURS'");

    const twoHoursOld = await seedGRN({ invoiceNumber: 'INV-2H', createdHoursAgo: 2, signedOff: false });
    const { grnKeys } = await runGRNAutoClose(1);
    expect(grnKeys).toContain(twoHoursOld);
  });

  test('escalation is idempotent (re-running reports the same standing set)', async () => {
    await seedGRN({ invoiceNumber: 'INV-IDEM', createdHoursAgo: 30, signedOff: false });

    const first = await runGRNAutoClose(1);
    const second = await runGRNAutoClose(1);
    expect(first.grnKeys).toEqual(second.grnKeys);
  });
});
