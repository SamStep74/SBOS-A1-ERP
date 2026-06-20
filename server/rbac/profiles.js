// SBOS-A1-ERP RBAC Profiles — reusable role+permission-set bundles.
//
// Phase 0.3 of the ERP plan: a profile is a Salesforce-style bundle of
// (one role + N permission sets) that a new user can be assigned in
// one shot via applyProfile(). The catalog (roles.js, matrix.js) stays
// in code; profiles are tenant data stored in sbos_rbac_profiles.
//
// Public API:
//   createProfile(db, profile)   → row
//   getProfile(db, id)           → row | null
//   listProfiles(db)             → row[]
//   applyProfile(db, id, userId) → { role_assigned, ps_assigned: [id, ...] }
//   deleteProfile(db, id)        → void; throws ConflictError if any user
//                                   currently has the profile applied
//
// All money/strings are kept simple — profiles are metadata, not
// accounting data. The PS list is denormalized as JSON on the profile
// row (mirrors how sbos_rbac_roles stores app_set_json). The
// sbos_rbac_user_profile table is bookkeeping for the 409 check in
// deleteProfile.

import { roleExists } from './roles.js';
import { getPermissionSet } from './matrix.js';

// ────────────────────────────────────────────────────────────────────────
// Custom error classes — callers can match by class, not just message.
// ────────────────────────────────────────────────────────────────────────

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
    this.statusCode = 400;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.statusCode = 404;
  }
}

export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictError';
    this.statusCode = 409;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Validation helpers
// ────────────────────────────────────────────────────────────────────────

// Profile id: starts with a letter, then up to 79 more letters / digits /
// underscores. Matches the legacy validateCustomRole regex in roles.js.
const PROFILE_ID_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const MAX_LABEL = 200;

function validateProfileInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValueError('Profile body must be an object');
  }
  const id = String(input.id || '').trim();
  if (!id) {
    throw new ValueError('Profile id is required');
  }
  if (!PROFILE_ID_RE.test(id)) {
    throw new ValueError(
      'Profile id must start with a letter and use letters, digits, underscores (max 80 chars)',
    );
  }
  const label = String(input.label || '').trim();
  if (!label) {
    throw new ValueError('Profile label is required');
  }
  const totalLen = id.length + label.length + String(input.description || '').length;
  if (totalLen > MAX_LABEL) {
    throw new ValueError(`Profile id+label+description total exceeds ${MAX_LABEL} chars`);
  }
  const roleId = String(input.role_id || '').trim();
  if (!roleId) {
    throw new ValueError('Profile role_id is required');
  }
  if (!roleExists(roleId)) {
    throw new ValueError(`Profile role_id references unknown role: ${roleId}`);
  }
  const psIds = Array.isArray(input.permission_set_ids) ? input.permission_set_ids : [];
  for (const psId of psIds) {
    if (typeof psId !== 'string' || !psId) {
      throw new ValueError('Profile permission_set_ids must be an array of strings');
    }
    if (!getPermissionSet(psId)) {
      throw new ValueError(`Profile permission_set_id references unknown PS: ${psId}`);
    }
  }
  // Dedupe PS ids — applyProfile iterates them, no need to write the same
  // grant twice.
  const seen = new Set();
  const dedupedPsIds = [];
  for (const p of psIds) {
    if (!seen.has(p)) {
      seen.add(p);
      dedupedPsIds.push(p);
    }
  }
  return {
    id,
    label,
    description: String(input.description || ''),
    role_id: roleId,
    permission_set_ids: dedupedPsIds,
  };
}

// Row shape returned to callers (camelCase, with parsed permission_set_ids).
function rowToObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    description: row.description,
    role_id: row.role_id,
    permission_set_ids: row.permission_set_ids_json ? JSON.parse(row.permission_set_ids_json) : [],
    tenant_id: row.tenant_id,
    is_system: !!row.is_system,
    created_at: row.created_at,
    created_by: row.created_by,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────

/**
 * Create a new profile.
 *   createProfile(db, {
 *     id, label, description?, role_id, permission_set_ids: [...]
 *   })
 * Throws ValueError on bad input (bad id, unknown role/PS, etc).
 * Throws ValueError on PK collision.
 */
function createProfile(db, input) {
  const v = validateProfileInput(input);
  try {
    db.prepare(
      `INSERT INTO sbos_rbac_profiles
         (id, tenant_id, label, description, role_id, permission_set_ids_json, is_system, created_by)
       VALUES (?, 0, ?, ?, ?, ?, 0, ?)`,
    ).run(
      v.id,
      v.label,
      v.description,
      v.role_id,
      JSON.stringify(v.permission_set_ids),
      input.created_by || null,
    );
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(String(err.message))) {
      throw new ValueError(`Profile id already exists: ${v.id}`);
    }
    throw err;
  }
  return getProfile(db, v.id);
}

/**
 * Fetch a single profile by id, or null if not found.
 */
function getProfile(db, id) {
  if (!id) return null;
  const row = db
    .prepare(
      `SELECT id, tenant_id, label, description, role_id, permission_set_ids_json,
              is_system, created_at, created_by
         FROM sbos_rbac_profiles
        WHERE id = ?`,
    )
    .get(String(id));
  return rowToObject(row);
}

/**
 * List all profiles for the tenant. (Phase 0.3 is single-tenant; the
 * query reads all rows regardless of tenant_id. If/when multi-tenant
 * scoping is added, this is the seam to filter on requester tenant_id.)
 */
function listProfiles(db) {
  const rows = db
    .prepare(
      `SELECT id, tenant_id, label, description, role_id, permission_set_ids_json,
              is_system, created_at, created_by
         FROM sbos_rbac_profiles
        ORDER BY id`,
    )
    .all();
  return rows.map(rowToObject);
}

/**
 * Apply a profile to a user. Idempotent: re-applying the same profile
 * is a no-op (ON CONFLICT DO NOTHING on the user_roles /
 * user_permission_sets / user_profile tables).
 *
 * Returns:
 *   { role_assigned: bool, ps_assigned: [psId, ...] }
 *
 * role_assigned is true only on the first apply (no existing row).
 * ps_assigned lists the PSs that were actually inserted (i.e. those not
 * already present on the user).
 */
function applyProfile(db, profileId, userId) {
  const profile = getProfile(db, profileId);
  if (!profile) {
    throw new NotFoundError(`Profile not found: ${profileId}`);
  }
  const user = db.prepare(`SELECT id, tenant_id FROM users WHERE id = ?`).get(Number(userId));
  if (!user) {
    throw new NotFoundError(`User not found: ${userId}`);
  }
  const tenantId = user.tenant_id || 0;

  // 1) Role grant. INSERT OR IGNORE so re-applies don't error.
  const roleResult = db
    .prepare(
      `INSERT OR IGNORE INTO sbos_rbac_user_roles
         (user_id, role_id, tenant_id, assigned_by)
       VALUES (?, ?, ?, ?)`,
    )
    .run(user.id, profile.role_id, tenantId, user.id);
  const role_assigned = roleResult.changes > 0;

  // 2) PS grants. Same idempotency.
  const ps_assigned = [];
  const psStmt = db.prepare(
    `INSERT OR IGNORE INTO sbos_rbac_user_permission_sets
       (user_id, permission_set_id, tenant_id, granted_by)
     VALUES (?, ?, ?, ?)`,
  );
  for (const psId of profile.permission_set_ids) {
    const r = psStmt.run(user.id, psId, tenantId, user.id);
    if (r.changes > 0) ps_assigned.push(psId);
  }

  // 3) Bookkeeping link. Same idempotency.
  db.prepare(
    `INSERT OR IGNORE INTO sbos_rbac_user_profile
       (user_id, profile_id, tenant_id, applied_by)
     VALUES (?, ?, ?, ?)`,
  ).run(user.id, profile.id, tenantId, user.id);

  return { role_assigned, ps_assigned };
}

/**
 * Delete a profile. Refuses with ConflictError (409) if any user
 * currently has the profile applied.
 */
function deleteProfile(db, profileId) {
  const profile = getProfile(db, profileId);
  if (!profile) {
    throw new NotFoundError(`Profile not found: ${profileId}`);
  }
  const inUse = db
    .prepare(`SELECT COUNT(*) AS c FROM sbos_rbac_user_profile WHERE profile_id = ?`)
    .get(profile.id);
  if (inUse && inUse.c > 0) {
    throw new ConflictError(
      `Profile ${profile.id} is currently applied to ${inUse.c} user(s); revoke it first`,
    );
  }
  db.prepare(`DELETE FROM sbos_rbac_profiles WHERE id = ?`).run(profile.id);
}

export { createProfile, getProfile, listProfiles, applyProfile, deleteProfile };
