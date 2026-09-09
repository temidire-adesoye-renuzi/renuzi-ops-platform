/* ============================================================================
   SERVER BOOTSTRAP
   Loads .env, validates configuration (src/config/env.js - fail-fast on
   insecure production settings), binds the port, starts the cron scheduler
   (Objective 2), and owns graceful shutdown.

   Split from app.js so integration tests can import the app without
   binding a port or starting cron.
   ============================================================================ */

require('dotenv').config();

const { env } = require('./src/config/env');
const app = require('./app');
const { closePool } = require('./src/config/db');
const { startScheduler, stopScheduler } = require('./src/jobs/scheduler');

const PORT = env.port;

const server = app.listen(PORT, () => {
  console.log('============================================================');
  console.log('  RENUZI OPERATIONS PLATFORM - BACKEND SERVER');
  console.log(`  Running on http://localhost:${PORT}`);
  console.log(`  Environment: ${env.nodeEnv}`);
  console.log('============================================================');

  // Objective 2: queue automation
  if (!env.isTest) {
    try {
      startScheduler();
    } catch (err) {
      console.error('[SERVER] Scheduler failed to start:', err.message);
      process.exit(1);
    }
  }
});

async function shutdown(signal) {
  console.log(`\n[SERVER] ${signal} received. Shutting down gracefully...`);
  stopScheduler();
  server.close(async () => {
    console.log('[SERVER] HTTP server closed');
    try {
      await closePool();
    } finally {
      process.exit(0);
    }
  });
  // Force-exit if connections refuse to drain
  setTimeout(() => {
    console.error('[SERVER] Forced shutdown after timeout');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = server;
