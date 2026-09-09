/* ============================================================================
   MIGRATION RUNNER
   Applies database/*.sql in order against the configured DB.
   Idempotent scripts make re-runs safe.
   Usage: npm run migrate   |   node scripts/migrate.js --status
   ============================================================================ */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { executeQuery, closePool } = require('../src/config/db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'database');

async function listMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function runBatch(batch) {
  try {
    await executeQuery(batch);
  } catch (err) {
    // Already-exists errors are tolerated (idempotent scripts assumption)
    if (err && (err.number === 2714 || err.number === 2627 || err.number === 2601)) return;
    throw err;
  }
}

async function apply(script) {
  const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, script), 'utf8');
  const batches = raw.split(/^\s*GO\s*$/im).filter((b) => b.trim().length > 0);
  for (const batch of batches) {
    await runBatch(batch);
  }
}

(async () => {
  const onlyStatus = process.argv.includes('--status');
  try {
    const migrations = await listMigrations();
    if (onlyStatus) {
      console.log('Migrations on disk:');
      migrations.forEach((m) => console.log(`  - ${m}`));
    } else {
      for (const m of migrations) {
        console.log(`Applying ${m} ...`);
        await apply(m);
        console.log(`  done: ${m}`);
      }
      console.log('All migrations applied.');
    }
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
})();
