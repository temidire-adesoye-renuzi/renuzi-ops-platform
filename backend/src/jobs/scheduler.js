/* ============================================================================
   SCHEDULER (Objective 2)
   node-cron driven automation. Jobs:
   - Queue processing: drains PENDING/FAILED rows for every ACTIVE business
     (replaces the manual-only POST /api/sync/process; the endpoint remains
     for admin triggering and tests).
   - GRN auto-close escalation: hourly pass per business.
   - Change-log sweep: reconciliation backstop re-emitting outbox-bypassing
     writes and tombstoning hard deletes (changeLogService.sweepChanges).
   - Change-log retention: purge of sync_change_log rows older than the
     retention window (changeLogService.runRetention via stored proc).

   Concurrency guard: a module-level "running" flag plus a cron overlap
   guard (node-cron does not fire a still-running handler again by default
   in the same tick, but multiple API instances each run their own scheduler
   - the atomic claim in syncQueueService makes that SAFE by design).

   startScheduler() is invoked ONLY by server.js (production bootstrap),
   never by tests importing app.js.
   ============================================================================ */

const cron = require('node-cron');
const { executeQuery } = require('../config/db');
const { env } = require('../config/env');
const syncQueueService = require('../services/syncQueueService');
const { sweepChanges, runRetention } = require('../services/changeLogService');
const { runGRNAutoClose } = require('./grnAutoCloseJob');

const jobs = [];
let queueRunning = false;

async function activeBusinessKeys() {
  const result = await executeQuery(
    'SELECT business_key FROM dim_business WHERE is_active = 1'
  );
  return result.recordset.map((r) => r.business_key);
}

/**
 * Drain the sync queue for every active business once.
 * Errors are logged and swallowed: a transient DB outage must not kill the
 * scheduler - the next tick retries (and the queue's own backoff prevents
 * a tight failure loop).
 */
async function processAllQueues() {
  if (queueRunning) return; // overlap guard within this instance
  queueRunning = true;
  try {
    const keys = await activeBusinessKeys();
    for (const businessKey of keys) {
      // Drain until a pass claims nothing (batch smaller than limit ends naturally)
      for (let pass = 0; pass < 20; pass++) {
        const summary = await syncQueueService.processQueue(businessKey);
        if (summary.processed === 0) break;
        if (summary.synced > 0 || summary.failed > 0 || summary.conflicts > 0) {
          console.log(`[CRON] sync queue business ${businessKey}: ` +
            `${summary.synced} synced, ${summary.failed} failed, ${summary.conflicts} conflicts`);
        }
      }
    }
  } catch (err) {
    console.error('[CRON] queue processing error:', err.message);
  } finally {
    queueRunning = false;
  }
}

/** Hourly GRN escalation pass for every active business. */
async function escalateAllGRNs() {
  try {
    const keys = await activeBusinessKeys();
    for (const businessKey of keys) {
      const { escalated } = await runGRNAutoClose(businessKey);
      if (escalated > 0) {
        console.log(`[CRON] GRN auto-close: ${escalated} GRN(s) past signoff window for business ${businessKey}`);
      }
    }
  } catch (err) {
    console.error('[CRON] GRN auto-close error:', err.message);
  }
}

/**
 * Change-log reconciliation sweep: re-emit rows whose writes bypassed the
 * transactional outbox and tombstone hard deletes, per dataset. Errors are
 * logged and swallowed like the other passes - the next tick retries.
 */
async function sweepChangeLog() {
  try {
    const summary = await sweepChanges();
    if (summary.swept > 0 || summary.tombstoned > 0) {
      console.log(`[CRON] change-log sweep: ${summary.swept} re-emitted, ${summary.tombstoned} tombstoned`);
    }
  } catch (err) {
    console.error('[CRON] change-log sweep error:', err.message);
  }
}

/**
 * Retention purge of sync_change_log rows older than the retention window
 * (sp_sync_change_log_retention; null defers to the app_config default).
 */
async function purgeChangeLog() {
  try {
    const purged = await runRetention(env.maintenance.retentionDays);
    if (purged > 0) {
      console.log(`[CRON] change-log retention: purged ${purged} rows`);
    }
  } catch (err) {
    console.error('[CRON] change-log retention error:', err.message);
  }
}

function startScheduler() {
  if (!env.sync.cronEnabled) {
    console.log('[CRON] Scheduler disabled via SYNC_CRON_ENABLED=false');
    return;
  }

  if (!cron.validate(env.sync.cronSchedule)) {
    throw new Error(`Invalid SYNC_CRON_SCHEDULE: ${env.sync.cronSchedule}`);
  }
  if (!cron.validate(env.sync.grnCloseSchedule)) {
    throw new Error(`Invalid GRN_CLOSE_CRON_SCHEDULE: ${env.sync.grnCloseSchedule}`);
  }
  if (env.maintenance.sweepEnabled && !cron.validate(env.maintenance.sweepSchedule)) {
    throw new Error(`Invalid SWEEP_CRON_SCHEDULE: ${env.maintenance.sweepSchedule}`);
  }
  if (env.maintenance.retentionEnabled && !cron.validate(env.maintenance.retentionSchedule)) {
    throw new Error(`Invalid RETENTION_CRON_SCHEDULE: ${env.maintenance.retentionSchedule}`);
  }

  const queueJob = cron.schedule(env.sync.cronSchedule, () => {
    processAllQueues().catch((e) => console.error('[CRON] unexpected:', e.message));
  });
  const grnJob = cron.schedule(env.sync.grnCloseSchedule, () => {
    escalateAllGRNs().catch((e) => console.error('[CRON] unexpected:', e.message));
  });

  jobs.push(queueJob, grnJob);
  console.log(`[CRON] Scheduler started: queue '${env.sync.cronSchedule}', GRN close '${env.sync.grnCloseSchedule}'`);

  if (env.maintenance.sweepEnabled) {
    jobs.push(cron.schedule(env.maintenance.sweepSchedule, () => {
      sweepChangeLog().catch((e) => console.error('[CRON] unexpected:', e.message));
    }));
    console.log(`[CRON] Change-log sweep scheduled: '${env.maintenance.sweepSchedule}'`);
  } else {
    console.log('[CRON] Change-log sweep disabled via SWEEP_CRON_ENABLED=false');
  }

  if (env.maintenance.retentionEnabled) {
    jobs.push(cron.schedule(env.maintenance.retentionSchedule, () => {
      purgeChangeLog().catch((e) => console.error('[CRON] unexpected:', e.message));
    }));
    console.log(`[CRON] Change-log retention scheduled: '${env.maintenance.retentionSchedule}'` +
      (env.maintenance.retentionDays !== null ? `, retention ${env.maintenance.retentionDays} day(s)` : ', retention window from app_config'));
  } else {
    console.log('[CRON] Change-log retention disabled via RETENTION_CRON_ENABLED=false');
  }
}

function stopScheduler() {
  jobs.forEach((j) => j.stop());
  jobs.length = 0;
}

module.exports = { startScheduler, stopScheduler, processAllQueues, escalateAllGRNs, sweepChangeLog, purgeChangeLog };
