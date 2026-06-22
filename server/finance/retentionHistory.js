// SBOS-A1-ERP finance retention history (W66).
//
// Captures per-tenant retention state at a point in time.
// The CFO dashboard (W63) gives a live view; the history
// answers "what did the state look like last Tuesday?"
// — a real operator use case for compliance reporting.
//
// The snapshot is a denormalised copy of the dashboard row
// (tenant_id, retention_days, has_explicit_config,
// audit_row_count, last_purge_at, last_purge_count) plus
// a snapshot_at timestamp. Denormalised so the history is
// immutable and survives config changes — a row reflects
// what was TRUE at snapshot_at, not what's true now.
//
// Auto-snapshot worker (startRetentionSnapshot) is opt-in
// via SBOS_RETENTION_HISTORY_ENABLED=true. Default off so
// existing deploys see no behavior change.

import { getRetentionDashboard } from './auditRetention.js';

function stripFinancePrefix(sql) {
  return String(sql).replace(
    /(?<![A-Za-z0-9_'".])finance\.([A-Za-z_][A-Za-z0-9_]*)/g,
    '$1',
  );
}

// snapshotRetentionDashboard — capture the current
// retention state for every tenant. Returns the number of
// rows written. Idempotent re safety: each call writes a
// NEW row (snapshot_at differs), so a back-to-back call
// produces two rows. Operators query by time range to
// deduplicate.
//
// Implementation: query getRetentionDashboard (single
// round-trip), then bulk INSERT one row per tenant. The
// INSERT is a single multi-row statement for efficiency.
export function snapshotRetentionDashboard(db, snapshotAt) {
  const dashboard = getRetentionDashboard(db);
  if (dashboard.items.length === 0) return 0;
  // Always stamp a real timestamp. The node:sqlite
  // DatabaseSync (test harness) does NOT apply the
  // column DEFAULT when the INSERT passes null. To stay
  // portable across sqlite + pg, we compute the
  // timestamp in JS instead of relying on the column
  // DEFAULT. The format matches the DEFAULT
  // (datetime('now')) — ISO-ish "YYYY-MM-DD HH:MM:SS" UTC.
  const ts = snapshotAt || new Date().toISOString().slice(0, 19).replace('T', ' ');
  const sql = stripFinancePrefix(
    `INSERT INTO finance.retention_history
        (tenant_id, snapshot_at, retention_days, has_explicit_config,
         audit_row_count, last_purge_at, last_purge_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const stmt = db.prepare(sql);
  let count = 0;
  for (const item of dashboard.items) {
    stmt.run(
      item.tenant_id,
      ts,
      item.retention_days,
      item.has_explicit_config ? 1 : 0,
      item.audit_row_count,
      item.last_purge_at,
      item.last_purge_count,
    );
    count += 1;
  }
  return count;
}

// listRetentionHistory — read snapshots. Filters:
//   tenantId: required (we don't return all-tenant
//     history by default; that would expose cross-tenant
//     data through the route's perm gate)
//   since: optional ISO timestamp
//   until: optional ISO timestamp
//   limit: default 100, max 1000
// Sorted: newest first.
export function listRetentionHistory(db, opts = {}) {
  const tid = opts.tenantId == null ? null : Number(opts.tenantId);
  if (tid == null || !Number.isFinite(tid)) {
    throw new TypeError('tenantId is required');
  }
  const where = ['tenant_id = ?'];
  const params = [tid];
  if (opts.since) {
    where.push('snapshot_at >= ?');
    params.push(String(opts.since));
  }
  if (opts.until) {
    where.push('snapshot_at <= ?');
    params.push(String(opts.until));
  }
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 1000);
  const sql = stripFinancePrefix(
    `SELECT id, tenant_id, snapshot_at, retention_days,
            has_explicit_config, audit_row_count,
            last_purge_at, last_purge_count
       FROM finance.retention_history
      WHERE ${where.join(' AND ')}
      ORDER BY snapshot_at DESC
      LIMIT ?`,
  );
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  return {
    items: rows.map((r) => ({
      id: Number(r.id),
      tenant_id: Number(r.tenant_id),
      snapshot_at: r.snapshot_at,
      retention_days: Number(r.retention_days),
      has_explicit_config: Number(r.has_explicit_config) === 1,
      audit_row_count: Number(r.audit_row_count),
      last_purge_at: r.last_purge_at || null,
      last_purge_count:
        r.last_purge_count == null ? null : Number(r.last_purge_count),
    })),
  };
}

// startRetentionSnapshot — opt-in background tick that
// captures the dashboard periodically. Default tickMs is
// 24h, floored at 60_000 (1 min) so an accidental env var
// can't hammer the DB. The first tick fires AFTER tickMs
// (not immediately) so a server starting up has time to
// finish its init.
//
// Returns a handle with stop() + tickNow. The smoke
// runner that kills the server with SIGTERM doesn't want
// an orphan tick; operators who want this off can pass
// SBOS_RETENTION_HISTORY_ENABLED=false.
export function startRetentionSnapshot({
  db,
  tickMs = 24 * 60 * 60 * 1000,
}) {
  if (!db) {
    throw new TypeError('startRetentionSnapshot: db is required');
  }
  const floor = 60_000;
  const tick = Math.max(floor, Number(tickMs) || floor);
  let stopped = false;
  // A controllable sleep that resolves immediately when
  // stop() is called. The default `sleep` (setTimeout)
  // cannot be cancelled, so the background loop would
  // block for the full tick after stop(). We resolve the
  // loop's wait early by triggering a race: the timer
  // fires at `tick`, but a second promise resolves
  // immediately on stop().
  let resolveWait = null;
  const wake = () => {
    if (resolveWait) {
      resolveWait();
      resolveWait = null;
    }
  };
  const tickOnce = () => {
    try {
      return snapshotRetentionDashboard(db);
    } catch (err) {
      // best-effort: log and continue. The next tick
      // will retry.
      try {
        console.error(
          '[retentionHistory] snapshot failed:',
          err && err.message ? err.message : err,
        );
      } catch {
        // ignore logging errors
      }
      return 0;
    }
  };
  const wait = () =>
    new Promise((resolve) => {
      resolveWait = resolve;
      // setTimeout is the default sleep. We capture the
      // timer handle so we can unref() it — the timer
      // shouldn't keep the process alive when nothing
      // else is running (matters for tests + the smoke
      // runner that kills the server with SIGTERM).
      let timer = null;
      const done = () => {
        if (timer) {
          timer = null;
        }
        if (resolveWait === resolve) {
          resolveWait = null;
          resolve();
        }
      };
      timer = setTimeout(done, tick);
      if (timer && typeof timer.unref === 'function') {
        timer.unref();
      }
    });
  const run = async () => {
    while (!stopped) {
      await wait();
      if (stopped) break;
      tickOnce();
    }
  };
  run();
  return {
    stop() {
      stopped = true;
      wake();
    },
    tickMs: tick,
    tickNow: tickOnce,
  };
}
