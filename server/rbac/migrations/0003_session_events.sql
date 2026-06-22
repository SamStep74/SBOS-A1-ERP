-- Wave 55: session activity log.
--
-- Tracks lifecycle events for each session: login, logout,
-- revoked (by self or by admin), expired, etc. The session
-- table itself (sbos_rbac_sessions) only has the current state
-- (ip, user_agent, last_seen_at). For a real activity history
-- ("when did this user log in, from where, when was the session
-- revoked") we need a separate events table.
--
-- Usage:
--   - On POST /api/auth/login, insert event_type='login' with
--     the ip + user_agent from the request.
--   - On POST /api/auth/logout, insert event_type='logout'.
--   - On POST /api/rbac/sessions/:id/revoke (admin revoke) or
--     /api/auth/sessions/:id/revoke (self revoke), insert
--     event_type='revoked' with revoked_by in the payload.
--   - On pruneExpiredSessions, skip — janitor actions aren't
--     user-initiated and would dominate the log.
--
-- Indexed on (session_id, created_at) for the per-session
-- endpoint and (created_at) for global time-range queries.

CREATE TABLE IF NOT EXISTS sbos_session_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  user_id         INTEGER NOT NULL,
  tenant_id       INTEGER NOT NULL DEFAULT 0,
  event_type      TEXT NOT NULL,           -- login, logout, revoked, expired
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
