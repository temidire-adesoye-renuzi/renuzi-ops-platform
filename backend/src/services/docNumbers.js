/* ============================================================================
   DOCUMENT NUMBERING (Service Layer)
   Generates daily-sequential document numbers, e.g. GRN-KETU-20260829-001.

   CRITICAL INVARIANT: must be called INSIDE the same transaction that
   inserts the header. The COUNT query then reads under the transaction's
   locks so two concurrent creators cannot mint the same number (the
   column's UNIQUE constraint is the final backstop).

   Previously this logic lived inside warehouse.js only; the offline GRN
   processor needs the exact same generator, so it is extracted here.
   ============================================================================ */

const DOC_PREFIXES = Object.freeze({
  GRN: 'GRN',
  DISPATCH: 'DSP'
});

/**
 * @param {object} tx   - transaction-scoped query object (tx.query)
 * @param {string} kind - 'GRN' | 'DISPATCH'
 * @param {string} businessId  - e.g. 'KETU'
 * @param {number} dateKey      - YYYYMMDD
 */
async function nextDocNumber(tx, kind, businessId, dateKey) {
  const prefix = DOC_PREFIXES[kind];
  if (!prefix) throw new Error(`Unknown document kind ${kind}`);

  const table = kind === 'GRN' ? 'fact_grn' : 'fact_dispatch';
  const column = kind === 'GRN' ? 'grn_number' : 'dispatch_number';

  const dateStr = String(dateKey);
  const like = `${prefix}-${businessId}-${dateStr}-%`;

  const result = await tx.query(
    `SELECT COUNT(*) AS cnt FROM ${table} WITH (UPDLOCK, HOLDLOCK) WHERE ${column} LIKE @like`,
    { like }
  );
  const seq = String(result.recordset[0].cnt + 1).padStart(3, '0');
  return `${prefix}-${businessId}-${dateStr}-${seq}`;
}

module.exports = { nextDocNumber, DOC_PREFIXES };
