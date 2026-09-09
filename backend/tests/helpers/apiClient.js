/* ============================================================================
   API CLIENT TEST HELPER
   Supertest bound to app.js (no port, no scheduler) plus auth login.
   Seed credentials come from 01_create_database.sql; the helper rotates
   must_change_password off when a test needs a fully-unblocked token.
   ============================================================================ */

const request = require('supertest');
const app = require('../../app');
const { executeQuery } = require('../../src/config/db');

const SEED_USERS = {
  driver: { userId: 'DRV-001', password: 'Driver@123' },
  warehouseManager: { userId: 'WH-MGR-001', password: 'Warehouse@123' },
  fleetManager: { userId: 'FLEET-MGR-001', password: 'Fleet@123' },
  admin: { userId: 'ADMIN-001', password: 'Admin@123' }
};

/** Login and return { token, user }. Returns response body on failure. */
async function login(which = 'admin') {
  const creds = SEED_USERS[which];
  const res = await request(app)
    .post('/api/auth/login')
    .send({ userId: creds.userId, password: creds.password });
  if (res.status !== 200) {
    throw new Error(`Login failed for ${which}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data;
}

/** Convenience: authenticated agent bound to a business user. */
function authed(token) {
  return {
    get: (url) => request(app).get(url).set('Authorization', `Bearer ${token}`),
    post: (url) => request(app).post(url).set('Authorization', `Bearer ${token}`),
    put: (url) => request(app).put(url).set('Authorization', `Bearer ${token}`)
  };
}

/** Ensure none of the seed users is blocked by the rotation gate. */
async function clearRotationFlags() {
  await executeQuery('UPDATE dim_user SET must_change_password = 0');
}

module.exports = { app, request, login, authed, SEED_USERS, clearRotationFlags };
