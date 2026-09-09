/* ============================================================================
   ROLE-BASED ACCESS CONTROL (RBAC) MIDDLEWARE
   Restricts routes to specific roles.
   Usage: router.get('/manager-only', requireRole(['FLEET_MANAGER', 'OPS_MANAGER']), handler)
   ============================================================================ */

function requireRole(allowedRoles = []) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      console.warn(`[RBAC] Access denied: ${req.user.role} tried to access ${req.originalUrl}`);
      return res.status(403).json({
        success: false,
        message: `Access denied. Required role: ${allowedRoles.join(' or ')}`
      });
    }

    next();
  };
}

const requireAdmin = requireRole(['ADMIN']);
const requireFleetManager = requireRole(['FLEET_MANAGER', 'OPS_MANAGER', 'ADMIN']);
const requireWarehouseManager = requireRole(['WAREHOUSE_MANAGER', 'OPS_MANAGER', 'ADMIN']);
const requireDriver = requireRole(['DRIVER', 'FLEET_MANAGER', 'ADMIN']);
const requireWarehouseStaff = requireRole(['WAREHOUSE_STAFF', 'WAREHOUSE_MANAGER', 'OPS_MANAGER', 'ADMIN']);
const requireAny = requireRole(['DRIVER', 'FLEET_MANAGER', 'WAREHOUSE_MANAGER', 'WAREHOUSE_STAFF', 'OPS_MANAGER', 'SECURITY', 'ADMIN']);
const requireSecurity = requireRole(['SECURITY', 'WAREHOUSE_MANAGER', 'OPS_MANAGER', 'ADMIN']);
const requireOpsOrAdmin = requireRole(['OPS_MANAGER', 'ADMIN', 'FLEET_MANAGER', 'WAREHOUSE_MANAGER']);
const requireFinance = requireRole(['OPS_MANAGER', 'ADMIN', 'FINANCE']);

module.exports = {
  requireRole,
  requireAdmin,
  requireFleetManager,
  requireWarehouseManager,
  requireDriver,
  requireWarehouseStaff,
  requireAny,
  requireSecurity,
  requireOpsOrAdmin,
  requireFinance
};
