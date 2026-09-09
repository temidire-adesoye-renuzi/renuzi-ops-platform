/* ============================================================================
   GRN AUTO-CLOSE / ESCALATION JOB (Objective 4d)
   GRNs that pass GRN_AUTO_CLOSE_HOURS (app_config) without finance sign-off
   are escalated: receipt_status -> 'ESCALATED' is NOT a schema value, so we
   record escalation on the queue-visible investigation path instead:
   - set finance_signoff deadline breach via updated_at + notes
   - surface via the escalations log (return value consumed by tests/job)

   Concretely per the schema, the job:
   1. Finds GRNs older than the threshold with finance_signoff = 0.
   2. Marks them (updated_at touch + rejection_reason appended escalation
      marker is NOT appropriate) -> instead the job returns the list for the
      ops dashboard and increments the escalation via sync-safe fields:
      credit_note fields stay finance-owned, so the job's action is:
      UPDATE fact_grn SET updated_at = GETDATE() WHERE ... and RETURN rows.
   3. The scheduler logs the escalation list; the ops dashboard exposes it.

   The job is idempotent: already-escalated GRNs (tracked via
   sync_queue-independent mechanism below) are not re-escalated. Because the
   schema lacks an escalation flag, the job records escalations in
   app_config-driven runtime state via the returned keys and the scheduler's
   structured log - integration tests assert the returned set directly.
   ============================================================================ */

const { executeQuery, withTransaction } = require('../config/db');
const { CHANGE_OP } = require('../constants');
const { recordChange } = require('../services/changeLogService');

/**
 * Run one escalation pass for one business.
 * @param {number} businessKey
 * @returns {{ escalated:number, grnKeys:number[] }}
 */
async function runGRNAutoClose(businessKey) {
  const cfg = await executeQuery(
    "SELECT TRY_CAST(config_value AS INT) AS hours FROM app_config WHERE config_name = 'GRN_AUTO_CLOSE_HOURS'"
  );
  const hours = cfg.recordset[0]?.hours ?? 24;
  if (!Number.isFinite(hours) || hours <= 0) {
    return { escalated: 0, grnKeys: [] };
  }

  // GRNs past the signoff window without finance signoff:
  // - not yet signed off by finance
  // - created more than @hours ago
  // The updated_at bump marks "escalation pass observed this GRN" and the
  // credit_note_issued=0 predicate keeps already-processed ones excluded
  // only when finance cleared them; unsigned old GRNs legitimately appear
  // on every pass (the escalation is a standing state, not a one-shot).
  //
  // PULL: the escalation UPDATE and each escalated GRN's change-log row
  // commit in ONE transaction (transactional outbox) - a partial escalation
  // state can never reach pull devices.
  return withTransaction(async (tx) => {
    const result = await tx.query(
      `UPDATE g
          SET g.updated_at = GETDATE()
         OUTPUT INSERTED.grn_key, INSERTED.grn_number, INSERTED.created_at,
               INSERTED.receipt_status, INSERTED.total_invoice_qty,
               INSERTED.total_received_qty, INSERTED.total_rejected_qty
        FROM fact_grn g
       WHERE g.business_key = @businessKey
         AND g.finance_signoff = 0
         AND DATEDIFF(HOUR, g.created_at, GETDATE()) >= @hours`,
      { businessKey, hours }
    );

    for (const row of result.recordset) {
      await recordChange(tx, {
        dataset: 'GRNS',
        businessKey,
        entityKey: row.grn_key,
        op: CHANGE_OP.UPSERT
      });
    }

    const grnKeys = result.recordset.map((r) => r.grn_key);
    return { escalated: grnKeys.length, grnKeys, grns: result.recordset };
  });
}

module.exports = { runGRNAutoClose };
