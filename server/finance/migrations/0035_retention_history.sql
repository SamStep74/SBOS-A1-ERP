-- 0035_retention_history.sql
-- W66: per-tenant retention history snapshots.
--
-- Captures the retention state of each tenant at a point in
-- time. Lets the CFO answer "what did the retention state
-- look like last Tuesday?" — a real operator use case.
--
-- The snapshot is a denormalised copy of the dashboard row
-- (tenant_id, retention_days, audit_row_count, last_purge_at,
-- last_purge_count) plus a snapshot_at timestamp. We
-- denormalise (rather than FK to the live tables) so the
-- history is immutable and survives config changes.
--
-- Append-only. The auto-snapshot worker inserts one row per
-- tenant per tick. A tenant that's added or removed mid-
-- history simply stops showing up in new snapshots (its
-- old snapshots remain, frozen).
--
-- Schema naming: same convention as the rest of finance —
-- finance.retention_history on pg, retention_history on
-- sqlite (the migration runner strips the prefix on DDL).

CREATE TABLE IF NOT EXISTS finance.retention_history (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         INTEGER NOT NULL,
  snapshot_at       TEXT NOT NULL DEFAULT (datetime('now')),
  retention_days    INTEGER NOT NULL,
  has_explicit_config INTEGER NOT NULL DEFAULT 0,
  audit_row_count   INTEGER NOT NULL DEFAULT 0,
  last_purge_at     TEXT,
  last_purge_count  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_finance_retention_history_tenant_time
  ON finance.retention_history (tenant_id, snapshot_at DESC);

CREATE INDEX IF NOT EXISTS idx_finance_retention_history_time
  ON finance.retention_history (snapshot_at DESC);
