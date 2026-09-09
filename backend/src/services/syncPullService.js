/* ============================================================================
   SYNC PULL SERVICE (Service Layer)
   Device-initiated delta download over the transactional change log.
   Consumers: routes/pull.js (HTTP), tests.

   Protocol (thin-adapter style; all mechanics live here):
   - getPullMeta(businessKey, datasets):
       cheap probe -> per-dataset maxChangeKey + pending count. The device
       calls this first on a marginal connection to decide whether to pull.
    - pullChanges(businessKey, cursorMap, {pageSize, snapshotAfterKey}):
        one page per dataset. Returns changes[], nextCursor, hasMore,
        resetRequired[] when a dataset's cursor predates the retention
        watermark (device re-bootstraps with cursor 0 = full snapshot), and
        snapshotAfterKey{} while a cursor-0 snapshot is still mid-flight -
        the per-dataset keyset continuation (last entityKey of the page).
        The caller echoes it back on the next call to resume the snapshot
        where the last page ended; no server-side paging state is kept.

   Cursor semantics:
   - cursor 0 or absent  -> full current-state snapshot (all live rows via
     the sweeper-style current-state emission) - the bootstrap/reset path.
   - cursor N (device's last applied change) -> rows with change_key > N.
   - stale cursor (below oldest surviving change_key) -> resetRequired;
     the log can no longer prove continuity, so the device MUST re-bootstrap.

   The net-current-state property: the log only ever grows append-only, and
   devices apply pages by (entityType, entityKey) with a version guard, so
   replayed/duplicate pages are no-ops on the client - the download mirror
   of the push queue's clientRef idempotency.
   ============================================================================ */

const { executeQuery } = require('../config/db');
const { PULL_DATASETS, CHANGE_OP } = require('../constants');
const changeLogService = require('./changeLogService');

function assertDataset(dataset) {
  if (!PULL_DATASETS[dataset]) {
    const { HttpError } = require('../utils/httpError');
    throw new HttpError(400, `Unknown dataset ${dataset}. Valid: ${Object.keys(PULL_DATASETS).join(', ')}`);
  }
}

/** Normalize a device-supplied dataset list (query ?datasets= or cursor keys). */
function normalizeDatasets(datasets) {
  if (datasets === undefined || datasets === null) return Object.keys(PULL_DATASETS);
  const list = Array.isArray(datasets)
    ? datasets
    : String(datasets).split(',').map((s) => s.trim()).filter(Boolean);
  return list.filter((d) => PULL_DATASETS[d]);
}

async function getConfigInt(name, fallback) {
  const result = await executeQuery(
    'SELECT config_value FROM app_config WHERE config_name = @name',
    { name }
  );
  const row = result.recordset[0];
  if (!row) return fallback;
  const v = parseInt(row.config_value, 10);
  return Number.isNaN(v) ? fallback : v;
}

/* ---------------------------------------------------------------------------
   Meta probe
   --------------------------------------------------------------------------- */

/**
 * @param {number} businessKey tenant scope (TD-12: every query business-scoped)
 * @param {string[]|string} [datasets]
 * @returns {Promise<object>} { DATASET: { maxChangeKey, changesPending }, ... }
 */
async function getPullMeta(businessKey, datasets) {
  const list = normalizeDatasets(datasets);
  const meta = {};

  for (const dataset of list) {
    assertDataset(dataset);
    const result = await executeQuery(
      `SELECT
         ISNULL(MAX(change_key), 0) AS max_change_key,
         COUNT(*) AS total
       FROM sync_change_log
       WHERE business_key = @businessKey AND entity_type = @dataset`,
      { businessKey, dataset }
    );
    const row = result.recordset[0];
    meta[dataset] = {
      maxChangeKey: Number(row.max_change_key),
      totalChanges: Number(row.total)
    };
  }

  return meta;
}

/* ---------------------------------------------------------------------------
   Current-state snapshot (bootstrap / reset path: cursor 0)
   --------------------------------------------------------------------------- */

/**
 * Emit + return the FULL current state of a dataset as a page of UPSERT
 * changes. Used when cursor is 0/absent (first pull) or after resetRequired.
 * The change rows are emitted through the outbox so subsequent delta pulls
 * from ANY device see a consistent continuation.
 *
 * Keyset pagination: uses lastEntityKey (the keyColumn value) instead of
 * OFFSET/FETCH for stable, efficient paging over large tables. The value is
 * carried across requests by the caller as snapshotAfterKey.
 */
async function snapshotDataset(businessKey, dataset, pageSize, lastEntityKey = null) {
  const def = PULL_DATASETS[dataset];

  const rows = await executeQuery(
    `SELECT ${def.keyColumn} AS entity_key, version_no
       FROM ${def.table}
      WHERE business_key = @businessKey
        AND is_active = 1
        ${lastEntityKey !== null ? `AND ${def.keyColumn} > @lastEntityKey` : ''}
      ORDER BY ${def.keyColumn} ASC
        OFFSET 0 ROWS FETCH NEXT @pageSize ROWS ONLY`,
    { businessKey, lastEntityKey, pageSize: pageSize + 1 }
  );

  const fetched = rows.recordset.slice(0, pageSize);
  const hasMore = rows.recordset.length > pageSize;

  const changes = [];
  for (const row of fetched) {
    const emitted = await changeLogService.emitSnapshot(
      dataset, businessKey, row.entity_key
    );
    changes.push({
      entityType: dataset,
      entityKey: row.entity_key,
      op: CHANGE_OP.UPSERT,
      versionNo: emitted.versionNo,
      changeKey: emitted.changeKey,
      payload: emitted.payloadJson ? JSON.parse(emitted.payloadJson) : null
    });
  }

  const nextLastEntityKey = fetched.length > 0
    ? fetched[fetched.length - 1].entity_key
    : lastEntityKey;

  return { changes, hasMore, nextLastEntityKey };
}

/* ---------------------------------------------------------------------------
   Paged pull
   --------------------------------------------------------------------------- */

/**
 * Pull one page of changes for the requested datasets.
 *
 * @param {number} businessKey tenant scope
 * @param {object} cursorMap   { DATASET: lastAppliedChangeKey } - device state
 * @param {object} [opts]     { pageSize?: number, datasets?: string[],
 *                             snapshotAfterKey?: { DATASET: entityKey } }
 *   snapshotAfterKey: per-dataset keyset continuation for mid-flight
 *   cursor-0 snapshots - the last entityKey of the previous snapshot page.
 *   Absent/empty = start from the beginning of the dataset.
 * @returns {Promise<{changes: Array, nextCursor: object, hasMore: boolean,
 *                     resetRequired: string[], snapshotAfterKey: object}>}
 */
async function pullChanges(businessKey, cursorMap, opts = {}) {
  const requested = normalizeDatasets(opts.datasets || Object.keys(cursorMap));
  const defaultPageSize = await getConfigInt('SYNC_PULL_PAGE_SIZE', 200);
  const pageSize = Math.min(
    Math.max(parseInt(opts.pageSize, 10) || defaultPageSize, 1),
    Math.max(defaultPageSize, 200)
  );

  const changes = [];
  const nextCursor = {};
  const resetRequired = [];
  const snapshotAfterKey = {}; // per-dataset keyset continuation, only populated while a snapshot has more pages
  let hasMore = false;

  for (const dataset of requested) {
    assertDataset(dataset);
    const cursor = Number(cursorMap && cursorMap[dataset] !== undefined ? cursorMap[dataset] : 0);

    // Dataset-scoped watermark: each dataset's retention boundary is
    // independent - one dataset's purged history must not be masked by
    // another's retained rows (shared-watermark blind spot).
    const oldest = await changeLogService.oldestChangeKey(businessKey, dataset);

    /* --- Stale cursor: continuity cannot be proven -> explicit reset --- */
    if (cursor > 0 && oldest > 0 && cursor < oldest) {
      resetRequired.push(dataset);
      nextCursor[dataset] = 0; // device re-bootstraps this dataset
      continue;
    }

    /* --- Bootstrap / reset: cursor 0 -> current-state snapshot page --- */
    if (cursor === 0) {
      const afterKey = opts.snapshotAfterKey
        ? Number(opts.snapshotAfterKey[dataset])
        : NaN;
      const lastEntityKey = Number.isFinite(afterKey) && afterKey >= 0
        ? afterKey
        : null;
      const snap = await snapshotDataset(businessKey, dataset, pageSize, lastEntityKey);
      changes.push(...snap.changes);
      const maxKey = snap.changes.length > 0
        ? Math.max(...snap.changes.map((c) => c.changeKey))
        : cursor;
      nextCursor[dataset] = snap.hasMore ? 0 : maxKey;
      if (snap.hasMore) {
        hasMore = true;
        snapshotAfterKey[dataset] = snap.nextLastEntityKey;
      }
      continue;
    }

    /* --- Delta page: rows with change_key > cursor (index range scan) --- */
    const result = await executeQuery(
      `SELECT TOP (@pageSize)
         change_key, entity_type, entity_key, op, version_no, payload_json
       FROM sync_change_log
       WHERE business_key = @businessKey
         AND entity_type = @dataset
         AND change_key > @cursor
       ORDER BY change_key ASC`,
      { pageSize, businessKey, dataset, cursor }
    );

    const rows = result.recordset;
    for (const row of rows) {
      changes.push({
        entityType: row.entity_type,
        entityKey: row.entity_key,
        op: row.op,
        versionNo: Number(row.version_no),
        changeKey: Number(row.change_key),
        payload: row.payload_json ? JSON.parse(row.payload_json) : null
      });
    }

    const maxKey = rows.length > 0 ? Number(rows[rows.length - 1].change_key) : cursor;
    nextCursor[dataset] = maxKey;
    if (rows.length === pageSize) hasMore = true;
  }

  return {
    changes,
    nextCursor,
    hasMore,
    snapshotAfterKey: Object.keys(snapshotAfterKey).length > 0 ? snapshotAfterKey : undefined,
    resetRequired: resetRequired.length > 0 ? resetRequired : undefined
  };
}

module.exports = {
  getPullMeta,
  pullChanges,
  normalizeDatasets
};
