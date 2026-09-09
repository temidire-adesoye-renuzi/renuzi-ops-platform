/* ============================================================================
   AUTHENTICATION ROUTES
   POST /api/auth/login           - Driver/Staff login (rate limited)
   POST /api/auth/register        - Admin only: create new users
   GET  /api/auth/me              - Current user profile
   POST /api/auth/change-password - Change own password

   Security notes:
   - Uniform 401 for unknown user vs wrong password (no user enumeration).
   - A dummy bcrypt compare runs when the user is not found so response
     timing is identical in both cases.
   ============================================================================ */

const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { executeQuery } = require('../config/db');
const { authenticateToken, generateToken } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roleCheck');
const { HttpError } = require('../utils/httpError');
const { USER_ROLES } = require('../constants');

// Brute-force protection: 10 attempts / 5 minutes / IP+userId pair
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${(req.body && req.body.userId) || ''}`,
  message: { success: false, message: 'Too many login attempts. Try again in 5 minutes.' }
});

// Pre-computed hash used for timing-equalised "user not found" path
const DUMMY_HASH = bcrypt.hashSync('renuzi-dummy-comparison-value', 10);

router.post('/login', loginLimiter, async (req, res) => {
  const { userId, password, deviceId } = req.body || {};

  if (!userId || !password) {
    return res.status(400).json({
      success: false,
      message: 'User ID and password are required'
    });
  }

  try {
    const result = await executeQuery(
      `SELECT u.user_key, u.user_id, u.full_name, u.email, u.role, u.department,
              u.business_key, u.password_hash, u.is_active, u.license_expiry,
              u.must_change_password,
              b.business_name, b.business_id, b.is_active AS business_is_active
         FROM dim_user u
         JOIN dim_business b ON u.business_key = b.business_key
        WHERE u.user_id = @userId`,
      { userId }
    );

    let user = null;
    let isMatch = false;

    if (result.recordset.length === 0) {
      // TD-5-adjacent hardening: same work as a real compare, same timing
      await bcrypt.compare(password, DUMMY_HASH);
    } else {
      user = result.recordset[0];
      isMatch = await bcrypt.compare(password, user.password_hash);
    }

    if (!user || !isMatch) {
      // Uniform response for unknown user OR wrong password
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    if (!user.is_active) {
      return res.status(403).json({ success: false, message: 'Account deactivated. Contact admin.' });
    }

    if (!user.business_is_active) {
      return res.status(403).json({ success: false, message: 'Business account is inactive.' });
    }

    // Driver license expiry check
    let licenseWarning = null;
    if (user.role === 'DRIVER' && user.license_expiry) {
      const daysUntilExpiry = Math.ceil(
        (new Date(user.license_expiry) - new Date()) / (1000 * 60 * 60 * 24)
      );
      if (daysUntilExpiry < 0) {
        return res.status(403).json({
          success: false,
          message: 'Your driver license has expired. Contact Fleet Manager immediately.'
        });
      }
      if (daysUntilExpiry <= 30) {
        licenseWarning = `Your license expires in ${daysUntilExpiry} days`;
      }
    }

    const token = generateToken(user);

    console.log(`[AUTH] Login success: ${user.user_id} (${user.role}) from device: ${deviceId || 'unknown'}`);

    return res.json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        user: {
          userKey: user.user_key,
          userId: user.user_id,
          fullName: user.full_name,
          email: user.email,
          role: user.role,
          department: user.department,
          businessKey: user.business_key,
          businessName: user.business_name,
          businessId: user.business_id,
          licenseWarning,
          mustChangePassword: Boolean(user.must_change_password)
        }
      }
    });
  } catch (err) {
    console.error('[AUTH] Login error:', err.message);
    return res.status(500).json({ success: false, message: 'Login failed. Please try again later.' });
  }
});

// POST /api/auth/register - Admin only
// Body: { userId, fullName, email, phone, role, department, businessKey, password, licenseNumber?, licenseExpiry? }
router.post('/register', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { userId, fullName, email, phone, role, department, businessKey, password, licenseNumber, licenseExpiry } = req.body || {};

    if (!userId || !fullName || !role || !department || !businessKey || !password) {
      throw new HttpError(400, 'Required fields: userId, fullName, role, department, businessKey, password');
    }

    // L2 fix: reject unknown roles at the boundary instead of persisting a
    // value that would silently break RBAC downstream (requireRole would
    // never match it).
    if (!Object.values(USER_ROLES).includes(role)) {
      throw new HttpError(400, `Invalid role. Valid roles: ${Object.values(USER_ROLES).join(', ')}`);
    }

    // L2 fix: validate businessKey against a live business instead of letting
    // the FK constraint surface as an opaque 500. requireAdmin already
    // guarantees the caller, but a bogus key must fail as a 400.
    const business = await executeQuery(
      'SELECT 1 AS ok FROM dim_business WHERE business_key = @businessKey AND is_active = 1',
      { businessKey }
    );
    if (business.recordset.length === 0) {
      throw new HttpError(400, 'businessKey does not reference an active business');
    }

    // L1 fix: keep the fast existence probe for the common case, but let the
    // UNIQUE(user_id) constraint be the arbiter under concurrency. A 2627
    // (PK/unique violation) is mapped to the intended 409 instead of a 500.
    const existing = await executeQuery(
      'SELECT 1 FROM dim_user WHERE user_id = @userId',
      { userId }
    );
    if (existing.recordset.length > 0) {
      throw new HttpError(409, 'User ID already exists');
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    try {
      await executeQuery(
        `INSERT INTO dim_user (user_id, business_key, full_name, email, phone, role, department,
           license_number, license_expiry, password_hash, is_active)
         VALUES (@userId, @businessKey, @fullName, @email, @phone, @role, @department,
           @licenseNumber, @licenseExpiry, @passwordHash, 1)`,
        {
          userId, businessKey, fullName,
          email: email || null, phone: phone || null,
          role, department,
          licenseNumber: licenseNumber || null,
          licenseExpiry: licenseExpiry || null,
          passwordHash
        }
      );
    } catch (err) {
      // SQL Server unique/PK violation (number 2627 / 2601) -> the same 409
      // the probe returns; the race window between probe and INSERT.
      if (err && (err.number === 2627 || err.number === 2601)) {
        throw new HttpError(409, 'User ID already exists');
      }
      throw err;
    }

    return res.status(201).json({ success: true, message: `User ${userId} created successfully` });
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ success: false, message: err.publicMessage });
    console.error('[AUTH] Registration error:', err.message);
    return res.status(500).json({ success: false, message: 'Registration failed' });
  }
});

// GET /api/auth/me - Current user profile
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const result = await executeQuery(
      `SELECT u.user_key, u.user_id, u.full_name, u.email, u.phone, u.role, u.department,
              u.license_number, u.license_expiry, u.created_at,
              b.business_name, b.business_id, b.region
         FROM dim_user u
         JOIN dim_business b ON u.business_key = b.business_key
        WHERE u.user_key = @userKey`,
      { userKey: req.user.userKey }
    );

    if (result.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    return res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    console.error('[AUTH] Profile error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to fetch profile' });
  }
});

// POST /api/auth/change-password
router.post('/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};

    if (!currentPassword || !newPassword || newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Current password and new password (min 6 chars) required'
      });
    }

    const result = await executeQuery(
      'SELECT password_hash FROM dim_user WHERE user_key = @userKey',
      { userKey: req.user.userKey }
    );

    if (result.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const isMatch = await bcrypt.compare(currentPassword, result.recordset[0].password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    }

    const salt = await bcrypt.genSalt(10);
    const newHash = await bcrypt.hash(newPassword, salt);

    // L4/L5 fix: single GETDATE() so password_changed_at and updated_at can't
    // diverge, and verify rowsAffected so a vanished user row is a 404, not
    // a silent "success".
    const updateResult = await executeQuery(
      `UPDATE dim_user SET
         password_hash = @newHash,
         must_change_password = 0,
         password_changed_at = GETDATE(),
         updated_at = GETDATE()
       WHERE user_key = @userKey`,
      { newHash, userKey: req.user.userKey }
    );

    if ((updateResult.rowsAffected || [0])[0] === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    return res.json({ success: true, message: 'Password changed successfully', data: { rotationCleared: true } });
  } catch (err) {
    console.error('[AUTH] Password change error:', err.message);
    return res.status(500).json({ success: false, message: 'Password change failed' });
  }
});

module.exports = router;
