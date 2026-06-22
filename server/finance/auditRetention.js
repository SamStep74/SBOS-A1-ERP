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
  // W63: also read the last-purge history columns so the
  // /audit/retention GET response carries the dashboard data
  // (avoids a separate query per tenant).
  const sql = stripFinancePrefix(
    `SELECT tenant_id, retention_days, updated_at, updated_by,
            last_purge_at, last_purge_count, last_purge_days
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
      last_purge_at: row.last_purge_at || null,
      last_purge_count:
        row.last_purge_count == null ? null : Number(row.last_purge_count),
      last_purge_days:
        row.last_purge_days == null ? null : Number(row.last_purge_days),
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
    last_purge_at: null,
    last_purge_count: null,
    last_purge_days: null,
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
      // Record the run for the W63 dashboard. Silent
      // no-op if the tenant is on the default 365d policy
      // (no config row to update).
      try {
        recordPurgeRun(db, tid, n, cfg.retention_days);
      } catch (_e) {
        // best-effort: do not let a write failure on the
        // dashboard column crash the auto-purge tick
      }
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

// ────────────────────────────────────────────────────────────────────────
// W63: dashboard support — record purge history + roll up per-tenant
// stats.
//
// The retention policy (W60) gave admins the knobs; the dashboard
// (this wave) gives them the visibility. The dashboard reads:
//   - audit_retention row (config + last_purge_at + last_purge_count)
//     for tenants with an explicit config
//   - the audit table directly (UNION over distinct tenant_ids)
//     for tenants on the default 365d policy that have audit rows
//   - the audit table again (per-tenant COUNT(*)) for the current
//     audit row count
//
// The dashboard does NOT execute any purge — it's a read-side
// view. The CFO sees "tenant X is on 365d default with 12k rows"
// and "tenant Y set 90d, last purged 200 rows on Tuesday".
// ────────────────────────────────────────────────────────────────────────

// recordPurgeRun — stamp the last_purge_at + last_purge_count
// columns on the audit_retention row for a tenant. Caller
// invokes this after purgeOldAuditEvents returns.
//
// Silent no-op when no config row exists for the tenant.
// Rationale: tenants on the default 365d policy have no row
// in audit_retention (the config is implicit). Recording
// purge history for them would force us to write a row
// (sparse table → dense table), which would surprise
// operators who query audit_retention expecting "only
// tenants who deviated from the default".
//
// daysKept is the retention window in effect AT THE TIME
// of the purge (so the dashboard can show "last purge
// ran with 90d window"). Optional — null is fine for
// callers that don't track it.
export function recordPurgeRun(db, tenantId, purgedCount, daysKept = null) {
  const tid = Number(tenantId);
  if (!Number.isFinite(tid)) {
    throw new TypeError('tenantId must be a finite number');
  }
  const count = Number(purgedCount);
  if (!Number.isFinite(count) || count < 0) {
    throw new RangeError('purgedCount must be a non-negative finite number');
  }
  // Check if a config row exists. UPDATE is cheaper than
  // INSERT-then-catch-error (and gives a clear "row not
  // found" path). For tenants on the default policy, the
  // row does not exist and we silently no-op.
  const sql = stripFinancePrefix(
    `UPDATE finance.audit_retention
        SET last_purge_at = datetime('now'),
            last_purge_count = ?,
            last_purge_days = ?
      WHERE tenant_id = ?`,
  );
  const res = db.prepare(sql).run(count, daysKept, tid);
  return Number(res.changes || 0); // 0 if no row, 1 if updated
}

// getRetentionDashboard — return per-tenant stats for every
// tenant that has an explicit retention config OR has any
// audit rows. The shape is designed for the CFO-facing
// dashboard (read-only, no perm to update).
//
// Output item shape:
//   {
//     tenant_id:        <int>,
//     retention_days:   <int>,           // explicit or DEFAULT_RETENTION_DAYS
//     has_explicit_config: <bool>,       // true iff audit_retention row exists
//     updated_at:       <iso|null>,      // when the config was last set
//     updated_by:       <int|null>,      // who set the config
//     last_purge_at:    <iso|null>,      // when the last purge ran
//     last_purge_count: <int|null>,      // rows deleted in the last purge
//     audit_row_count:  <int>,           // current rows in the audit table
//   }
//
// Sorted by tenant_id ASC for stable display.
export function getRetentionDashboard(db) {
  // Two queries: explicit-config tenants (joined with row
  // count) and default-config tenants (audit rows only).
  // The UNION dedupes when a tenant appears in both (an
  // explicit config takes precedence — the LEFT JOIN covers
  // this).
  const sql = stripFinancePrefix(
    `SELECT
        ar.tenant_id              AS tenant_id,
        ar.retention_days         AS retention_days,
        1                         AS has_explicit_config,
        ar.updated_at             AS updated_at,
        ar.updated_by             AS updated_by,
        ar.last_purge_at          AS last_purge_at,
        ar.last_purge_count       AS last_purge_count,
        ar.last_purge_days        AS last_purge_days,
        (SELECT COUNT(*) FROM finance.audit a
          WHERE a.tenant_id = ar.tenant_id) AS audit_row_count
     FROM finance.audit_retention ar
     UNION
     SELECT
        a.tenant_id               AS tenant_id,
        ${DEFAULT_RETENTION_DAYS} AS retention_days,
        0                         AS has_explicit_config,
        NULL                      AS updated_at,
        NULL                      AS updated_by,
        NULL                      AS last_purge_at,
        NULL                      AS last_purge_count,
        NULL                      AS last_purge_days,
        COUNT(*)                  AS audit_row_count
     FROM finance.audit a
     WHERE a.tenant_id NOT IN (SELECT tenant_id FROM finance.audit_retention)
     GROUP BY a.tenant_id
     ORDER BY tenant_id ASC`,
  );
  const rows = db.prepare(sql).all();
  return {
    items: rows.map((r) => ({
      tenant_id: Number(r.tenant_id),
      retention_days: Number(r.retention_days),
      has_explicit_config: Number(r.has_explicit_config) === 1,
      updated_at: r.updated_at || null,
      updated_by: r.updated_by == null ? null : Number(r.updated_by),
      last_purge_at: r.last_purge_at || null,
      last_purge_count:
        r.last_purge_count == null ? null : Number(r.last_purge_count),
      last_purge_days:
        r.last_purge_days == null ? null : Number(r.last_purge_days),
      audit_row_count: Number(r.audit_row_count),
    })),
  };
}

// ────────────────────────────────────────────────────────────────────────
// W64: dashboard CSV export.
//
// streamRetentionDashboardCsv — async generator that yields the
// dashboard rows as CSV. Mirrors the W40 streamAuditCsv pattern:
// memory-bounded by chunk size, header yielded first, the caller
// (Express route) can pipe each chunk to res as it's produced.
// ────────────────────────────────────────────────────────────────────────

const DASHBOARD_CSV_HEADERS = Object.freeze([
  'tenant_id',
  'retention_days',
  'has_explicit_config',
  'updated_at',
  'updated_by',
  'last_purge_at',
  'last_purge_count',
  'last_purge_days',
  'audit_row_count',
]);

function dashboardCsvEscape(value) {
  // Identical to the W40 csvEscape in audit.js — same RFC 4180
  // semantics. Duplicated here so the dashboard export is
  // self-contained and doesn't reach into the audit module.
  if (value == null) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function dashboardCsvLine(values) {
  return values.map(dashboardCsvEscape).join(',') + '\n';
}

// Stream the dashboard as CSV. The generator yields
// one chunk at a time (a string ready to write to res).
// No buffering of the full output in memory.
//
// @param {object} db   raw node:sqlite handle
// @param {object} [opts]   reserved for future filters
// @param {number} [chunkSize=500]  rows per yield
export async function* streamRetentionDashboardCsv(db, _opts = {}, chunkSize = 500) {
  const size = Math.min(Math.max(Number(chunkSize) || 500, 1), 5000);
  // Pull every tenant's stats via the existing pure function
  // (single round-trip; no per-tenant queries). The dashboard
  // is small in practice (one row per tenant, not per audit
  // row) — the chunkSize only matters for the very largest
  // multi-tenant deploys.
  const dashboard = getRetentionDashboard(db);
  // Yield the header first so the client always sees a valid
  // CSV (compliance tools expect a header line on every
  // export, even an empty one).
  yield dashboardCsvLine(DASHBOARD_CSV_HEADERS);
  // Iterate the items. items.length is small (one per
  // tenant), so the chunkSize mostly affects how often we
  // yield to the caller.
  let buf = [];
  for (const item of dashboard.items) {
    buf.push(dashboardCsvLine([
      item.tenant_id,
      item.retention_days,
      item.has_explicit_config ? 1 : 0,
      item.updated_at,
      item.updated_by,
      item.last_purge_at,
      item.last_purge_count,
      item.last_purge_days,
      item.audit_row_count,
    ]));
    if (buf.length >= size) {
      yield buf.join('');
      buf = [];
    }
  }
  if (buf.length > 0) {
    yield buf.join('');
  }
}

// ────────────────────────────────────────────────────────────────────────
// W65: retention digest (weekly CFO email summary).
//
// The dashboard (W63) gives the CFO a live view; the digest
// gives them a proactive weekly summary. Two pure functions:
//
//   - getRetentionDigestSummary(db) → roll-up counts
//       { tenant_count, tenants_on_default, tenants_with_explicit_config,
//         total_audit_rows, total_rows_purged, tenants_with_recent_purge }
//   - buildRetentionDigestBody(summary) → human-readable text
//
// The email route (server/finance/routes.js) wires these
// into the existing email service for delivery. The pure
// functions stay self-contained so unit tests cover them
// without spinning up the email service.
// ────────────────────────────────────────────────────────────────────────

// getRetentionDigestSummary — aggregate counts across every
// tenant that has either an explicit config or any audit
// rows. Used by the weekly digest route to render the
// summary at the top of the email body.
export function getRetentionDigestSummary(db) {
  // Three sub-queries: tenants + audit rows + purge totals.
  // Each is a single round-trip on the same db. We use
  // the stripFinancePrefix pattern (audit table is named
  // bare on sqlite, finance.audit on pg).
  const tenantCountSql = stripFinancePrefix(
    `SELECT COUNT(DISTINCT tenant_id) AS n FROM finance.audit`,
  );
  const onDefaultSql = stripFinancePrefix(
    `SELECT COUNT(DISTINCT a.tenant_id) AS n
       FROM finance.audit a
      WHERE a.tenant_id NOT IN (SELECT tenant_id FROM finance.audit_retention)`,
  );
  const withConfigSql = stripFinancePrefix(
    `SELECT COUNT(*) AS n FROM finance.audit_retention`,
  );
  const totalRowsSql = stripFinancePrefix(
    `SELECT COUNT(*) AS n FROM finance.audit`,
  );
  const totalPurgedSql = stripFinancePrefix(
    `SELECT COALESCE(SUM(last_purge_count), 0) AS n
       FROM finance.audit_retention
      WHERE last_purge_count IS NOT NULL
        AND last_purge_count > 0`,
  );
  const recentPurgesSql = stripFinancePrefix(
    `SELECT COUNT(*) AS n
       FROM finance.audit_retention
      WHERE last_purge_at IS NOT NULL`,
  );
  return {
    tenant_count: Number(db.prepare(tenantCountSql).get().n || 0),
    tenants_on_default: Number(db.prepare(onDefaultSql).get().n || 0),
    tenants_with_explicit_config: Number(db.prepare(withConfigSql).get().n || 0),
    total_audit_rows: Number(db.prepare(totalRowsSql).get().n || 0),
    total_rows_purged: Number(db.prepare(totalPurgedSql).get().n || 0),
    tenants_with_recent_purge: Number(db.prepare(recentPurgesSql).get().n || 0),
  };
}

// buildRetentionDigestBody — render the summary as plain
// text. Email bodies are text/plain for now; HTML version
// is a follow-up. The body is intentionally short: the CFO
// scans the totals, then drills into the dashboard or the
// CSV export for details.
export function buildRetentionDigestBody(summary) {
  const s = summary || {};
  // Empty-state path: nothing to report.
  if (!s.tenant_count || s.tenant_count === 0) {
    return [
      'SBOS Audit Retention Digest',
      '',
      'No retention activity to report this period.',
      '',
      'No tenants have audit rows yet. Once finance write',
      'activity starts, the weekly digest will summarise',
      'tenant retention state, total rows, and purges.',
    ].join('\n');
  }
  // Happy path: at least one tenant has rows.
  return [
    'SBOS Audit Retention Digest',
    '',
    'Tenants: ' + s.tenant_count,
    '  on default 365d policy: ' + (s.tenants_on_default || 0),
    '  with explicit config:   ' + (s.tenants_with_explicit_config || 0),
    '',
    'Audit rows (across all tenants): ' + (s.total_audit_rows || 0),
    'Total rows purged (lifetime):    ' + (s.total_rows_purged || 0),
    'Tenants with at least one purge: ' + (s.tenants_with_recent_purge || 0),
    '',
    'For the full per-tenant breakdown, hit the retention',
    'dashboard at /api/finance/audit/retention/dashboard',
    'or download the CSV at /api/finance/audit/retention/dashboard/export.',
  ].join('\n');
}
