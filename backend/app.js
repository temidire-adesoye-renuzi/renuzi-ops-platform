/* ============================================================================
   EXPRESS APP ASSEMBLY
   Everything EXCEPT listening: middleware, routes, error handling.
   server.js imports this, binds the port, starts the scheduler, and owns
   the shutdown lifecycle. Supertest imports THIS module directly, so
   integration tests exercise the real app without a port conflict and
   without cron side effects.

   Security posture (TD-5 + Objective 6):
   - helmet security headers, CORS, rate limiting, JSON body limits
   - /api/health is liveness (no DB), /api/ready is readiness (DB ping)
   - global error handler never leaks err.message/err.stack in production
   ============================================================================ */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { env } = require('./src/config/env');
const { ping } = require('./src/config/db');

const app = express();

const authRoutes = require('./src/routes/auth');
const fleetRoutes = require('./src/routes/fleet');
const warehouseRoutes = require('./src/routes/warehouse');
const syncRoutes = require('./src/routes/sync');
const pullRoutes = require('./src/routes/pull');
const dashboardRoutes = require('./src/routes/dashboard');
const uploadRoutes = require('./src/routes/uploads');

/* ---------------------------------------------------------------------------
   Global middleware
   --------------------------------------------------------------------------- */

app.use(helmet());
app.use(cors());

// General API rate limit: 300 req / 5 min / IP
app.use('/api', rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Slow down.' }
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - ${req.ip}`);
  next();
});

/* ---------------------------------------------------------------------------
   Health & readiness
   --------------------------------------------------------------------------- */

// Liveness: process is up (no DB dependency)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Renuzi Ops Platform is running',
    timestamp: new Date().toISOString(),
    version: '2.0.0'
  });
});

// Readiness: can serve traffic (DB reachable)
app.get('/api/ready', async (req, res) => {
  try {
    await ping();
    res.json({ status: 'READY', db: 'connected', timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[READY] DB ping failed:', err.message);
    res.status(503).json({ status: 'NOT_READY', db: 'unreachable', timestamp: new Date().toISOString() });
  }
});

/* ---------------------------------------------------------------------------
   API routes
   --------------------------------------------------------------------------- */

app.use('/api/auth', authRoutes);
app.use('/api/fleet', fleetRoutes);
app.use('/api/warehouse', warehouseRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/pull', pullRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/uploads', uploadRoutes);

/* ---------------------------------------------------------------------------
   404 + error handling
   --------------------------------------------------------------------------- */

app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint not found' });
});

// Global error handler (TD-5: no internal leaks in production)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // multer adds LIMIT_* errors; map them to clean 413s
  if (err && typeof err.name === 'string' && err.name.startsWith('LIMIT_')) {
    return res.status(413).json({ success: false, message: 'File is too large' });
  }

  const status = err.status || 500;

  const publicMessage = err.name === 'HttpError'
    ? err.publicMessage
    : (env.isDev ? err.message : 'Internal server error');

  console.error('ERROR:', status, env.isDev ? err.stack : err.message);

  res.status(status).json({
    success: false,
    message: publicMessage,
    error: env.isDev ? err.stack : undefined
  });
});

module.exports = app;
