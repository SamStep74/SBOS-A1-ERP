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

// ────────────────────────────────────────────────────────────────────────
// W67: retention history CSV export.
//
// streamRetentionHistoryCsv — async generator that yields the
// history rows as CSV. Mirrors the W64 dashboard CSV pattern
// and the W40 audit CSV pattern: header first, memory-
// bounded by chunk size, the caller (Express route) can
// pipe each chunk to res as it's produced.
// ────────────────────────────────────────────────────────────────────────

const HISTORY_CSV_HEADERS = Object.freeze([
  'tenant_id',
  'snapshot_at',
  'retention_days',
  'has_explicit_config',
  'audit_row_count',
  'last_purge_at',
  'last_purge_count',
  'last_purge_days',
]);

function historyCsvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function historyCsvLine(values) {
  return values.map(historyCsvEscape).join(',') + '\n';
}

// Stream the history as CSV. The generator yields
// one chunk at a time (a string ready to write to res).
// No buffering of the full output in memory.
//
// @param {object} db   raw node:sqlite handle
// @param {object} opts { tenantId, since?, until?, limit? }
// @param {number} [chunkSize=500]  rows per yield
export async function* streamRetentionHistoryCsv(db, opts = {}, chunkSize = 500) {
  const size = Math.min(Math.max(Number(chunkSize) || 500, 1), 5000);
  // Pull every snapshot via the existing pure function
  // (single round-trip; no per-row queries).
  const history = listRetentionHistory(db, opts);
  // Header first.
  yield historyCsvLine(HISTORY_CSV_HEADERS);
  // Iterate. items.length is bounded by the limit
  // (default 100, max 1000). chunkSize mostly matters
  // when the caller asks for the maximum.
  let buf = [];
  for (const item of history.items) {
    buf.push(historyCsvLine([
      item.tenant_id,
      item.snapshot_at,
      item.retention_days,
      item.has_explicit_config ? 1 : 0,
      item.audit_row_count,
      item.last_purge_at,
      // last_purge_days is in the dashboard JSON but not
      // in the per-snapshot row (we don't snapshot it;
      // the dashboard reads it from the live config). We
      // include it as null in the CSV for schema stability.
      null,
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
// W68: retention history diff.
//
// diffRetentionSnapshots — compare two retention snapshots
// and return per-tenant deltas. The CFO can ask "what
// changed between last Tuesday and this Tuesday?" — a
// real compliance use case for retention state changes.
//
// Returns:
//   {
//     from:  <iso timestamp of the baseline snapshot>,
//     to:    <iso timestamp of the current snapshot>,
//     added:   [tenant_id, ...],   // tenants in `to` but not in `from`
//     removed: [tenant_id, ...],   // tenants in `from` but not in `to`
//     changed: [
//       {
//         tenant_id,
//         retention_days: { from, to },
//         has_explicit_config: { from, to },
//         audit_row_count: { from, to },
//         last_purge_at: { from, to },
//         last_purge_count: { from, to },
//       },
//       ...
//     ],
//   }
//
// The function picks the closest snapshot to each
// `from` / `to` timestamp. Operators usually pass a
// timestamp like "last Tuesday" and we use the nearest
// recorded snapshot at-or-before that time.
// ────────────────────────────────────────────────────────────────────────

// pickSnapshot — fetch the single closest snapshot at-or-
// before the given timestamp for a tenant. Returns null
// if no snapshot exists.
function pickSnapshot(db, tenantId, at) {
  const sql = stripFinancePrefix(
    `SELECT id, tenant_id, snapshot_at, retention_days,
            has_explicit_config, audit_row_count,
            last_purge_at, last_purge_count
       FROM finance.retention_history
      WHERE tenant_id = ? AND snapshot_at <= ?
      ORDER BY snapshot_at DESC
      LIMIT 1`,
  );
  return db.prepare(sql).get(tenantId, at) || null;
}

// pickSnapshotInRange — fetch the closest snapshot in the
// half-open range (fromTs, toTs] for a tenant. Used by
// the diff to detect "removed" tenants (those that had
// activity at-or-before `fromTs` but no new activity in
// the window). Returns null if no snapshot is in the
// range. Note: we use the half-open interval so the
// "from" snapshot is NOT counted as a "change in the
// window" — it IS the baseline.
function pickSnapshotInRange(db, tenantId, fromTs, toTs) {
  const sql = stripFinancePrefix(
    `SELECT id, tenant_id, snapshot_at, retention_days,
            has_explicit_config, audit_row_count,
            last_purge_at, last_purge_count
       FROM finance.retention_history
      WHERE tenant_id = ? AND snapshot_at > ?
        AND snapshot_at <= ?
      ORDER BY snapshot_at DESC
      LIMIT 1`,
  );
  return db.prepare(sql).get(tenantId, fromTs, toTs) || null;
}

// allTenantsAt — return the set of tenant_ids that
// have any snapshot at-or-before the given timestamp.
// Used to build the union of tenants across from/to.
function allTenantsAt(db, at) {
  const sql = stripFinancePrefix(
    `SELECT DISTINCT tenant_id
       FROM finance.retention_history
      WHERE snapshot_at <= ?`,
  );
  return db.prepare(sql).all(at).map((r) => Number(r.tenant_id));
}

function normaliseRow(row) {
  if (!row) return null;
  return {
    tenant_id: Number(row.tenant_id),
    retention_days: Number(row.retention_days),
    has_explicit_config: Number(row.has_explicit_config) === 1,
    audit_row_count: Number(row.audit_row_count),
    last_purge_at: row.last_purge_at || null,
    last_purge_count:
      row.last_purge_count == null ? null : Number(row.last_purge_count),
  };
}

export function diffRetentionSnapshots(db, opts = {}) {
  const from = String(opts.from || '').trim();
  const to = String(opts.to || '').trim();
  if (!from) throw new RangeError('from is required (ISO timestamp)');
  if (!to) throw new RangeError('to is required (ISO timestamp)');

  // Union of tenants across both timestamps — covers
  // tenants that exist on one side but not the other.
  const allTenants = new Set([...allTenantsAt(db, from), ...allTenantsAt(db, to)]);
  const added = [];
  const removed = [];
  const changed = [];
  for (const tid of allTenants) {
    // The "from" snapshot is the baseline (at-or-before
    // `from`). The "to" snapshot is the latest one in
    // the (from, to] window — i.e. a snapshot STRICTLY
    // after the baseline. This way, the baseline itself
    // is not counted as a "change" for the same tenant.
    const fromRow = normaliseRow(pickSnapshot(db, tid, from));
    const toRow = normaliseRow(pickSnapshotInRange(db, tid, from, to));
    if (fromRow && !toRow) {
      // No new snapshot in the (from, to] window. The
      // tenant is "removed" UNLESS from === to (the
      // window is empty, so there's nothing to compare).
      if (from === to) {
        // from === to: there's no window at all, so
        // there's no "change". Skip.
        continue;
      }
      // Tenant had a baseline at `from` but no new
      // snapshot in the window. We classify as "removed"
      // — the operator's data may have been purged, the
      // tenant may have been deleted, or the auto-snapshot
      // worker may have skipped it (e.g. no audit rows).
      // Either way it's a signal worth surfacing.
      removed.push(tid);
      continue;
    }
    if (!fromRow && toRow) {
      added.push(tid);
      continue;
    }
    if (!fromRow && !toRow) {
      // No snapshots on either side — shouldn't happen
      // because we built the union from allTenantsAt,
      // but defensively skip.
      continue;
    }
    // Both exist. Compare fields. A tenant is "changed"
    // iff at least one field differs.
    if (
      fromRow.retention_days !== toRow.retention_days ||
      fromRow.has_explicit_config !== toRow.has_explicit_config ||
      fromRow.audit_row_count !== toRow.audit_row_count ||
      fromRow.last_purge_at !== toRow.last_purge_at ||
      fromRow.last_purge_count !== toRow.last_purge_count
    ) {
      changed.push({
        tenant_id: tid,
        retention_days: {
          from: fromRow.retention_days,
          to: toRow.retention_days,
        },
        has_explicit_config: {
          from: fromRow.has_explicit_config,
          to: toRow.has_explicit_config,
        },
        audit_row_count: {
          from: fromRow.audit_row_count,
          to: toRow.audit_row_count,
        },
        last_purge_at: {
          from: fromRow.last_purge_at,
          to: toRow.last_purge_at,
        },
        last_purge_count: {
          from: fromRow.last_purge_count,
          to: toRow.last_purge_count,
        },
      });
    }
    // else: unchanged — not in any of the lists.
  }
  return {
    from,
    to,
    added: added.sort((a, b) => a - b),
    removed: removed.sort((a, b) => a - b),
    changed: changed.sort((a, b) => a.tenant_id - b.tenant_id),
  };
}
