// SBOS-A1-ERP RBAC Guards
//
// Runtime guards that route handlers use to enforce permissions.
// Two flavors are exported:
//   - Pure functions (framework-agnostic): requirePerm(permKey, ctx) and
//     requireRole(roleName, ctx) return booleans and never throw. They are
//     the canonical entry points and the only ones new code should call.
//   - Throwing functions (legacy): requirePermission(user, permKey) throws
//     on deny. Kept for backward compatibility with Fastify handlers that
//     catch the error and translate to a 403 response.
//
// Adapters live in their own files:
//   - server/rbac/express-adapter.js — wraps the pure functions as Express
//     middleware (req.user → ctx → requirePerm → 401/403 response).
//   - The legacy requirePermFastify below is a thin Fastify preHandler for
//     apps still on the Fastify transport.
//
// Pattern: load the user's effective permission set once per request, then
// call hasPermission / requirePerm cheaply. We also support field-level
// and record-level (row-level) checks for sensitive data.
//
// Field-level security: FLS_RULES maps resource → field → sensitivity
//   (e.g. "viewable only by sensitive-data-readers"). Used to redact fields
//   in API responses.
//
// Record-level security: a row-level policy is a SQL-like predicate fragment
//   that we AND into queries. Built dynamically from RLS_RULES.
//
// MFA gating: the requiresMfa(permKey) helper short-circuits to false on
// ai.agent.*, system.tenant.*, and compliance.* keys unless the session
// has verified MFA. requirePerm respects it automatically.
import { PERMISSIONS, SENSITIVITY } from './permissions.js';
import { ROLES, mfaRequiredFor, sessionHardLimitMinutesFor, canBeImpersonated } from './roles.js';
import { PERMISSION_SETS } from './matrix.js';
import { expandRolePermissions, listForRole, getParentChain } from './roleMatrix.js';
// ───────── Permission resolution cache ─────────
//
// Permission resolution is per-request and inexpensive (Set lookup), but
// we still cache the expanded set keyed on the user identity for repeated
// checks in the same request lifecycle.

function resolveEffectivePermissions(user) {
  if (!user) return new Set();
  if (user._effectivePermissions instanceof Set) return user._effectivePermissions;

  // 1. Get the role's direct permission set list (no chain inheritance for
  //    permission sets — the role chain is reserved for org structure
  //    policies: appSet, MFA, session hard limit, impersonation).
  const ids = new Set();
  for (const ps of listForRole(user.role)) ids.add(ps);

  // 2. Add directly assigned permission sets.
  if (Array.isArray(user.permission_set_ids)) {
    for (const ps of user.permission_set_ids) ids.add(ps);
  }

  // 3. Expand permission set → permission keys.
  const keys = new Set();
  for (const id of ids) {
    const ps = PERMISSION_SETS[id];
    if (!ps) continue;
    for (const k of ps.permissions) keys.add(k);
  }

  // 4. Owner is the super-user and implicitly holds every permission. This
  //    is the ONLY implicit-all shortcut. Admin gets its powers explicitly
  //    through its role matrix (e.g. SystemAdmin PS).
  if (user.role === 'Owner') {
    // rbac-lint: allow-role-check — Owner shortcut
    for (const k of Object.keys(PERMISSIONS)) keys.add(k);
  }
  user._effectivePermissions = keys;
  return keys;
}

function hasPermission(user, permissionKey) {
  if (!user) return false;
  // Safety: if the user is unauthenticated, deny. (Auth middleware should
  // already have rejected before getting here, but defense in depth.)
  if (!user.id) return false;
  const perms = resolveEffectivePermissions(user);
  return perms.has(permissionKey);
}

function hasAnyPermission(user, keys) {
  if (!Array.isArray(keys) || keys.length === 0) return false;
  const perms = resolveEffectivePermissions(user);
  for (const k of keys) if (perms.has(k)) return true;
  return false;
}

function hasAllPermissions(user, keys) {
  if (!Array.isArray(keys) || keys.length === 0) return true;
  const perms = resolveEffectivePermissions(user);
  for (const k of keys) if (!perms.has(k)) return false;
  return true;
}

function requirePermission(user, permissionKey) {
  if (!hasPermission(user, permissionKey)) {
    const err = new Error(`Missing permission: ${permissionKey}`);
    err.statusCode = 403;
    err.code = 'rbac_forbidden';
    err.required = permissionKey;
    throw err;
  }
}

function requireAnyPermission(user, keys) {
  if (!hasAnyPermission(user, keys)) {
    const err = new Error(`Missing required permission: one of ${keys.join(', ')}`);
    err.statusCode = 403;
    err.code = 'rbac_forbidden';
    err.requiredAny = keys;
    throw err;
  }
}

function requireAllPermissions(user, keys) {
  if (!hasAllPermissions(user, keys)) {
    const err = new Error(`Missing required permissions: ${keys.join(', ')}`);
    err.statusCode = 403;
    err.code = 'rbac_forbidden';
    err.requiredAll = keys;
    throw err;
  }
}

// ───────── Sensitivity-aware guards ─────────
//
// If the user holds the permission but the permission is "high" or "critical",
// we may require MFA to be verified in the current session. This is the
// "step-up auth" pattern.

function checkSensitivity(user, permissionKey) {
  if (!user) return { allowed: false, reason: 'no_user' };
  if (!hasPermission(user, permissionKey)) {
    return { allowed: false, reason: 'no_permission' };
  }
  const def = PERMISSIONS[permissionKey];
  if (!def) return { allowed: true }; // unknown permissions can't be gated
  const sens = SENSITIVITY[def.sensitivity];
  if (sens && sens.mfa && user.mfa_required && !user.mfa_verified) {
    return { allowed: false, reason: 'mfa_required', sensitivity: def.sensitivity };
  }
  return { allowed: true };
}

function requirePermissionWithSensitivity(user, permissionKey) {
  const result = checkSensitivity(user, permissionKey);
  if (result.allowed) return;
  const err = new Error(
    result.reason === 'mfa_required'
      ? `MFA required for sensitive action: ${permissionKey}`
      : `Missing permission: ${permissionKey}`,
  );
  err.statusCode = result.reason === 'mfa_required' ? 401 : 403;
  err.code = result.reason === 'mfa_required' ? 'rbac_mfa_required' : 'rbac_forbidden';
  err.required = permissionKey;
  err.sensitivity = result.sensitivity;
  throw err;
}

// ───────── Field-level security (FLS) ─────────
//
// Some fields are sensitive even if the resource is readable. Examples:
//   - finance.bank.account_number
//   - hr.employee.ssn
//   - hr.employee.bank_account
//
// FLS_RULES maps field path → { minPermission: permissionKey, label }.
// Routes that return objects with sensitive fields call redactFields() to
// remove fields the user does not have permission to see.

const FLS_RULES = Object.freeze({
  // Finance
  'finance.bank.account_number': {
    minPermission: 'finance.bank.read',
    label: 'Bank account number',
  },
  'finance.bank.routing': { minPermission: 'finance.bank.read', label: 'Bank routing code' },
  // HR
  'hr.employee.ssn': { minPermission: 'hr.employee.pii.read', label: 'Employee SSN' },
  'hr.employee.bank_account': {
    minPermission: 'hr.employee.pii.read',
    label: 'Employee bank account',
  },
  'hr.employee.medical_notes': {
    minPermission: 'hr.employee.pii.read',
    label: 'Employee medical notes',
  },
  // Customer
  'crm.account.tax_id': { minPermission: 'crm.account.read', label: 'Customer tax ID' },
  // Auth
  'security.user.password_hash': { minPermission: 'security.user.read', label: 'Password hash' },
  'security.user.mfa_secret': { minPermission: 'security.user.read', label: 'MFA secret' },
});

function redactFields(user, obj, fieldPaths) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? obj.map((o) => redactFields(user, o, fieldPaths)) : { ...obj };
  if (Array.isArray(out)) return out;
  for (const path of fieldPaths) {
    const rule = FLS_RULES[path];
    if (!rule) continue;
    if (hasPermission(user, rule.minPermission)) continue;
    // Try the path as a nested traversal first: e.g. crm.account.tax_id →
    // out.crm.account.tax_id. If that doesn't find anything, fall back to
    // the leaf segment as a top-level key, which is the common case when
    // the API returns a flat record (e.g. { tax_id: '...' } instead of
    // { crm: { account: { tax_id: '...' } } }).
    const parts = path.split('.');
    const leaf = parts[parts.length - 1];
    let deleted = false;
    if (Object.prototype.hasOwnProperty.call(out, leaf)) {
      delete out[leaf];
      deleted = true;
    } else {
      let cur = out;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!cur || typeof cur !== 'object') break;
        cur = cur[parts[i]];
      }
      if (cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, leaf)) {
        delete cur[leaf];
        deleted = true;
      }
    }
    // Silently skip paths that don't match the object shape — the caller may
    // be passing paths speculatively.
    void deleted;
  }
  return out;
}

// ───────── Record-level security (RLS) ─────────
//
// RLS scopes which records a user can see. The predicates are ANDed into
// queries that hit the underlying tables.
//
// For now, a simple model:
//   - "own": only records where owner_user_id = current user
//   - "team": only records where owner_user_id is in the user's team
//   - "org": all records in the user's org
//
// Most modules default to "org" with a few exceptions:
//   - portal: tenant_id = current_user.tenant_id
//   - reports/time: "own" by default
//
// RLS_RULES is a list of overrides: { resource, predicate, description }.

const RLS_RULES = Object.freeze([
  { resource: 'crm.lead', defaultScope: 'org', description: 'All org leads visible' },
  { resource: 'crm.deal', defaultScope: 'org', description: 'All org deals visible' },
  { resource: 'crm.quote', defaultScope: 'org', description: 'All org quotes visible' },
  { resource: 'crm.activity', defaultScope: 'own', description: 'Default to own activities' },
  { resource: 'projects.task', defaultScope: 'team', description: "Tasks for the user's team" },
  { resource: 'projects.time', defaultScope: 'own', description: 'Default to own time entries' },
  { resource: 'desk.case', defaultScope: 'org', description: 'All org cases visible' },
  {
    resource: 'hr.employee',
    defaultScope: 'org',
    description: 'HR is org-wide for HR roles, own for self',
  },
  {
    resource: 'hr.payroll',
    defaultScope: 'org',
    description: 'Payroll visible to payroll roles only',
  },
  { resource: 'finance.journal', defaultScope: 'org', description: 'All org journal entries' },
  { resource: 'inv.stock', defaultScope: 'org', description: 'All org stock' },
  { resource: 'purchase.po', defaultScope: 'org', description: 'All org POs' },
  { resource: 'pos.sale', defaultScope: 'org', description: 'All POS sales' },
  {
    resource: 'portal.order',
    defaultScope: 'own',
    description: 'Customer portal: own orders only',
  },
  {
    resource: 'portal.invoice',
    defaultScope: 'own',
    description: 'Customer portal: own invoices only',
  },
  {
    resource: 'portal.ticket',
    defaultScope: 'own',
    description: 'Customer portal: own tickets only',
  },
]);

// Build a SQL WHERE fragment for record-level scope. Returns a clause +
// params you can splice into a SELECT. NULL clause means "no extra filter".
function recordLevelClause(user, resource, opts = {}) {
  const rule = RLS_RULES.find((r) => r.resource === resource);
  const scope = opts.scopeOverride || (rule ? rule.defaultScope : 'org');

  // Owner / Admin see everything across the org.
  if (user.role === 'Owner' || user.role === 'Admin') {
    // rbac-lint: allow-role-check — RLS super-user shortcut
    return { clause: '', params: [] };
  }

  // Portal users are always tenant-scoped.
  if (user.role === 'CustomerPortal' || user.role === 'VendorPortal') {
    // rbac-lint: allow-role-check — RLS portal branch
    return {
      clause: `${resourcePrimaryKey(resource)} IN (SELECT id FROM ${resourceTable(resource)} WHERE tenant_id = ?)`,
      params: [user.tenant_id || user.org_id || 0],
    };
  }

  switch (scope) {
    case 'own': {
      return {
        clause: `owner_user_id = ?`,
        params: [user.id],
      };
    }
    case 'team': {
      return {
        clause: `owner_user_id IN (SELECT member_user_id FROM team_members WHERE team_id IN (SELECT team_id FROM team_members WHERE member_user_id = ?))`,
        params: [user.id],
      };
    }
    case 'org':
    default: {
      return { clause: 'org_id = ?', params: [user.org_id || 0] };
    }
  }
}

function resourcePrimaryKey(resource) {
  // Convention: each resource map to a table whose primary key is "id".
  return 'id';
}
function resourceTable(resource) {
  // Heuristic: strip dots and pluralize crudely. Most A1 tables use
  // snake_case plurals; this is enough for tenant isolation.
  const cleaned = resource.replace(/\./g, '_');
  return cleaned + 's';
}

// ───────── MFA gating by key prefix ─────────
//
// `requiresMfa(permKey)` is the canonical helper for step-up auth decisions.
// It is framework-agnostic (pure function) and used by:
//   - The Express adapter (below) to set mfa_required:true on 401 responses
//   - The route-level requirePerm / requireRole helpers
//   - UI components that show "verify MFA" prompts
//
// The matching rules are: any permission key whose first segment after
// the resource is "agent" (ai.agent.*), or whose first segment is "tenant"
// (system.tenant.*), or whose first segment is "compliance" (compliance.*)
// must require MFA. We also keep the sensitivity-based check (see
// `checkSensitivity`) as a parallel concern — the catalog can tag any
// permission "critical" and that will additionally require MFA.
const MFA_REQUIRED_KEY_PATTERNS = Object.freeze([
  /^ai\.agent\./, // AI agent lifecycle
  /^system\.tenant\./, // Tenant administration
  /^compliance\./, // Compliance / audit / breach
]);

function requiresMfa(permissionKey) {
  if (typeof permissionKey !== 'string' || permissionKey.length === 0) return false;
  for (const re of MFA_REQUIRED_KEY_PATTERNS) {
    if (re.test(permissionKey)) return true;
  }
  // Also respect the catalog's own sensitivity tag — "critical" perms
  // always require MFA. This keeps the helper honest even when a custom
  // permission key was added without updating the regex list.
  const def = PERMISSIONS[permissionKey];
  if (def && def.sensitivity === 'critical') return true;
  return false;
}

// ───────── Framework-agnostic pure-function guards ─────────
//
// `requirePerm(permKey, ctx) => boolean` and `requireRole(roleName, ctx) => boolean`
// are the canonical, framework-agnostic entry points. They:
//   - Short-circuit on missing context (return false, never throw)
//   - Apply role hierarchy (Owner ⊇ Admin ⊇ …) for requireRole
//   - Honor session.impersonation context (impersonator can never widen
//     rights beyond what the actor is entitled to)
//   - Honor the requiresMfa gate: if the perm requires MFA but the session
//     has not verified MFA, the result is `false` with a `{ mfa_required: true }`
//     side-channel on the context, so adapters can render 401 correctly.
//
// `ctx` is a plain object with at least:
//   { user: { id, role, mfa_required, mfa_verified, permission_set_ids, ... } }
// Optional fields: { session, impersonator, resource, action, mfa_required }.
//
// Callers who want the throwing variant (legacy) can still use
// `requirePermission(user, permKey)`. Pure-function callers should treat
// the boolean return as the source of truth and inspect `ctx.outcome` for
// diagnostic detail (deny reason, MFA gate, etc.).

function buildCtx(ctx) {
  // Defensive defaults for the diagnostic fields (mfa_required, outcome)
  // on the caller's ctx. We do NOT mutate the deeply-nested user / session
  // / impersonator objects — we only initialize top-level fields that
  // belong to the RBAC layer itself. The function below then writes the
  // final decision back to these fields on the caller's ctx so adapters
  // can read them.
  const safe = ctx && typeof ctx === 'object' ? ctx : {};
  if (safe.mfa_required === undefined) safe.mfa_required = false;
  if (safe.outcome === undefined) safe.outcome = { allowed: false, reason: 'no_user' };
  return safe;
}

function requirePerm(permissionKey, ctx) {
  const c = buildCtx(ctx);
  if (!c.user || !c.user.id) {
    c.outcome = { allowed: false, reason: 'no_user', permissionKey };
    return false;
  }
  if (!hasPermission(c.user, permissionKey)) {
    c.outcome = { allowed: false, reason: 'no_permission', permissionKey };
    return false;
  }
  // MFA gate: applies to ai.agent.*, system.tenant.*, compliance.*, and
  // any permission tagged "critical" in the catalog.
  if (requiresMfa(permissionKey)) {
    if (c.user.mfa_required && !c.user.mfa_verified) {
      c.mfa_required = true;
      c.outcome = { allowed: false, reason: 'mfa_required', permissionKey };
      return false;
    }
  }
  // Impersonation narrowing: if acting as another user, the actor's
  // effective permissions must also include the perm. The user object
  // already reflects the impersonated role, so we additionally require
  // the impersonator to hold the same perm (no privilege escalation).
  if (c.impersonator && c.impersonator.id) {
    if (!hasPermission(c.impersonator, permissionKey)) {
      c.outcome = { allowed: false, reason: 'impersonation_widens_rights', permissionKey };
      return false;
    }
  }
  c.mfa_required = false;
  c.outcome = { allowed: true, permissionKey };
  return true;
}

// A user satisfies `requireRole(X)` iff the user is at or above X in
// the privilege tree. Concretely: walk X up to its chain of ancestors
// (X, parent(X), ..., Owner); if the user's role appears in that chain,
// the user is at least as privileged as X.
//
// Examples:
//   requireRole('Owner', ownerUser)         → true (owner.role is in chain(Owner) = [Owner])
//   requireRole('Bookkeeper', accountantUser) → true (chain(Bookkeeper) includes Accountant)
//   requireRole('Admin', salesRep)          → false (chain(Admin) = [Admin, Owner]; no SalesRep)
function _userSatisfiesRole(userRole, roleName) {
  if (!userRole || !roleName) return false;
  const chain = getParentChain(roleName);
  return chain.indexOf(userRole) !== -1;
}

function requireRole(roleName, ctx) {
  const c = buildCtx(ctx);
  if (!c.user || !c.user.id) {
    c.outcome = { allowed: false, reason: 'no_user', roleName };
    return false;
  }
  if (!_userSatisfiesRole(c.user.role, roleName)) {
    c.outcome = { allowed: false, reason: 'role_mismatch', roleName, userRole: c.user.role };
    return false;
  }
  // Impersonation: the impersonator must also satisfy the role check
  // (i.e. an Admin impersonating a FinanceLead cannot be granted Owner
  // rights by the impersonation).
  if (c.impersonator && c.impersonator.id) {
    if (!_userSatisfiesRole(c.impersonator.role, roleName)) {
      c.outcome = { allowed: false, reason: 'impersonation_widens_role', roleName };
      return false;
    }
  }
  c.outcome = { allowed: true, roleName };
  return true;
}

// ───────── High-level guard helpers for Fastify preHandlers ─────────
//
// A Fastify route uses:
//   app.post("/api/invoices", { preHandler: requirePerm("finance.invoice.create") }, handler);

function requirePermFastify(permissionKey) {
  return async function rbacPreHandler(request, reply) {
    const ctx = {
      user: request.user,
      session: request.session,
      impersonator: request.impersonator,
    };
    const ok = requirePerm(permissionKey, ctx);
    if (ok) return;
    if (ctx.mfa_required) {
      reply.code(401).send({
        error: 'rbac_mfa_required',
        message: `MFA required for sensitive action: ${permissionKey}`,
        required: permissionKey,
      });
      return;
    }
    reply.code(403).send({
      error: 'rbac_forbidden',
      message: `Missing permission: ${permissionKey}`,
      required: permissionKey,
      reason: ctx.outcome && ctx.outcome.reason,
    });
  };
}

function requireAnyPerm(permissionKeys) {
  return async function rbacPreHandler(request, reply) {
    try {
      requireAnyPermission(request.user, permissionKeys);
    } catch (err) {
      reply.code(err.statusCode || 403).send({
        error: 'rbac_forbidden',
        message: err.message,
        requiredAny: err.requiredAny,
      });
    }
  };
}

// Enforce role-level MFA + session hard limits on a request.
// Returns true if the session is fine; otherwise throws.
function enforceSessionPolicy(user, session) {
  if (!user) throw Object.assign(new Error('Unauthenticated'), { statusCode: 401 });
  if (mfaRequiredFor(user.role) && !user.mfa_verified && session?.mfa_factor) {
    const err = new Error('MFA required');
    err.statusCode = 401;
    err.code = 'mfa_required';
    throw err;
  }
  const hardLimit = sessionHardLimitMinutesFor(user.role);
  if (session && session.created_at) {
    const ageMin = (Date.now() - new Date(session.created_at).getTime()) / 60000;
    if (ageMin > hardLimit) {
      const err = new Error('Session exceeded hard limit');
      err.statusCode = 401;
      err.code = 'session_hard_limit';
      err.hardLimitMinutes = hardLimit;
      throw err;
    }
  }
}

// Impersonation: who can be impersonated by whom?
function canImpersonate(actor, target) {
  if (!actor || !target) return false;
  if (actor.id === target.id) return false;
  // Only Owner and Admin can impersonate.
  if (!['Owner', 'Admin'].includes(actor.role)) return false;
  // Cannot impersonate other Owner/Admin unless actor is Owner.
  if (['Owner', 'Admin'].includes(target.role) && actor.role !== 'Owner') return false;
  // Target must allow impersonation.
  if (!canBeImpersonated(target.role)) return false;
  return true;
}

export {
  // Resolution
  resolveEffectivePermissions,
  // Permission checks (legacy throwing variants)
  hasPermission,
  hasAnyPermission,
  hasAllPermissions,
  requirePermission,
  requireAnyPermission,
  requireAllPermissions,
  checkSensitivity,
  requirePermissionWithSensitivity,
  // Pure-function guards (framework-agnostic)
  requirePerm,
  requireRole,
  requiresMfa,
  // Field / Record security
  FLS_RULES,
  redactFields,
  RLS_RULES,
  recordLevelClause,
  // Fastify preHandlers
  requirePermFastify,
  requireAnyPerm,
  // Session / impersonation
  enforceSessionPolicy,
  canImpersonate,
  // Re-exports for convenience
  expandRolePermissions,
};
