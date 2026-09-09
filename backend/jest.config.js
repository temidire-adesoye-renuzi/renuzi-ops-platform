/* ============================================================================
   JEST CONFIGURATION
   Two projects:
   - unit:        pure logic tests (no DB) - fast, run first
   - integration: supertest against app.js + real SQL Server (Docker)

   Integration tests expect the MSSQL container from docker-compose.test.yml
   (see tests/helpers/dbTestHelper.js which validates connectivity and skips
   with a clear message when the container is absent).
   ============================================================================ */

module.exports = {
  testTimeout: 30000,
  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      roots: ['<rootDir>/tests/unit'],
      setupFiles: ['<rootDir>/tests/setup.js']
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      roots: ['<rootDir>/tests/integration'],
      setupFiles: ['<rootDir>/tests/setup.js']
    }
  ]
};
