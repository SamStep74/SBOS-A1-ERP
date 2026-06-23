// SBOS-A1-ERP tenant rate limit config (W70).
//
// The W57 login rate limiter uses global defaults. The
// W70 config lets operators override on a per-tenant
// basis — e.g. a service tenant that legitimately logs
// in more often, or a tenant under brute-force attack
// that needs a stricter limit.
//
// Schema (migration 0036_tenant_rate_limit.sql):
//   tenant_id            PK
//   login_max_per_ip     NULL = use the global default
//   login_max_per_username NULL = use the global default
//   updated_at           timestamp
//   updated_by           user_id of the operator
//
// The live checkLoginRateLimit (W57) is NOT yet wired to
// the per-tenant config — that's a follow-up wave. This
// module ships the operator-facing knob: read the config,
// update the config, resolve to effective numbers. Future
// waves can call getEffectiveLoginLimits(db, tenantId)
// to apply the per-tenant limit at the live check.
//
// Why a separate module? The W57 rate-limit module is
// in-memory only (no DB). Threading DB access into the
// hot path of every login attempt would add a DB hit per
// attempt. The W70 module is for the operator surface
// (read/write the config) — the live check can be wired
// up later with a cache or a per-tenant limiter object.

import { getAuditRetention } from './auditRetention.js';

// Global defaults — mirror the W57 numbers so a tenant
// with no explicit config behaves identically to the
// pre-W70 world.
export const DEFAULT_LOGIN_MAX_PER_IP = 20;
export const DEFAULT_LOGIN_MAX_PER_USERNAME = 10;

function stripFinancePrefix(sql) {
  return String(sql).replace(
    /(?<![A-Za-z0-9_'".])finance\.([A-Za-z_][A-Za-z0-9_]*)/g,
    '$1',
  );
}

// getTenantRateLimit — read the raw config row for a
// tenant. Returns null if no config exists (the tenant
// is on the default policy).
export function getTenantRateLimit(db, tenantId) {
  const tid = Number(tenantId);
  if (!Number.isFinite(tid)) {
    throw new TypeError('tenantId must be a finite number');
  }
  const sql = stripFinancePrefix(
    `SELECT tenant_id, login_max_per_ip, login_max_per_username,
            updated_at, updated_by
       FROM finance.tenant_rate_limit
      WHERE tenant_id = ?`,
  );
  const row = db.prepare(sql).get(tid);
  if (!row) return null;
  return {
    tenant_id: tid,
    login_max_per_ip:
      row.login_max_per_ip == null ? null : Number(row.login_max_per_ip),
    login_max_per_username:
      row.login_max_per_username == null
        ? null
        : Number(row.login_max_per_username),
    updated_at: row.updated_at || null,
    updated_by: row.updated_by == null ? null : Number(row.updated_by),
  };
}

// setTenantRateLimit — upsert the per-tenant config.
// Validates: each max must be a positive integer or null
// (null = fall back to the global default). 0 is rejected
// (it would be a confusing config — "allow no logins").
export function setTenantRateLimit(db, tenantId, maxPerIp, maxPerUsername, updatedBy) {
  const tid = Number(tenantId);
  if (!Number.isFinite(tid)) {
    throw new TypeError('tenantId must be a finite number');
  }
  const ipVal = maxPerIp == null ? null : Number(maxPerIp);
  const userVal = maxPerUsername == null ? null : Number(maxPerUsername);
  if (ipVal != null && (!Number.isInteger(ipVal) || ipVal <= 0)) {
    throw new RangeError('login_max_per_ip must be a positive integer or null');
  }
  if (userVal != null && (!Number.isInteger(userVal) || userVal <= 0)) {
    throw new RangeError('login_max_per_username must be a positive integer or null');
  }
  const ub = updatedBy == null ? null : Number(updatedBy);
  const sql = stripFinancePrefix(
    `INSERT INTO finance.tenant_rate_limit
        (tenant_id, login_max_per_ip, login_max_per_username, updated_at, updated_by)
     VALUES (?, ?, ?, datetime('now'), ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
        login_max_per_ip     = excluded.login_max_per_ip,
        login_max_per_username = excluded.login_max_per_username,
        updated_at           = excluded.updated_at,
        updated_by           = excluded.updated_by`,
  );
  db.prepare(sql).run(tid, ipVal, userVal, ub);
  return getTenantRateLimit(db, tid);
}

// getEffectiveLoginLimits — resolve the per-tenant
// config to the numbers the live rate limit would use.
// Falls back to the global defaults for any NULL field.
// Returns: { max_per_ip, max_per_username } (snake_case
// to match the W70 HTTP API shape — the rate-limit
// cache translates to camelCase on the W71 side).
export function getEffectiveLoginLimits(db, tenantId) {
  const cfg = getTenantRateLimit(db, tenantId);
  return {
    max_per_ip:
      cfg && cfg.login_max_per_ip != null
        ? cfg.login_max_per_ip
        : DEFAULT_LOGIN_MAX_PER_IP,
    max_per_username:
      cfg && cfg.login_max_per_username != null
        ? cfg.login_max_per_username
        : DEFAULT_LOGIN_MAX_PER_USERNAME,
  };
}

// Suppress unused-import linter warning — getAuditRetention
// is imported for future hooks (e.g. recording the
// change in the audit log) but is not yet used.
void getAuditRetention;
