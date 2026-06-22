-- 0036_tenant_rate_limit.sql
-- W70: per-tenant rate limit config.
--
-- The W57 login rate limiter uses GLOBAL defaults
-- (20 per 5 min per IP, 10 per 5 min per username). The
-- operator may want to override on a per-tenant basis —
-- e.g. a service tenant that legitimately logs in more
-- often, or a tenant under brute-force attack that needs
-- a stricter limit.
--
-- Schema:
--   tenant_id            PK
--   login_max_per_ip     NULL = use the global default
--   login_max_per_username NULL = use the global default
--   updated_at           timestamp
--   updated_by           user_id of the operator
--
-- Idempotent: CREATE TABLE IF NOT EXISTS. The migration
-- runner treats "duplicate column" errors on ALTER TABLE
-- as success (see server/finance/migrate.js sqliteTranslate).
--
-- Naming: finance.tenant_rate_limit on pg,
-- tenant_rate_limit on sqlite (the migration runner
-- strips the `finance.` prefix on DDL because sqlite
-- has no schemas).

CREATE TABLE IF NOT EXISTS finance.tenant_rate_limit (
  tenant_id            INTEGER PRIMARY KEY,
  login_max_per_ip     INTEGER
                       CHECK (login_max_per_ip IS NULL OR login_max_per_ip > 0),
  login_max_per_username INTEGER
                       CHECK (login_max_per_username IS NULL OR login_max_per_username > 0),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by           INTEGER
);
