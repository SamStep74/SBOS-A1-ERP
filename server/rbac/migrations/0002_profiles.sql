-- 0002_profiles.sql
-- Phase 0.3 — RBAC profiles: reusable role+permission-set bundles that a
-- new user can be assigned in one shot (Salesforce-style profile model).
--
-- The catalog (roles.js, matrix.js) stays in code; profiles are tenant
-- data. Two tables:
--
--   sbos_rbac_profiles       — the bundle definition (id, label, role, PSs)
--   sbos_rbac_user_profile   — which profiles are applied to which users
--
-- The PS list is denormalized as JSON on the profile row, matching how
-- sbos_rbac_roles stores appSet_json. We don't need a 3rd table because
-- a profile always travels as a unit (the set of PSs is part of the
-- profile's identity, not a queryable dimension).
--
-- See server/rbac/profiles.js for the CRUD + apply functions, and
-- server/rbac/routes.js for the admin HTTP surface.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sbos_rbac_profiles (
  id                     TEXT PRIMARY KEY,
  tenant_id              INTEGER NOT NULL DEFAULT 0,
  label                  TEXT NOT NULL,
  description            TEXT NOT NULL DEFAULT '',
  role_id                TEXT NOT NULL,
  -- JSON array of permission_set ids; [] is valid (role-only profile).
  permission_set_ids_json TEXT NOT NULL DEFAULT '[]',
  is_system              INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  created_by             TEXT
);

CREATE INDEX IF NOT EXISTS idx_sbos_rbac_profiles_tenant ON sbos_rbac_profiles(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sbos_rbac_profiles_role   ON sbos_rbac_profiles(tenant_id, role_id);

-- "Profiles applied to users" — the join table. The actual role + PS
-- grants live in sbos_rbac_user_roles and sbos_rbac_user_permission_sets
-- (applyProfile writes both). This table is the bookkeeping needed to
-- answer "which profiles are still on this user?" for deleteProfile's
-- 409 check.
CREATE TABLE IF NOT EXISTS sbos_rbac_user_profile (
  user_id      INTEGER NOT NULL,
  profile_id   TEXT NOT NULL,
  tenant_id    INTEGER NOT NULL,
  applied_at   TEXT NOT NULL DEFAULT (datetime('now')),
  applied_by   INTEGER,
  PRIMARY KEY (tenant_id, user_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_sbos_rbac_user_profile_user    ON sbos_rbac_user_profile(user_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_sbos_rbac_user_profile_profile ON sbos_rbac_user_profile(profile_id);
