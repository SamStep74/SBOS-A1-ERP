-- SBOS-A1-ERP RBAC Schema
-- ----------------------------------------------------------------------------
-- Catalog-driven RBAC. Mirrors the in-code catalogs in server/rbac/*.js so
-- that admins can view, audit, and override defaults through the UI without
-- redeploying the server.
--
-- All tables are namespaced under the `sbos_rbac` schema prefix so that this
-- subsystem is the first domain-agnostic module in SBOS-A1-ERP and lives
-- cleanly alongside other domain modules (finance, crm, inventory, etc.).
--
-- Conventions:
--   - All IDs are TEXT (named IDs make joins greppable in logs).
--   - tenant_id scopes every row (zero = global/system). Multi-tenant RBAC.
--   - system flag on rows that come from the bundled catalog. Tenant rows
--     override system rows by primary key in the same tenant scope.
--   - audit columns on every table (created_at, updated_at, created_by).
--   - effective permissions are NOT stored — they are computed from
--     (role + permission sets + tenant overrides) on every request.
--   - Only direct user→permission_set grants and audit rows are stored.
--
-- This schema is idempotent: re-running on an existing DB is a no-op.
-- ----------------------------------------------------------------------------

PRAGMA foreign_keys = ON;

-- ───────────── Roles ─────────────

CREATE TABLE IF NOT EXISTS sbos_rbac_roles (
  id              TEXT PRIMARY KEY,            -- "Owner", "FinanceLead", "Accountant", or custom
  tenant_id       INTEGER NOT NULL DEFAULT 0,  -- 0 = system row, otherwise tenant-scoped
  label           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  parent          TEXT,                        -- FK self; NULL = top
  is_system       INTEGER NOT NULL DEFAULT 0,  -- 1 = bundled, 0 = custom
  app_set_json    TEXT NOT NULL DEFAULT '[]',  -- JSON array of app IDs
  mfa_required    INTEGER NOT NULL DEFAULT 0,
  session_hard_limit_minutes INTEGER NOT NULL DEFAULT 480,
  can_be_impersonated INTEGER NOT NULL DEFAULT 1,
  archived_at     TEXT,                        -- soft delete
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  created_by      TEXT
);

CREATE INDEX IF NOT EXISTS idx_sbos_rbac_roles_tenant ON sbos_rbac_roles(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sbos_rbac_roles_parent ON sbos_rbac_roles(parent);

-- Role default permission sets: which PSs a user with this role gets for free.
-- Both system and custom roles have rows here. The bundled seed inserts them.
CREATE TABLE IF NOT EXISTS sbos_rbac_role_permission_sets (
  role_id          TEXT NOT NULL,
  permission_set_id TEXT NOT NULL,
  tenant_id        INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, role_id, permission_set_id)
);

CREATE INDEX IF NOT EXISTS idx_sbos_rbac_rps_role ON sbos_rbac_role_permission_sets(role_id);
CREATE INDEX IF NOT EXISTS idx_sbos_rbac_rps_set  ON sbos_rbac_role_permission_sets(permission_set_id);

-- ───────────── Permissions ─────────────

CREATE TABLE IF NOT EXISTS sbos_rbac_permissions (
  key            TEXT PRIMARY KEY,            -- e.g. "finance.invoice.create"
  tenant_id      INTEGER NOT NULL DEFAULT 0,
  category       TEXT NOT NULL,               -- FK-ish to CATEGORIES
  sensitivity    TEXT NOT NULL,               -- low | medium | high | critical
  label          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  is_system      INTEGER NOT NULL DEFAULT 1,
  archived_at    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sbos_rbac_perm_category ON sbos_rbac_permissions(category);
CREATE INDEX IF NOT EXISTS idx_sbos_rbac_perm_tenant ON sbos_rbac_permissions(tenant_id);

-- ───────────── Permission sets ─────────────

CREATE TABLE IF NOT EXISTS sbos_rbac_permission_sets (
  id           TEXT PRIMARY KEY,              -- e.g. "FinanceOperator", "Approver"
  tenant_id    INTEGER NOT NULL DEFAULT 0,
  label        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  is_system    INTEGER NOT NULL DEFAULT 1,
  archived_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  created_by   TEXT
);

CREATE INDEX IF NOT EXISTS idx_sbos_rbac_ps_tenant ON sbos_rbac_permission_sets(tenant_id);

-- Members of a permission set. Frozen at creation in code; UI may add/remove
-- within a tenant.
CREATE TABLE IF NOT EXISTS sbos_rbac_permission_set_members (
  permission_set_id TEXT NOT NULL,
  permission_key    TEXT NOT NULL,
  tenant_id         INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, permission_set_id, permission_key)
);

CREATE INDEX IF NOT EXISTS idx_sbos_rbac_psm_set ON sbos_rbac_permission_set_members(permission_set_id);
CREATE INDEX IF NOT EXISTS idx_sbos_rbac_psm_key ON sbos_rbac_permission_set_members(permission_key);

-- ───────────── User direct assignments ─────────────

-- Direct user → permission set grants (in addition to role defaults).
CREATE TABLE IF NOT EXISTS sbos_rbac_user_permission_sets (
  user_id           INTEGER NOT NULL,
  permission_set_id TEXT NOT NULL,
  tenant_id         INTEGER NOT NULL,
  granted_at        TEXT NOT NULL DEFAULT (datetime('now')),
  granted_by        INTEGER,
  expires_at        TEXT,                    -- optional time-bound grants
  PRIMARY KEY (tenant_id, user_id, permission_set_id)
);

CREATE INDEX IF NOT EXISTS idx_sbos_rbac_ups_user ON sbos_rbac_user_permission_sets(user_id);

-- User → role (one role per user per tenant; assignments table for history).
CREATE TABLE IF NOT EXISTS sbos_rbac_user_roles (
  user_id     INTEGER NOT NULL,
  role_id     TEXT NOT NULL,
  tenant_id   INTEGER NOT NULL,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  assigned_by INTEGER,
  PRIMARY KEY (tenant_id, user_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_sbos_rbac_ur_role ON sbos_rbac_user_roles(role_id);

-- ───────────── Field-Level Security (FLS) overrides ─────────────

-- Tenant-overridable FLS rules. Built-in rules live in code; if a row exists
-- in this table, the row wins for that tenant.
CREATE TABLE IF NOT EXISTS sbos_rbac_field_policies (
  field_path      TEXT NOT NULL,              -- e.g. "hr.employee.ssn"
  tenant_id       INTEGER NOT NULL DEFAULT 0,
  min_permission  TEXT NOT NULL,
  is_visible      INTEGER NOT NULL DEFAULT 1, -- 0 = hidden, 1 = visible
  label           TEXT NOT NULL DEFAULT '',
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by      INTEGER,
  PRIMARY KEY (tenant_id, field_path)
);

-- ───────────── Record-Level Security (RLS) overrides ─────────────

-- A row in this table overrides the defaultScope for a (tenant, resource).
-- scope: "own" | "team" | "org" | "custom"
-- predicate: optional SQL fragment for custom scopes
CREATE TABLE IF NOT EXISTS sbos_rbac_record_rules (
  resource      TEXT NOT NULL,                -- e.g. "crm.lead"
  tenant_id     INTEGER NOT NULL DEFAULT 0,
  scope         TEXT NOT NULL,                -- "own" | "team" | "org" | "custom"
  predicate     TEXT,                         -- SQL fragment when scope = "custom"
  description   TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by    INTEGER,
  PRIMARY KEY (tenant_id, resource)
);

-- ───────────── Sessions (governance) ─────────────

-- Track last-N sessions per user with their effective permission set snapshot.
-- Used for audit + for hard-limit enforcement.
CREATE TABLE IF NOT EXISTS sbos_rbac_sessions (
  id              TEXT PRIMARY KEY,           -- random token / JWT id
  user_id         INTEGER NOT NULL,
  tenant_id       INTEGER NOT NULL,
  role_id         TEXT NOT NULL,
  permission_set_ids_json TEXT NOT NULL,      -- resolved PS list
  effective_permissions_json TEXT NOT NULL,   -- resolved permission keys
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT NOT NULL,
  ip              TEXT,
  user_agent      TEXT,
  mfa_factor      TEXT,                        -- "totp" | "webauthn" | null
  mfa_verified_at TEXT,
  impersonator_id INTEGER,                    -- set when impersonation is in use
  revoked_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_sbos_rbac_sess_user ON sbos_rbac_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sbos_rbac_sess_tenant ON sbos_rbac_sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sbos_rbac_sess_active ON sbos_rbac_sessions(revoked_at, expires_at);

-- Wave 55: per-session activity log. Lifecycle events
-- (login, logout, revoked) — see server/rbac/migrations/0003_session_events.sql
-- for the canonical schema. The schema.sql mirror keeps the
-- migration runner idempotent on a fresh install.
CREATE TABLE IF NOT EXISTS sbos_session_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  user_id         INTEGER NOT NULL,
  tenant_id       INTEGER NOT NULL DEFAULT 0,
  event_type      TEXT NOT NULL,
  ip              TEXT,
  user_agent      TEXT,
  payload_json    TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sbos_session_events_session
  ON sbos_session_events (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sbos_session_events_user
  ON sbos_session_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sbos_session_events_recent
  ON sbos_session_events (created_at DESC);

-- ───────────── Approval / Dual-control ─────────────

-- Some "critical" actions require a second approver. This table holds pending
-- approvals; the second user reviews and approves/rejects.
CREATE TABLE IF NOT EXISTS sbos_rbac_approvals (
  id             TEXT PRIMARY KEY,            -- ULID
  tenant_id      INTEGER NOT NULL,
  resource       TEXT NOT NULL,               -- e.g. "finance.journal.post"
  action         TEXT NOT NULL,               -- permission key
  payload_json   TEXT NOT NULL,               -- proposed change
  requested_by   INTEGER NOT NULL,
  requested_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at     TEXT,
  approved_by    INTEGER,
  approved_at    TEXT,
  rejected_by    INTEGER,
  rejected_at    TEXT,
  rejection_reason TEXT,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | expired
  PRIMARY KEY (id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_sbos_rbac_app_tenant ON sbos_rbac_approvals(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sbos_rbac_app_status ON sbos_rbac_approvals(status);

-- ───────────── Audit log ─────────────

-- One row per (sensitive) permission check that DENIED, plus a sampled
-- fraction of ALLOWs for forensic replay. The app also writes to the global
-- audit_log table; this one is RBAC-specific and indexed for security review.
CREATE TABLE IF NOT EXISTS sbos_rbac_permission_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL,
  user_id      INTEGER,
  permission   TEXT NOT NULL,
  decision     TEXT NOT NULL,                 -- "allow" | "deny" | "mfa_required"
  resource     TEXT,                          -- e.g. "invoice:42"
  reason       TEXT,
  ip           TEXT,
  user_agent   TEXT,
  session_id   TEXT,
  impersonator_id INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sbos_rbac_audit_user ON sbos_rbac_permission_audit(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sbos_rbac_audit_perm ON sbos_rbac_permission_audit(permission, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sbos_rbac_audit_tenant ON sbos_rbac_permission_audit(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sbos_rbac_audit_decision ON sbos_rbac_permission_audit(decision, created_at DESC);

-- ───────────── Impersonation log ─────────────

CREATE TABLE IF NOT EXISTS sbos_rbac_impersonation_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL,
  actor_id      INTEGER NOT NULL,
  target_id     INTEGER NOT NULL,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at      TEXT,
  reason        TEXT,
  ip            TEXT
);

CREATE INDEX IF NOT EXISTS idx_sbos_rbac_imp_actor ON sbos_rbac_impersonation_log(actor_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sbos_rbac_imp_target ON sbos_rbac_impersonation_log(target_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sbos_rbac_imp_tenant ON sbos_rbac_impersonation_log(tenant_id, started_at DESC);

-- ───────────── Profiles (Phase 0.3) ─────────────
--
-- Reusable role+permission-set bundles for new users. Catalog stays in
-- code; profiles are tenant data. The PS list is denormalized as JSON
-- on the profile row (mirrors how sbos_rbac_roles stores app_set_json).
-- See server/rbac/migrations/0002_profiles.sql for the canonical
-- versioned DDL and server/rbac/profiles.js for the CRUD functions.

CREATE TABLE IF NOT EXISTS sbos_rbac_profiles (
  id                     TEXT PRIMARY KEY,
  tenant_id              INTEGER NOT NULL DEFAULT 0,
  label                  TEXT NOT NULL,
  description            TEXT NOT NULL DEFAULT '',
  role_id                TEXT NOT NULL,
  permission_set_ids_json TEXT NOT NULL DEFAULT '[]',
  is_system              INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  created_by             TEXT
);

CREATE INDEX IF NOT EXISTS idx_sbos_rbac_profiles_tenant ON sbos_rbac_profiles(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sbos_rbac_profiles_role   ON sbos_rbac_profiles(tenant_id, role_id);

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

-- ───────────── Bookkeeping ─────────────

CREATE TABLE IF NOT EXISTS sbos_rbac_meta (
  key          TEXT PRIMARY KEY,
  value        TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Records the catalog versions last seeded.
INSERT OR IGNORE INTO sbos_rbac_meta (key, value) VALUES
  ('permissions_version', '0'),
  ('roles_version', '0'),
  ('permission_sets_version', '0'),
  ('schema_version', '1');
