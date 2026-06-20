// SBOS-A1-ERP RBAC Express Adapter
//
// Thin wrapper that converts the pure-function guards (requirePerm / requireRole)
// into Express middleware. The core RBAC module is framework-agnostic; this
// file is the only place that knows about Express req/res semantics.
//
// Usage:
//   const { requirePerm, requireRole } = require('./rbac/express-adapter');
//   app.post('/api/invoices',
//     authenticate,
//     requirePerm('finance.invoice.create'),
//     createInvoiceHandler
//   );
//
//   app.get('/api/admin',
//     authenticate,
//     requireRole('Admin'),
//     adminHandler
//   );
//
// The middleware expects `req.user` to be populated by an upstream
// authenticate middleware. If not, it 401s. If the user lacks the permission
// (or role), it 403s. If the permission requires MFA and the session has
// not verified MFA, it 401s with code `rbac_mfa_required` and the client
// should re-prompt for MFA and retry.
//
// No side effects beyond setting `req.rbac` (the diagnostic ctx) and
// calling next() / res.status(...).json(...). No eval, no Function().
import { requirePerm as rbacRequirePerm, requireRole as rbacRequireRole } from './guards.js';
// Internal: extract a context object from the Express request.
function ctxFromReq(req) {
  return {
    user: req && req.user ? req.user : null,
    session: req && req.session ? req.session : null,
    impersonator: req && req.impersonator ? req.impersonator : null,
  };
}

// Express middleware factory: requirePerm(permissionKey)
//   - 401 if no user
//   - 401 with rbac_mfa_required if perm requires MFA and not verified
//   - 403 if user lacks the permission
//   - next() on success, with req.rbac populated for the handler
function requirePerm(permissionKey) {
  if (typeof permissionKey !== 'string' || permissionKey.length === 0) {
    throw new TypeError('requirePerm(permissionKey): permissionKey must be a non-empty string');
  }
  return function rbacPermMiddleware(req, res, next) {
    const ctx = ctxFromReq(req);
    const ok = rbacRequirePerm(permissionKey, ctx);
    req.rbac = ctx;
    if (ok) return next();
    if (ctx.mfa_required) {
      return res.status(401).json({
        error: 'rbac_mfa_required',
        message: `MFA required for sensitive action: ${permissionKey}`,
        required: permissionKey,
      });
    }
    if (!ctx.user || !ctx.user.id) {
      return res.status(401).json({
        error: 'unauthenticated',
        message: 'Authentication required',
      });
    }
    return res.status(403).json({
      error: 'rbac_forbidden',
      message: `Missing permission: ${permissionKey}`,
      required: permissionKey,
      reason: ctx.outcome && ctx.outcome.reason,
    });
  };
}

// Express middleware factory: requireRole(roleName)
//   - 401 if no user
//   - 403 if the user's role (via parent chain) does not include roleName
//   - next() on success
function requireRole(roleName) {
  if (typeof roleName !== 'string' || roleName.length === 0) {
    throw new TypeError('requireRole(roleName): roleName must be a non-empty string');
  }
  return function rbacRoleMiddleware(req, res, next) {
    const ctx = ctxFromReq(req);
    const ok = rbacRequireRole(roleName, ctx);
    req.rbac = ctx;
    if (ok) return next();
    if (!ctx.user || !ctx.user.id) {
      return res.status(401).json({
        error: 'unauthenticated',
        message: 'Authentication required',
        requiredRole: roleName,
      });
    }
    return res.status(403).json({
      error: 'rbac_forbidden',
      message: `Missing role: ${roleName}`,
      requiredRole: roleName,
      userRole: ctx.user && ctx.user.role,
      reason: ctx.outcome && ctx.outcome.reason,
    });
  };
}

export {requirePerm,
  requireRole,};