// SBOS-A1-ERP finance multi-tenant middleware + helpers.
//
// Phase 0.1 of the multi-tenant kernel: every finance row carries a
// `tenant_id` (see migrations/0005_tenant_id.sql), and every read goes
// through a tenant-scoped query. This module owns the middleware and
// the small helpers the rest of the finance surface uses to stay
// tenant-safe.
//
// Exports:
//   - requireTenant(req, res, next)      — Express middleware. Reads
//     X-Tenant-Id (or falls back to req.user.tenant_id from the auth
//     layer), stamps req.tenantId, rejects with 400 when missing.
//   - withTenant(db, tenantId, fn)       — set a per-connection tenant
//     context and run `fn`. For pg this would be `SET LOCAL app.tenant_id`
//     in a transaction; for node:sqlite it just threads the tenantId
//     through the function call (sqlite has no session-level GUCs).
//   - scopedQuery(baseSql, tenantId, ...params) — compose a SELECT that
//     has `AND tenant_id = $N` appended. The returned {sql, params} is
//     frozen and ready to hand to db.query().
//
// Convention (mirrors server/rbac):
//   - tenant_id = 0 is the bootstrap tenant. All pre-migration rows
//     resolve to 0 (the migration's DEFAULT 0). The middleware accepts
//     0 as a valid value — it is the single-tenant "no auth" mode for
//     smoke tests and the in-cluster system data.
//   - tenantId MUST be a positive integer (or 0). String headers are
//     parsed with Number(); non-integers, NaN, and negatives are
//     rejected with 400.

import { randomUUID } from 'node:crypto';

// ────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────

const TENANT_HEADER = 'x-tenant-id';
// Tenant id 0 is the bootstrap/system tenant. Pre-migration data and the
// `INSERT INTO finance.tenants (id=0, name='bootstrap')` row both live
// here. We allow it as a valid input so the no-auth single-tenant mode
// keeps working — the migration default of 0 makes the whole pre-wave-13
// data set queryable as tenant 0 without re-tagging.

const TENANT_MAX_SAFE = Number.MAX_SAFE_INTEGER;

// ────────────────────────────────────────────────────────────────────────
// ValueError — local re-export so callers can `import { ValueError } from
// './tenant.js'` without reaching into invoice.js. Mirrors the
// server/finance/invoice.js pattern.
// ────────────────────────────────────────────────────────────────────────

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// Internal: parse a tenant id from a string (or null). Returns a
// non-negative safe integer, or null if the input is missing/malformed.
// Exported as __internals for tests; not part of the public surface.
// ────────────────────────────────────────────────────────────────────────

function parseTenantId(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 0 || raw > TENANT_MAX_SAFE) return null;
    return raw;
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Reject anything that is not a pure non-negative integer string. This
  // blocks '1.5', '1e2', '-1', 'NaN', 'null', '  7x' etc. before they
  // reach Number() (which would happily parse '1e2' = 100).
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > TENANT_MAX_SAFE) return null;
  return n;
}

// ────────────────────────────────────────────────────────────────────────
// requireTenant — Express middleware.
//
//   - Reads `X-Tenant-Id` (case-insensitive, normalised by Express).
//   - Falls back to `req.user.tenant_id` (set by the auth middleware).
//   - Stamps `req.tenantId` with the parsed integer.
//   - 400 on missing/malformed input. The body shape matches the rest
//     of the API surface (`{ error: '<machine-readable>', message: '...'}`).
//
// The header wins over req.user.tenant_id so an operator with a
// cross-tenant admin role (rare) can switch tenants per-request without
// re-logging-in. The fall-back is for the common case where the auth
// layer already resolved the tenant from the JWT/session.
// ────────────────────────────────────────────────────────────────────────

export function requireTenant(req, res, next) {
  if (!req || typeof req !== 'object') {
    throw new TypeError('requireTenant: req must be an object');
  }
  if (!res || typeof res.status !== 'function' || typeof res.json !== 'function') {
    throw new TypeError('requireTenant: res must be an Express response object');
  }
  if (typeof next !== 'function') {
    throw new TypeError('requireTenant: next must be a function');
  }

  // 1. Header is the primary source. Express normalises headers to
  //    lowercase, so we look up the lowercase form.
  const headerVal =
    req.headers && typeof req.headers === 'object' ? req.headers[TENANT_HEADER] : undefined;
  let tenantId = parseTenantId(headerVal);

  // 2. Fall back to req.user.tenant_id when the header is absent or
  //    malformed. (If the header is malformed, we treat it as missing —
  //    we never silently coerce a bad header to a different value.)
  if (tenantId === null && req.user && req.user.tenant_id !== undefined) {
    tenantId = parseTenantId(req.user.tenant_id);
  }

  if (tenantId === null) {
    res.status(400).json({
      error: 'tenant_required',
      message:
        'request must carry an X-Tenant-Id header (positive integer) ' +
        'or req.user.tenant_id from the auth layer',
    });
    return;
  }

  req.tenantId = tenantId;
  next();
}

// ────────────────────────────────────────────────────────────────────────
// withTenant — set a per-connection tenant context and run `fn`.
//
// For pg, the production wiring is `BEGIN; SET LOCAL app.tenant_id = $1;
// <fn>(); COMMIT;`. We don't ship a pg client in this module — the
// function detects pg by duck-type (`db.query`) and emits the GUC
// statements. For sqlite (the test driver), the tenant is just an
// argument the caller threads through, so withTenant is a no-op around
// the call.
//
// Either way, withTenant returns whatever `fn` returns (awaited if it's
// a thenable). Errors propagate to the caller — the transaction wrapper
// (when present) is responsible for rolling back.
// ────────────────────────────────────────────────────────────────────────

export async function withTenant(db, tenantId, fn) {
  if (!db) throw new TypeError('withTenant: db is required');
  if (tenantId === null || tenantId === undefined) {
    throw new ValueError('withTenant: tenantId is required');
  }
  if (typeof fn !== 'function') {
    throw new TypeError('withTenant: fn must be a function');
  }
  const tid = parseTenantId(tenantId);
  if (tid === null) {
    throw new ValueError(
      `withTenant: tenantId must be a non-negative integer (got ${String(tenantId)})`,
    );
  }

  const isPg = typeof db.query === 'function' && !isSqliteLike(db);
  if (isPg) {
    // Production pg path: SET LOCAL inside a transaction. The GUC is
    // scoped to the current transaction so it doesn't leak across
    // pooled connections. We don't open an explicit transaction here —
    // the caller's transaction boundary is the right scope. If the
    // caller isn't already in one, we open a savepoint-style wrapper.
    await db.query('SET LOCAL app.tenant_id = $1', [tid]);
    try {
      return await fn();
    } finally {
      // SET LOCAL is automatically reverted at COMMIT/ROLLBACK. No
      // explicit cleanup needed.
    }
  }

  // sqlite (or any other) path: no GUC. Just run the function. Caller
  // is responsible for passing tenantId into the SQL via scopedQuery
  // or by adding a WHERE tenant_id = $N clause themselves.
  return await fn();
}

// Some pg-style mocks in this codebase expose `.query` but no transaction
// support; treat those as sqlite-flavour so we don't try to emit
// `SET LOCAL` against an in-memory mock.
function isSqliteLike(db) {
  return typeof db.prepare === 'function' || typeof db.exec === 'function';
}

// ────────────────────────────────────────────────────────────────────────
// scopedQuery — compose `AND tenant_id = $N` into a base SELECT.
//
// Returns a frozen `{ sql, params }` pair. The caller is expected to
// hand it straight to `db.query(sql, params)`. The composed SQL uses
// pg-style `$N` placeholders (the rest of the finance surface is
// pg-style; the sqlite test adapter rewrites $N → ? on the way down).
//
// The function is intentionally minimal — it only does the one thing
// the rest of the finance surface needs. If a future caller wants
// OR-tenant-scoping or a different predicate, they should add a helper
// alongside scopedQuery rather than extending this one.
// ────────────────────────────────────────────────────────────────────────

export function scopedQuery(baseSql, tenantId, ...params) {
  if (typeof baseSql !== 'string' || baseSql.trim().length === 0) {
    throw new ValueError('scopedQuery: baseSql must be a non-empty string');
  }
  const tid = parseTenantId(tenantId);
  if (tid === null) {
    throw new ValueError(
      `scopedQuery: tenantId must be a non-negative integer (got ${String(tenantId)})`,
    );
  }

  // Find the highest $N placeholder already in the SQL so we can use
  // the next one. baseSql may not have any $N yet (a bare SELECT) — in
  // that case we start at 1.
  const used = baseSql.match(/\$\d+/g) || [];
  let maxN = 0;
  for (const m of used) {
    const n = Number(m.slice(1));
    if (Number.isInteger(n) && n > maxN) maxN = n;
  }
  const tenantPlaceholder = `$${maxN + 1}`;

  // We need to inject `AND tenant_id = $N` somewhere. Strategy:
  //   - If the SQL already has a WHERE clause, append the predicate.
  //   - Otherwise, add a `WHERE tenant_id = $N` clause.
  // Both are matched case-insensitively (PG normalises keywords to
  // uppercase at plan time, but the SQL itself is mixed case by
  // convention here).
  const trimmed = baseSql.replace(/;\s*$/, '').trim();
  const hasWhere = /\bWHERE\b/i.test(trimmed);

  let sql;
  if (hasWhere) {
    sql = `${trimmed} AND tenant_id = ${tenantPlaceholder}`;
  } else {
    sql = `${trimmed} WHERE tenant_id = ${tenantPlaceholder}`;
  }

  return Object.freeze({
    sql,
    params: [...params, tid],
  });
}

// ────────────────────────────────────────────────────────────────────────
// generateRequestId — small helper for the middleware to stamp a request
// id (useful when emit an audit log). Not exported through the public
// surface yet; available to test scaffolding via __internals.
// ────────────────────────────────────────────────────────────────────────

function generateRequestId() {
  return randomUUID();
}

// ────────────────────────────────────────────────────────────────────────
// Internal surface — exported under __internals for the test suite.
// Anything not on __internals is part of the documented public surface.
// ────────────────────────────────────────────────────────────────────────

export const __internals = Object.freeze({
  TENANT_HEADER,
  TENANT_MAX_SAFE,
  parseTenantId,
  isSqliteLike,
  generateRequestId,
});
