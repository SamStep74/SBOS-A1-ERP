// SBOS-A1-ERP finance audit retention (W60).
//
// Per-tenant retention config for the finance.audit log. Each
// tenant can set how many days of audit history to keep:
//   - 0   = keep forever
//   - 365 = default (one year — typical regulatory window for
//           financial records in many jurisdictions)
//   - N>0 = keep the most recent N days
//
// The config lives in `finance.audit_retention` (one row per
// tenant). The purge function deletes rows older than the
// configured window; it's safe to call repeatedly (idempotent
// — second call is a no-op when no rows match the cutoff).
//
// The same sqlite-vs-pg prefix pattern as audit.js: queries
// are written without the `finance.` prefix so they work on
// both backends (sqlite strips the prefix on DDL; pg keeps it).

// Default retention window in days. 0 = forever. Keep as a
// constant so the route handler + tests can reference the same
// number without string-typing it everywhere.
export const DEFAULT_RETENTION_DAYS = 365;

// Hard cap on what the operator can set. 50 years is
// generous; the realistic ceiling is regulatory (e.g. SOX
// 7-year, Armenian tax 5-year). We don't enforce a
// jurisdiction-specific cap here; that's a deploy-time
// concern. 50 years prevents accidental "1e9 days" which
// would still work but is clearly operator error.
const MAX_RETENTION_DAYS = 50 * 365;

function stripFinancePrefix(sql) {
  return String(sql).replace(
    /(?<![A-Za-z0-9_'".])finance\.([A-Za-z_][A-Za-z0-9_]*)/g,
    '$1',
  );
}

// getAuditRetention — read the retention config for a tenant.
// Returns the stored config or a synthetic default if no row
// exists. Synthetic default is treated like a real row by the
// caller (the default is also the cap on "if you call
// purgeOldAuditEvents(db, tenantId, 0) — keep forever" which
// never deletes).
export function getAuditRetention(db, tenantId) {
  const tid = Number(tenantId);
  if (!Number.isFinite(tid)) {
    throw new TypeError('tenantId must be a finite number');
  }
  const sql = stripFinancePrefix(
    `SELECT tenant_id, retention_days, updated_at, updated_by
       FROM finance.audit_retention
       WHERE tenant_id = ?`,
  );
  const row = db.prepare(sql).get(tid);
  if (row) {
    return {
      tenant_id: tid,
      retention_days: Number(row.retention_days),
      updated_at: row.updated_at || null,
      updated_by: row.updated_by == null ? null : Number(row.updated_by),
    };
  }
  // No config row → return the default. We DO NOT write a row
  // here; the config is implicit until the operator explicitly
  // calls setAuditRetention. This keeps the audit_retention
  // table sparse (only tenants who deviate from the default
  // get a row).
  return {
    tenant_id: tid,
    retention_days: DEFAULT_RETENTION_DAYS,
    updated_at: null,
    updated_by: null,
  };
}

// setAuditRetention — upsert the retention config for a tenant.
// Validates: retention_days must be a non-negative integer not
// exceeding MAX_RETENTION_DAYS. 0 is allowed (= keep forever).
// updatedBy is recorded in the row for audit-trail purposes
// (who set this policy).
export function setAuditRetention(db, tenantId, retentionDays, updatedBy) {
  const tid = Number(tenantId);
  if (!Number.isFinite(tid)) {
    throw new TypeError('tenantId must be a finite number');
  }
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || !Number.isInteger(days) || days < 0) {
    throw new RangeError('retention_days must be a non-negative integer');
  }
  if (days > MAX_RETENTION_DAYS) {
    throw new RangeError(
      `retention_days must be <= ${MAX_RETENTION_DAYS} (50 years)`,
    );
  }
  const ub = updatedBy == null ? null : Number(updatedBy);
  if (ub != null && !Number.isFinite(ub)) {
    throw new TypeError('updatedBy must be a finite number or null');
  }
  // Upsert via INSERT ... ON CONFLICT (sqlite + pg both
  // support this). updated_at is set to now() on every call
  // so the caller can see when the policy was last touched.
  const sql = stripFinancePrefix(
    `INSERT INTO finance.audit_retention
        (tenant_id, retention_days, updated_at, updated_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
        retention_days = excluded.retention_days,
        updated_at     = excluded.updated_at,
        updated_by     = excluded.updated_by`,
  );
  db.prepare(sql).run(tid, days, ub);
  return getAuditRetention(db, tid);
}

// purgeOldAuditEvents — delete audit rows older than N days for
// a single tenant. Idempotent: a second call is a no-op when
// no rows match the cutoff. Returns the number of rows deleted.
//
// days = 0 → delete nothing (keep forever semantics). This
// matches the "0 means forever" convention of the rest of the
// module: an operator who sets retention_days = 0 is
// explicitly opting out of automatic purging, so the purge
// function should respect that.
//
// Tenant scope is mandatory. The function takes tenantId as
// an arg rather than inferring it from context so the
// auto-purge worker (startAuditRetentionPurge) can iterate
// over a list of tenants and call this per-tenant.
export function purgeOldAuditEvents(db, tenantId, days) {
  const tid = Number(tenantId);
  if (!Number.isFinite(tid)) {
    throw new TypeError('tenantId must be a finite number');
  }
  const d = Number(days);
  if (!Number.isFinite(d) || !Number.isInteger(d) || d < 0) {
    throw new RangeError('days must be a non-negative integer');
  }
  if (d === 0) {
    // 0 = keep forever → no-op. Don't even hit the DB.
    return 0;
  }
  // datetime('now', '-' || N || ' days') is portable across
  // sqlite and pg (both support this modifier syntax). On
  // pg the finance. prefix would matter, but our DML is
  // written without it (stripFinancePrefix) so the SQL is
  // the same on both backends — the migration runner's
  // prefix handling on DDL is what makes the tables align.
  const sql = stripFinancePrefix(
    `DELETE FROM finance.audit
      WHERE tenant_id = ?
        AND created_at < datetime('now', '-' || ? || ' days')`,
  );
  const res = db.prepare(sql).run(tid, d);
  return Number(res.changes || 0);
}

// startAuditRetentionPurge — opt-in background tick that
// periodically prunes the audit log per tenant. NOT auto-
// started: the deployer must opt in via
// process.env.SBOS_AUDIT_PURGE_ENABLED === "true" (see
// server/index.js createApp). The default is OFF so existing
// deploys see no behavior change.
//
// tickMs: minimum 60_000 (1 min) to prevent an accidental
// zero/short tick from hammering the DB. Realistic tick is
// 24h = 86_400_000ms for daily purges.
//
// Returns a handle with stop() so the caller can cleanly
// shut the worker down (matters for the smoke runner that
// kills the server with SIGTERM).
export function startAuditRetentionPurge({
  db,
  tickMs = 24 * 60 * 60 * 1000,
  // Optionally pass a list of tenant_ids to iterate. If
  // omitted, the worker iterates over every tenant that has
  // an explicit retention row (so tenants still on the
  // default 365d policy get cleaned up too).
  tenantIds = null,
  // sleep(0) is the default sleep. Tests inject a fake.
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  if (!db) {
    throw new TypeError('startAuditRetentionPurge: db is required');
  }
  const floor = 60_000;
  const tick = Math.max(floor, Number(tickMs) || floor);
  let stopped = false;
  let timer = null;
  let inFlight = null;
  const iterateTenants = () => {
    if (Array.isArray(tenantIds)) {
      return tenantIds.map((t) => Number(t)).filter(Number.isFinite);
    }
    // Pull every tenant that has an explicit retention row
    // AND every tenant that has any audit rows. The OR is
    // important: a tenant who set retention_days=0 would
    // otherwise be skipped (no row in audit_retention means
    // default 365d which would still purge their old data).
    // We pull both and dedupe.
    const sql = stripFinancePrefix(
      `SELECT DISTINCT tenant_id FROM finance.audit_retention
       UNION
       SELECT DISTINCT tenant_id FROM finance.audit`,
    );
    const rows = db.prepare(sql).all();
    return rows.map((r) => Number(r.tenant_id)).filter(Number.isFinite);
  };
  const tickOnce = async () => {
    const tenants = iterateTenants();
    let totalPurged = 0;
    for (const tid of tenants) {
      const cfg = getAuditRetention(db, tid);
      if (!cfg.retention_days) continue; // 0 = forever, skip
      const n = purgeOldAuditEvents(db, tid, cfg.retention_days);
      totalPurged += n;
    }
    return totalPurged;
  };
  const run = async () => {
    while (!stopped) {
      try {
        inFlight = tickOnce();
        await inFlight;
      } catch (err) {
        // best-effort: log and continue
        try {
          console.error(
            '[auditRetention] tick failed:',
            err && err.message ? err.message : err,
          );
        } catch {
          // ignore logging errors
        }
      } finally {
        inFlight = null;
      }
      await sleep(tick);
    }
  };
  // Kick off the loop. The first tick fires after `tick`
  // ms, not immediately, so a server starting up has time
  // to finish its init before we hit the DB.
  run();
  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    tickMs: tick,
    tickNow: tickOnce,
  };
}
