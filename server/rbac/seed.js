// SBOS-A1-ERP RBAC Seed Installer
//
// Loads the in-code catalogs (permissions, roles, permission sets, role matrix)
// into the DB so admins can manage them through the UI. Idempotent.
//
// Usage:
//   const { seedRBAC } = require('./seed');
//   await seedRBAC(db);            // safe to call on every boot
//   await seedRBAC(db, { force: true });  // blow away + re-seed (DANGEROUS)

'use strict';

const {
  PERMISSIONS, PERMISSIONS_VERSION, listKeys, getDefinition,
} = require('./permissions');
const { ROLES, ROLES_VERSION, APPS } = require('./roles');
const { PERMISSION_SETS, PERMISSION_SETS_VERSION } = require('./matrix');
const { ROLE_MATRIX } = require('./roleMatrix');

// SQL helpers that work against better-sqlite3 (most common in A1) and
// node:sqlite. We use positional placeholders; both drivers accept that.
function isSqliteDb(db) {
  return db && (typeof db.prepare === 'function' || typeof db.exec === 'function');
}

function runInTx(db, fn) {
  if (typeof db.transaction === 'function') {
    return db.transaction(fn)();
  }
  if (typeof db.beginTransaction === 'function') {
    db.beginTransaction();
    try { const r = fn(); db.commitTransaction && db.commitTransaction(); return r; }
    catch (e) { db.rollbackTransaction && db.rollbackTransaction(); throw e; }
  }
  // Fallback: run outside a transaction (drivers without tx support).
  return fn();
}

async function seedPermissions(db) {
  const stmt = db.prepare(`
    INSERT INTO sbos_rbac_permissions (key, tenant_id, category, sensitivity, label, description, is_system, updated_at)
    VALUES (?, 0, ?, ?, ?, ?, 1, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      category = excluded.category,
      sensitivity = excluded.sensitivity,
      label = excluded.label,
      description = excluded.description
  `);
  for (const key of listKeys()) {
    const def = getDefinition(key);
    stmt.run(key, def.category, def.sensitivity, def.label, def.description);
  }
  db.prepare(`UPDATE sbos_rbac_meta SET value = ?, updated_at = datetime('now') WHERE key = 'permissions_version'`)
    .run(String(PERMISSIONS_VERSION));
}

async function seedRoles(db) {
  const stmt = db.prepare(`
    INSERT INTO sbos_rbac_roles (
      id, tenant_id, label, description, parent, is_system,
      app_set_json, mfa_required, session_hard_limit_minutes, can_be_impersonated, updated_at
    )
    VALUES (?, 0, ?, ?, ?, 1, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      description = excluded.description,
      parent = excluded.parent,
      app_set_json = excluded.app_set_json,
      mfa_required = excluded.mfa_required,
      session_hard_limit_minutes = excluded.session_hard_limit_minutes,
      can_be_impersonated = excluded.can_be_impersonated
  `);
  for (const role of Object.values(ROLES)) {
    stmt.run(
      role.id,
      role.label,
      role.description,
      role.parent,
      JSON.stringify(role.appSet),
      role.mfaRequired ? 1 : 0,
      role.sessionHardLimitMinutes,
      role.canBeImpersonated ? 1 : 0,
    );
  }
  db.prepare(`UPDATE sbos_rbac_meta SET value = ?, updated_at = datetime('now') WHERE key = 'roles_version'`)
    .run(String(ROLES_VERSION));
}

async function seedPermissionSets(db) {
  const psStmt = db.prepare(`
    INSERT INTO sbos_rbac_permission_sets (id, tenant_id, label, description, is_system, updated_at)
    VALUES (?, 0, ?, ?, 1, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      description = excluded.description
  `);
  for (const ps of Object.values(PERMISSION_SETS)) {
    psStmt.run(ps.id, ps.label, ps.description);
  }
  db.prepare(`UPDATE sbos_rbac_meta SET value = ?, updated_at = datetime('now') WHERE key = 'permission_sets_version'`)
    .run(String(PERMISSION_SETS_VERSION));

  // Members
  const memberStmt = db.prepare(`
    INSERT INTO sbos_rbac_permission_set_members (permission_set_id, permission_key, tenant_id)
    VALUES (?, ?, 0)
    ON CONFLICT(tenant_id, permission_set_id, permission_key) DO NOTHING
  `);
  for (const ps of Object.values(PERMISSION_SETS)) {
    for (const key of ps.permissions) {
      memberStmt.run(ps.id, key);
    }
  }
}

async function seedRolePermissionSets(db) {
  const stmt = db.prepare(`
    INSERT INTO sbos_rbac_role_permission_sets (role_id, permission_set_id, tenant_id)
    VALUES (?, ?, 0)
    ON CONFLICT(tenant_id, role_id, permission_set_id) DO NOTHING
  `);
  for (const [roleId, psList] of Object.entries(ROLE_MATRIX)) {
    for (const ps of psList) stmt.run(roleId, ps);
  }
}

async function runMigrations(db) {
  // Apply schema. Split on `;` to get individual statements (SQLite is OK
  // with multi-statement exec). We strip comments first to avoid issues.
  const fs = require('fs');
  const path = require('path');
  const schemaPath = path.join(__dirname, 'schema.sql');
  const raw = fs.readFileSync(schemaPath, 'utf8');

  // Strip single-line `--` comments but preserve newlines for safety.
  const cleaned = raw
    .replace(/^\s*--.*$/gm, '')
    .replace(/\r\n/g, '\n');

  // SQLite: each statement must end with a `;` and not contain a `;` inside
  // a string literal. The schema file is hand-written and safe; this splitter
  // is good enough.
  const statements = cleaned
    .split(/;\s*\n/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (const sql of statements) {
    try {
      db.exec(sql);
    } catch (err) {
      // "duplicate column name" is fine on re-run; surface the rest.
      if (!/duplicate column|already exists/i.test(String(err.message))) {
        throw err;
      }
    }
  }
}

async function seedRBAC(db, opts = {}) {
  if (!isSqliteDb(db)) {
    throw new Error('seedRBAC: db must be a sqlite-compatible instance with .prepare/.exec');
  }
  if (opts.force) {
    // Optional destructive reseed. We don't drop core tables — we just clear
    // system-scoped rows so the catalog can be reinserted. Tenant-scoped
    // rows are preserved.
    db.exec(`
      DELETE FROM sbos_rbac_permission_set_members WHERE tenant_id = 0;
      DELETE FROM sbos_rbac_permission_sets WHERE tenant_id = 0;
      DELETE FROM sbos_rbac_role_permission_sets WHERE tenant_id = 0;
      DELETE FROM sbos_rbac_roles WHERE tenant_id = 0;
      DELETE FROM sbos_rbac_permissions WHERE tenant_id = 0;
    `);
  }

  return runInTx(db, () => {
    runMigrations(db);
    seedPermissions(db);
    seedRoles(db);
    seedPermissionSets(db);
    seedRolePermissionSets(db);
    return {
      permissions_seeded: listKeys().length,
      roles_seeded: Object.keys(ROLES).length,
      permission_sets_seeded: Object.keys(PERMISSION_SETS).length,
      role_default_links_seeded: Object.values(ROLE_MATRIX).reduce((a, b) => a + b.length, 0),
      versions: {
        permissions: PERMISSIONS_VERSION,
        roles: ROLES_VERSION,
        permission_sets: PERMISSION_SETS_VERSION,
      },
    };
  });
}

// Quick health check: returns the catalog versions stored in the DB.
function readVersions(db) {
  const rows = db.prepare(`SELECT key, value FROM sbos_rbac_meta`).all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

module.exports = { seedRBAC, readVersions, runMigrations };
