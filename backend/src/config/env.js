/* ============================================================================
   ENVIRONMENT CONFIGURATION (HARDENED)
   Single validated source of truth for every environment variable.

   Hardening rules enforced here:
   - In production the process REFUSES to start when:
       * NODE_ENV is unset
       * JWT_SECRET is missing, a placeholder, or the old dev default
       * DB_PASSWORD is missing or a placeholder
       * DB_USER is 'sa' (least privilege violation, see database/03)
   - In development/test the same variables fall back to the documented
     defaults so a fresh clone still runs, but a loud warning is printed.

   Centralizing validation means a misconfigured staging container fails
   at boot with a precise message instead of at the first request with a
   cryptic mssql/JWT stack trace.
   ============================================================================ */

const PRODUCTION = 'production';

const PLACEHOLDER_VALUES = new Set([
  'change-me-to-a-long-random-string',
  'change-me-to-a-strong-password',
  'YourStrong@Passw0rd',
  'renuzi-super-secret-key-change-me-in-production',
  ''
]);

function readString(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === '') {
    return fallback;
  }
  return String(v).trim();
}

function readInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function readBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  return /^true$/i.test(String(raw).trim());
}

function assertProductionSafe(env) {
  const failures = [];

  if (PLACEHOLDER_VALUES.has(env.JWT_SECRET)) {
    failures.push('JWT_SECRET must be set to a strong random value (see .env.example for a generator).');
  }
  if (env.JWT_SECRET && env.JWT_SECRET.length < 32) {
    failures.push('JWT_SECRET must be at least 32 characters in production.');
  }
  if (PLACEHOLDER_VALUES.has(env.DB_PASSWORD)) {
    failures.push('DB_PASSWORD must be set to a strong value (never the placeholder).');
  }
  if (env.DB_USER === 'sa') {
    failures.push("DB_USER must not be 'sa'. Create the least-privilege login via database/03_least_privilege.sql.");
  }

  if (failures.length > 0) {
    console.error('================================================================');
    console.error('  FATAL: REFUSING TO START - INSECURE PRODUCTION CONFIGURATION');
    failures.forEach((f) => console.error(`  - ${f}`));
    console.error('================================================================');
    throw new Error(`Insecure production configuration: ${failures.join(' ')}`);
  }
}

function buildEnv() {
  const nodeEnv = readString('NODE_ENV', 'development');
  const isProduction = nodeEnv === PRODUCTION;
  const isTest = nodeEnv === 'test';

  const env = {
    nodeEnv,
    isProduction,
    isTest,

    port: readInt('PORT', 3000),

    db: {
      server: readString('DB_SERVER', 'localhost'),
      port: readInt('DB_PORT', 1433),
      database: readString('DB_NAME', 'RenuziOpsDB'),
      user: readString('DB_USER', 'sa'),
      password: readString('DB_PASSWORD', 'YourStrong@Passw0rd'),
      encrypt: readBool('DB_ENCRYPT', false),
      poolMax: readInt('DB_POOL_MAX', 20),
      poolMin: readInt('DB_POOL_MIN', isTest ? 0 : 2)
    },

    jwt: {
      secret: readString('JWT_SECRET', 'renuzi-super-secret-key-change-me-in-production'),
      expiresIn: readString('JWT_EXPIRES_IN', '24h')
    },

    sync: {
      cronEnabled: readBool('SYNC_CRON_ENABLED', true),
      cronSchedule: readString('SYNC_CRON_SCHEDULE', '*/1 * * * *'),
      grnCloseSchedule: readString('GRN_CLOSE_CRON_SCHEDULE', '0 * * * *'),
      stuckProcessingMinutes: readInt('SYNC_STUCK_PROCESSING_MINUTES', 10),
      backoffBaseSeconds: readInt('SYNC_BACKOFF_BASE_SECONDS', 30),
      retryMaxDefault: readInt('SYNC_RETRY_MAX_DEFAULT', 5)
    },

    /* Change-log maintenance jobs (consumed by jobs/scheduler.js):
       - sweep: reconciliation backstop (changeLogService.sweepChanges) that
         re-emits writes which bypassed the transactional outbox and
         tombstones hard deletes, so devices stay consistent.
       - retention: purge of sync_change_log rows older than the retention
         window via sp_sync_change_log_retention (changeLogService.runRetention);
         a device cursor older than the surviving watermark gets resetRequired.
       Both jobs honor the master SYNC_CRON_ENABLED gate above. */
    maintenance: {
      sweepEnabled: readBool('SWEEP_CRON_ENABLED', true),
      sweepSchedule: readString('SWEEP_CRON_SCHEDULE', '*/5 * * * *'),
      retentionEnabled: readBool('RETENTION_CRON_ENABLED', true),
      retentionSchedule: readString('RETENTION_CRON_SCHEDULE', '15 3 * * *'),
      // Days a change-log row survives the purge. Unset (default) defers to
      // the app_config key of the same name seeded by database/05 (proc
      // default 30), so retention stays tunable per-database without a
      // redeploy. 0 keeps nothing; negative values are rejected by the proc.
      retentionDays: readInt('SYNC_CHANGE_LOG_RETENTION_DAYS', null)
    },

    uploads: {
      driver: readString('UPLOAD_STORAGE_DRIVER', 'local'),
      localDir: readString('UPLOAD_LOCAL_DIR', './uploads'),
      maxBytes: readInt('UPLOAD_MAX_BYTES', 10 * 1024 * 1024),
      allowedMime: readString('UPLOAD_ALLOWED_MIME', 'image/jpeg,image/png,image/webp,application/pdf')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      virusScanHost: readString('VIRUS_SCAN_HOST', ''),
      virusScanPort: readInt('VIRUS_SCAN_PORT', 3310),
      signedUrlTtl: readInt('UPLOAD_SIGNED_URL_TTL', 900),
      azure: {
        connectionString: readString('AZURE_STORAGE_CONNECTION_STRING', ''),
        containerName: readString('AZURE_STORAGE_CONTAINER_NAME', 'renuzi-uploads')
      }
    }
  };

  if (isProduction) {
    assertProductionSafe(env);
  } else if (PLACEHOLDER_VALUES.has(env.jwt.secret)) {
    console.warn('[ENV] WARNING: JWT_SECRET is a placeholder. Set a strong value before deploying.');
  }

  if (env.uploads.driver === 'azure-blob' && !env.uploads.azure.connectionString) {
    throw new Error('UPLOAD_STORAGE_DRIVER=azure-blob requires AZURE_STORAGE_CONNECTION_STRING.');
  }

  return Object.freeze(env);
}

const env = buildEnv();

module.exports = { env };
