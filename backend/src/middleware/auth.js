/* ============================================================================
   AUTHENTICATION MIDDLEWARE
   Verifies JWT token from the Authorization header, then re-checks the
   user in the database so deactivated users lose access immediately.

   Objective 6 (password rotation remediation): when a user's
   must_change_password flag is set (forced by migration 04 for every seed
   user with a known default password), every authenticated request EXCEPT
   the password change itself returns 403 with a machine-readable
   PASSWORD_ROTATION_REQUIRED code. The mobile/web client then forces the
   rotation screen. Login explicitly warns via the response payload.
   ============================================================================ */

const jwt = require('jsonwebtoken');
const { executeQuery } = require('../config/db');
const { env } = require('../config/env');

async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Access denied. No token provided.'
    });
  }

  try {
    const decoded = jwt.verify(token, env.jwt.secret);

    const result = await executeQuery(
      `SELECT u.user_key, u.user_id, u.full_name, u.email, u.role, u.department,
              u.business_key, u.is_active, u.must_change_password,
              b.business_id, b.is_active AS business_is_active
         FROM dim_user u
         JOIN dim_business b ON u.business_key = b.business_key
        WHERE u.user_key = @userKey`,
      { userKey: decoded.userKey }
    );

    if (result.recordset.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }

    const user = result.recordset[0];
    if (!user.is_active) {
      return res.status(403).json({ success: false, message: 'Account deactivated' });
    }

    req.user = {
      userKey: user.user_key,
      userId: user.user_id,
      fullName: user.full_name,
      email: user.email,
      role: user.role,
      department: user.department,
      businessKey: user.business_key,
      businessId: user.business_id,
      mustChangePassword: Boolean(user.must_change_password)
    };

    // Forced rotation gate: everything except the password change is blocked.
    const isPasswordChange = req.method === 'POST' && /\/api\/auth\/change-password\/?$/.test(req.originalUrl || req.url || '');
    if (req.user.mustChangePassword && !isPasswordChange) {
      return res.status(403).json({
        success: false,
        code: 'PASSWORD_ROTATION_REQUIRED',
        message: 'Password rotation required. Change your password before using the API.'
      });
    }

    next();
  } catch (err) {
    console.error('[AUTH] Token verification failed:', err.message);
    return res.status(403).json({ success: false, message: 'Invalid or expired token' });
  }
}

function generateToken(user) {
  return jwt.sign(
    {
      userKey: user.user_key,
      userId: user.user_id,
      role: user.role,
      businessKey: user.business_key
    },
    env.jwt.secret,
    { expiresIn: env.jwt.expiresIn }
  );
}

module.exports = { authenticateToken, generateToken };
