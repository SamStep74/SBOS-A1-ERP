-- 0001_init.sql
-- Initial SBOS-A1-ERP RBAC schema. Mirrors server/rbac/schema.sql but is the
-- canonical versioned migration. Both files share the same DDL by design;
-- the migration file is what the migration runner reads, the schema.sql is
-- what the seed installer loads for fresh dev/test DBs.
--
-- See server/rbac/schema.sql for full conventions.

PRAGMA foreign_keys = ON;

-- ───────────── Roles ─────────────

CREATE TABLE IF NOT EXISTS sbos_rbac_roles (
  id              TEXT PRIMARY KEY,
  tenant_id       INTEGER NOT NULL DEFAULT 0,
  label           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  parent          TEXT,
  is_system       INTEGER NOT NULL DEFAULT 0,
  app_set_json    TEXT NOT NULL DEFAULT '[]',
  mfa_required    INTEGER NOT NULL DEFAULT 0,
  session_hard_limit_minutes INTEGER NOT NULL DEFAULT 480,
  can_be_impersonated INTEGER NOT NULL DEFAULT 1,
  archived_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  created_by      TEXT
);

CREATE INDEX IF NOT EXISTS idx_sbos_rbac_roles_tenant ON sbos_rbac_roles(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sbos_rbac_roles_parent ON sbos_rbac_roles(parent);

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
  key            TEXT PRIMARY KEY,
  tenant_id      INTEGER NOT NULL DEFAULT 0,
  category       TEXT NOT NULL,
  sensitivity    TEXT NOT NULL,
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
  id           TEXT PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS sbos_rbac_user_permission_sets (
  user_id           INTEGER NOT NULL,
  permission_set_id TEXT NOT NULL,
  tenant_id         INTEGER NOT NULL,
  granted_at        TEXT NOT NULL DEFAULT (datetime('now')),
  granted_by        INTEGER,
  expires_at        TEXT,
  PRIMARY KEY (tenant_id, user_id, permission_set_id)
);

CREATE INDEX IF NOT EXISTS idx_sbos_rbac_ups_user ON sbos_rbac_user_permission_sets(user_id);

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

CREATE TABLE IF NOT EXISTS sbos_rbac_field_policies (
  field_path      TEXT NOT NULL,
  tenant_id       INTEGER NOT NULL DEFAULT 0,
  min_permission  TEXT NOT NULL,
  is_visible      INTEGER NOT NULL DEFAULT 1,
  label           TEXT NOT NULL DEFAULT '',
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by      INTEGER,
  PRIMARY KEY (tenant_id, field_path)
);

-- ───────────── Record-Level Security (RLS) overrides ─────────────

CREATE TABLE IF NOT EXISTS sbos_rbac_record_rules (
  resource      TEXT NOT NULL,
  tenant_id     INTEGER NOT NULL DEFAULT 0,
  scope         TEXT NOT NULL,
  predicate     TEXT,
  description   TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by    INTEGER,
  PRIMARY KEY (tenant_id, resource)
);

-- ───────────── Sessions (governance) ─────────────

CREATE TABLE IF NOT EXISTS sbos_rbac_sessions (
  id              TEXT PRIMARY KEY,
  user_id         INTEGER NOT NULL,
  tenant_id       INTEGER NOT NULL,
  role_id         TEXT NOT NULL,
  permission_set_ids_json TEXT NOT NULL,
  effective_permissions_json TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT NOT NULL,
  ip              TEXT,
  user_agent      TEXT,
  mfa_factor      TEXT,
  mfa_verified_at TEXT,
  impersonator_id INTEGER,
  revoked_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_sbos_rbac_sess_user ON sbos_rbac_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sbos_rbac_sess_tenant ON sbos_rbac_sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sbos_rbac_sess_active ON sbos_rbac_sessions(revoked_at, expires_at);

-- ───────────── Approval / Dual-control ─────────────

CREATE TABLE IF NOT EXISTS sbos_rbac_approvals (
  id             TEXT PRIMARY KEY,
  tenant_id      INTEGER NOT NULL,
  resource       TEXT NOT NULL,
  action         TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  requested_by   INTEGER NOT NULL,
  requested_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at     TEXT,
  approved_by    INTEGER,
  approved_at    TEXT,
  rejected_by    INTEGER,
  rejected_at    TEXT,
  rejection_reason TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY (id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_sbos_rbac_app_tenant ON sbos_rbac_approvals(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sbos_rbac_app_status ON sbos_rbac_approvals(status);

-- ───────────── Audit log ─────────────

CREATE TABLE IF NOT EXISTS sbos_rbac_permission_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id    INTEGER NOT NULL,
  user_id      INTEGER,
  permission   TEXT NOT NULL,
  decision     TEXT NOT NULL,
  resource     TEXT,
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

-- ───────────── Bookkeeping ─────────────

CREATE TABLE IF NOT EXISTS sbos_rbac_meta (
  key          TEXT PRIMARY KEY,
  value        TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO sbos_rbac_meta (key, value) VALUES
  ('permissions_version', '0'),
  ('roles_version', '0'),
  ('permission_sets_version', '0'),
  ('schema_version', '1');
