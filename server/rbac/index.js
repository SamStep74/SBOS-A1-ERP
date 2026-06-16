// SBOS-A1-ERP RBAC Module Index
//
// Public entry point for the RBAC system. Pulls the catalogs, the runtime
// guards, the seed installer, and the admin routes into a single import.
//
// Usage:
//   const rbac = require('./rbac');
//   rbac.install(app, { db });   // registers routes + seeds the DB
//
// Or, in a custom boot sequence:
//   const { seedRBAC, hasPermission, requirePerm, registerRbacRoutes } = rbac;
//   await seedRBAC(db);
//   registerRbacRoutes(app, { db });

'use strict';

const {
  PERMISSIONS, CATEGORIES, SENSITIVITY,
  byCategory, isValidKey, getDefinition, listKeys, requireKey,
  PERMISSIONS_VERSION,
} = require('./permissions');

const {
  ROLES, APPS, APP_PRESETS, ROLES_VERSION, DEFAULT_INVITED_ROLE,
  isSystemRole, getRole, listRoleIds, roleExists,
  getAppSet, getParentChain, getEffectiveAppSet,
  mfaRequiredFor, sessionHardLimitMinutesFor, canBeImpersonated,
  validateCustomRole,
} = require('./roles');

const {
  PERMISSION_SETS, PERMISSION_SETS_VERSION,
  listPermissionSetIds, getPermissionSet, isSystemPermissionSet,
} = require('./matrix');

const {
  ROLE_MATRIX, listForRole, getDefaultPermissionSetIds, expandPermissionKeys, expandRolePermissions,
} = require('./roleMatrix');

const guards = require('./guards');

const { seedRBAC, readVersions } = require('./seed');
const { registerRbacRoutes } = require('./routes');

// One-shot installer: seeds the DB and registers admin routes.
function install(app, opts = {}) {
  const db = opts.db || app.db;
  if (!db) throw new Error('rbac.install requires a db (opts.db or app.db)');

  // Skip if already seeded at the same versions.
  const existing = readVersions(db);
  const needsSeed =
    Number(existing.permissions_version || 0) < PERMISSIONS_VERSION ||
    Number(existing.roles_version || 0) < ROLES_VERSION ||
    Number(existing.permission_sets_version || 0) < PERMISSION_SETS_VERSION ||
    Number(existing.schema_version || 0) < 1;

  if (needsSeed) {
    seedRBAC(db);
  }

  registerRbacRoutes(app, { db });
  return { ok: true, seeded: needsSeed };
}

module.exports = {
  // catalogs
  PERMISSIONS, CATEGORIES, SENSITIVITY, PERMISSIONS_VERSION,
  ROLES, APPS, APP_PRESETS, ROLES_VERSION, DEFAULT_INVITED_ROLE,
  PERMISSION_SETS, PERMISSION_SETS_VERSION,
  ROLE_MATRIX,
  // catalog helpers
  byCategory, isValidKey, getDefinition, listKeys, requireKey,
  isSystemRole, getRole, listRoleIds, roleExists,
  getAppSet, getParentChain, getEffectiveAppSet,
  mfaRequiredFor, sessionHardLimitMinutesFor, canBeImpersonated, validateCustomRole,
  listPermissionSetIds, getPermissionSet, isSystemPermissionSet,
  listForRole, getDefaultPermissionSetIds, expandPermissionKeys, expandRolePermissions,
  // runtime
  ...guards,
  // lifecycle
  seedRBAC, readVersions, registerRbacRoutes, install,
};
