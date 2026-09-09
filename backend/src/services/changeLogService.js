/* ============================================================================
   CHANGE LOG SERVICE (Service Layer - transactional outbox)
   The download-side complement to the durable push queue. Consumers:
   - fleetService/warehouseService (emit rows inside their write tx)
   - jobs/scheduler.js            (retention purge + reconciliation sweeper)
   - services/syncPullService.js  (reads for delta pages)

   DESIGN (mirrors syncQueueService conventions):
   - recordChange(): emits a sync_change_log row IN THE CALLER'S TRANSACTION
     so the fact write + log row commit atomically (exactly-once effect). It
     also bumps the entity's version_no, keeping one source of truth for
     per-entity monotonic versioning. SELF-SNAPSHOTTING: when the caller
     omits `payload` for an UPSERT, the post-write row state is read inside
     the same tx and becomes the payload - callers never hand-build row
     snapshots, and the emitted payload cannot drift from what commits.
     Returns payloadJson so HTTP layers need no re-read.
   - sweepChanges(): reconciliation backstop, two branches per dataset:
     1) re-emit rows whose current version_no is missing from the log
        (writes that bypassed the service layer, pre-migration v1 seeds);
     2) tombstone sweeper - entities the log remembers whose row no longer
        exists and whose latest op is not DELETE (a hard delete bypassed
        the outbox) get the missing DELETE tombstone so devices drop them.
   - runRetention(): wraps sp_sync_change_log_retention; a cursor older
     than the oldest surviving change_key yields resetRequired on pull.
   - oldestChangeKey(businessKey?, dataset?): retention watermark, scoped
     per business AND per dataset so one dataset's purged history never
     forces (or masks) another dataset's reset.

   Multi-instance safety: version bumping uses an atomic UPDATE ... OUTPUT
   (the row itself is the mutex, same pattern as the queue's claimBatch).
   Tombstone versioning (MAX(version_no)+1 in-tx) may race to a duplicate
   across instances, which is harmless: clients apply by (entityKey,
   versionNo) guard and duplicate same-op rows are no-ops.
   ============================================================================ */

const { executeQuery, executeStoredProc } = require('../config/db');
const { PULL_DATASETS, CHANGE_OP } = require('../constants');

/**
 * Emit a change-log row INSIDE the caller's transaction and bump the
 * entity's version_no atomically. The fact write and this call must share
 * one transaction (services pass their `tx`); the bump happens FIRST so
 * the emitted version is the post-write version.
 *
 * UPSERT: the bump doubles as the existence check (unknown entityKey fails
 * loudly). With no `payload`, the row is self-snapshotted AFTER the bump
 * inside the same tx, so payload.version_no matches the emitted version.
 * An explicit payload is only for tests/partial shapes; the authoritative
 * versionNo is always merged in last.
 *
 * DELETE (tombstone): the caller invokes this AFTER deleting the row, so
 * the version bump targets a gone row - that is fine: we log version
 * MAX(logged)+1 directly instead of bumping.
 *
 * @param {object} tx      transaction-scoped query object (config/db withTransaction)
 * @param {object} change
 * @param {string} change.dataset     key of PULL_DATASETS (e.g. 'DISPATCHES')
 * @param {number} change.businessKey
 * @param {number} change.entityKey
 * @param {string} change.op          CHANGE_OP.UPSERT | CHANGE_OP.DELETE
 * @param {object} [change.payload]   entity snapshot (omitted -> self-snapshot the row)
 * @returns {Promise<{changeKey:number, versionNo:number, payloadJson:string|null}>}
 */
async function recordChange(tx, { dataset, businessKey, entityKey, op, payload }) {
  const def = PULL_DATASETS[dataset];
  if (!def) throw new Error(`Unknown pull dataset ${dataset}`);
  if (!CHANGE_OP[op]) throw new Error(`Unknown change op ${op}`);
  if (!Number.isInteger(businessKey) || !Number.isInteger(entityKey)) {
    throw new Error(`recordChange requires integer businessKey/entityKey for ${dataset}`);
  }

  let versionNo;
  let snapshot = payload;

  if (op === CHANGE_OP.UPSERT) {
    // Atomic bump; the row itself is the mutex (multi-instance safe).
    // updated_at is deliberately NOT touched: the bump is outbox bookkeeping,
    // not a business write (and dim_route has no updated_at column).
    const bumped = await tx.query(
      `UPDATE ${def.table}
          SET version_no = version_no + 1
         OUTPUT INSERTED.version_no
        WHERE ${def.keyColumn} = @entityKey AND business_key = @businessKey`,
      { entityKey, businessKey }
    );
    if (bumped.recordset.length === 0) {
      throw new Error(`recordChange: ${dataset} entity ${entityKey} not found for business ${businessKey}`);
    }
    versionNo = Number(bumped.recordset[0].version_no);

    // Self-snapshotting: read the post-write row state in the caller's tx so
    // the emitted payload can never drift from what is being committed.
    if (snapshot === undefined) {
      const rows = await tx.query(
        `SELECT * FROM ${def.table}
          WHERE ${def.keyColumn} = @entityKey AND business_key = @businessKey`,
        { entityKey, businessKey }
      );
      if (rows.recordset.length === 0) {
        throw new Error(`recordChange: ${dataset} entity ${entityKey} vanished mid-transaction`);
      }
      snapshot = rows.recordset[0];
    }
  } else {
    // Tombstone: the row is gone (or being deleted); version = last + 1.
    const last = await tx.query(
      `SELECT ISNULL(MAX(version_no), 0) AS v
         FROM sync_change_log
        WHERE business_key = @businessKey AND entity_type = @dataset AND entity_key = @entityKey`,
      { businessKey, dataset, entityKey }
    );
    versionNo = Number(last.recordset[0].v) + 1;
  }

  // versionNo merged LAST: always the authoritative post-bump version, even
  // if an explicit payload carries a stale versionNo of its own.
  const payloadJson = op === CHANGE_OP.UPSERT
    ? JSON.stringify({ ...snapshot, versionNo })
    : null;

  const inserted = await tx.query(
    `INSERT INTO sync_change_log (
       business_key, entity_type, entity_key, op, version_no, payload_json
     ) OUTPUT INSERTED.change_key
     VALUES (@businessKey, @dataset, @entityKey, @op, @versionNo, @payloadJson)`,
    { businessKey, dataset, entityKey, op, versionNo, payloadJson }
  );

  return { changeKey: inserted.recordset[0].change_key, versionNo, payloadJson };
}

/**
 * Convenience for non-transactional (single-statement) service writes:
 * wraps the emit in its own transaction so callers keep using executeQuery.
 * Not for multi-statement writes - those must pass their tx to recordChange.
 */
async function recordChangeStandalone(change) {
  const { withTransaction } = require('../config/db');
  return withTransaction((tx) => recordChange(tx, change));
}

/* ---------------------------------------------------------------------------
   Reconciliation sweeper (backstop)
   --------------------------------------------------------------------------- */

/**
 * For every dataset: (1) find rows whose version_no is NEWER than the
 * latest logged version (a write path bypassed the outbox) and re-emit
 * their current state; also back-fills brand-new entities created before
 * migration 05 seeded version_no (their version 1 was never logged).
 * (2) Tombstone sweeper: entities the log remembers whose row no longer
 * exists and whose latest op is not DELETE get a DELETE tombstone, so a
 * hard delete that bypassed the service layer still reaches devices.
 *
 * @returns {Promise<{ swept:number, tombstoned:number, datasets:object }>}
 *          datasets: { DATASET: { reemitted:number, tombstones:number } }
 */
async function sweepChanges() {
  const swept = {};
  let total = 0;
  let tombstoneTotal = 0;

  for (const [dataset, def] of Object.entries(PULL_DATASETS)) {
    let reemitted = 0;
    let tombstones = 0;

    /* --- Branch 1: current state never logged -> re-emit snapshot --- */
    const missing = await executeQuery(
      `SELECT d.business_key, d.${def.keyColumn} AS entity_key, d.version_no
         FROM ${def.table} d
         LEFT JOIN sync_change_log l
           ON l.business_key = d.business_key
          AND l.entity_type = @dataset
          AND l.entity_key = d.${def.keyColumn}
          AND l.version_no = d.version_no
        WHERE d.business_key IS NOT NULL
          AND l.change_key IS NULL`,
      { dataset }
    );

    for (const row of missing.recordset) {
      try {
        // Self-snapshotting emit in its own tx (reads the row's current state)
        await emitSnapshot(dataset, row.business_key, row.entity_key);
        reemitted++;
      } catch (err) {
        console.error(`[CHANGELOG] sweep emit failed (${dataset} ${row.entity_key}):`, err.message);
      }
    }

    /* --- Branch 2: tombstone sweeper. Latest logged op per entity that is
            not DELETE, joined against a now-missing row: a hard delete
            bypassed the outbox. (IDENTITY keys are never reused, so a
            missing row for that business means the entity is truly gone.) --- */
    const gone = await executeQuery(
      `SELECT latest.business_key, latest.entity_key
         FROM (
           SELECT business_key, entity_key, MAX(change_key) AS last_change_key
             FROM sync_change_log
            WHERE entity_type = @dataset
            GROUP BY business_key, entity_key
         ) latest
         JOIN sync_change_log l
           ON l.change_key = latest.last_change_key
         LEFT JOIN ${def.table} d
           ON d.${def.keyColumn} = latest.entity_key
          AND d.business_key = latest.business_key
        WHERE l.op <> @deleteOp
          AND d.${def.keyColumn} IS NULL`,
      { dataset, deleteOp: CHANGE_OP.DELETE }
    );

    for (const row of gone.recordset) {
      try {
        await recordChangeStandalone({
          dataset,
          businessKey: row.business_key,
          entityKey: row.entity_key,
          op: CHANGE_OP.DELETE
        });
        tombstones++;
      } catch (err) {
        console.error(`[CHANGELOG] sweep tombstone failed (${dataset} ${row.entity_key}):`, err.message);
      }
    }

    if (reemitted > 0 || tombstones > 0) {
      swept[dataset] = { reemitted, tombstones };
      total += reemitted;
      tombstoneTotal += tombstones;
    }
  }

  return { swept: total, tombstoned: tombstoneTotal, datasets: swept };
}

/**
 * Emit the CURRENT full row state as an UPSERT change (sweeper/reset path).
 * Delegates to recordChange with no payload - the service self-snapshots
 * the row inside the emit transaction, so payload and version always
 * match the post-bump state. Throws when the row no longer exists.
 */
async function emitSnapshot(dataset, businessKey, entityKey) {
  return recordChangeStandalone({
    dataset,
    businessKey,
    entityKey,
    op: CHANGE_OP.UPSERT
  });
}

/* ---------------------------------------------------------------------------
   Retention
   --------------------------------------------------------------------------- */

/**
 * Purge change-log rows older than the retention window via the stored
 * procedure (retention watermark drives the pull API's resetRequired).
 * @returns {Promise<number>} purged row count
 */
async function runRetention(retentionDays) {
  const result = await executeStoredProc('sp_sync_change_log_retention', {
    retentionDays: retentionDays ?? null
  });
  const row = (result.recordset || [])[0];
  return row ? Number(row.purged) : 0;
}

/**
 * Oldest surviving change_key - the retention watermark. Scope by business
 * and/or dataset. The pull API checks PER DATASET: with a shared watermark,
 * one dataset's retained history could mask another dataset's purged gap
 * (a stale cursor would silently pass) or force needless resets.
 */
async function oldestChangeKey(businessKey, dataset) {
  const params = {};
  const clauses = [];
  if (businessKey !== undefined) {
    clauses.push('business_key = @businessKey');
    params.businessKey = businessKey;
  }
  if (dataset !== undefined) {
    if (!PULL_DATASETS[dataset]) throw new Error(`Unknown pull dataset ${dataset}`);
    clauses.push('entity_type = @dataset');
    params.dataset = dataset;
  }
  let query = 'SELECT MIN(change_key) AS oldest FROM sync_change_log';
  if (clauses.length > 0) query += ` WHERE ${clauses.join(' AND ')}`;
  const result = await executeQuery(query, params);
  const oldest = result.recordset[0].oldest;
  return oldest === null ? 0 : Number(oldest);
}

module.exports = {
  recordChange,
  recordChangeStandalone,
  emitSnapshot,
  sweepChanges,
  runRetention,
  oldestChangeKey
};
