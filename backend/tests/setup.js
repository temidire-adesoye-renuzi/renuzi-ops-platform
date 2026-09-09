/* ============================================================================
   GLOBAL JEST SETUP
   Runs before every test file (both projects).

   Environment hardening for tests:
   - NODE_ENV=test BEFORE anything loads src/config/env.js (fail-fast
     production assertions must not fire)
   - Deterministic JWT secret + short DB pool so teardown is clean
   - Uploads to a temp dir so unit tests never touch ./uploads
   ============================================================================ */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-value-that-is-long-enough-32chars';
process.env.JWT_EXPIRES_IN = '1h';
process.env.UPLOAD_LOCAL_DIR = process.env.UPLOAD_LOCAL_DIR || './uploads-test';
process.env.SYNC_CRON_ENABLED = 'false';
process.env.SYNC_STUCK_PROCESSING_MINUTES = '10';
process.env.SYNC_BACKOFF_BASE_SECONDS = process.env.SYNC_BACKOFF_BASE_SECONDS || '30';
// Maintenance jobs off for tests: the scheduler never starts under app.js,
// and these keep any direct env consumers deterministic.
process.env.SWEEP_CRON_ENABLED = 'false';
process.env.RETENTION_CRON_ENABLED = 'false';

// Integration DB defaults (docker-compose.test.yml)
process.env.DB_SERVER = process.env.DB_SERVER || 'localhost';
process.env.DB_PORT = process.env.DB_PORT || '14330';
process.env.DB_NAME = process.env.DB_NAME || 'RenuziOpsDB';
process.env.DB_USER = process.env.DB_USER || 'sa';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'YourStrong@Passw0rd';

module.exports = {};
