// SBOS-A1-ERP lockout purge (Wave 73).
//
// Background: the W38 lockout policy increments
// `users.failed_logins` on every failed login attempt and
// sets `users.locked_until` when the threshold is hit.
// The lockout check is time-bound: if `locked_until` is in
// the past, the next login proceeds. BUT the leftover
// `failed_logins` count is still there, which:
//   1. pollutes the W59 "approaching lockout" dashboard
//      (a user with 4 failed_logins from 2 weeks ago
//      shows up as "approaching lockout" forever).
//   2. keeps the `users` table growing in counter values
//      (cosmetic but not great for operators reading the
//      raw row).
//
// W73: a periodic purge that resets `failed_logins = 0`
// and `locked_until = NULL` for users whose LAST failed
// attempt was more than the threshold (default 24h) ago.
// The user is then effectively "fresh" — the next failed
// login starts the count from 0.
//
// The threshold is configurable via opts.staleAfterMs
// (default 24h) so tests can use a small value.
//
// The function is pure: it takes a db handle and options,
// returns a count of cleared rows. No side effects beyond
// the SQL writes. The boot path wires it into a
// setInterval worker (opt-in via SBOS_LOCKOUT_PURGE_ENABLED).

/**
 * Reset `failed_logins` + `locked_until` for users whose
 * last failed attempt is older than the threshold.
 *
 * @param {object} db — sqlite handle with a `prepare`
 *                       method. Reads from `users`,
 *                       writes to `users`.
 * @param {object} [opts]
 * @param {number} [opts.staleAfterMs=24*60*60*1000] —
 *                       only purge rows with
 *                       `last_failed_at < now - staleAfterMs`.
 *                       Default 24h.
 * @param {boolean} [opts.dryRun=false] — if true, count
 *                        the matching rows but don't write.
 * @param {() => number} [opts.now=Date.now] — clock
 *                        injection for tests.
 * @returns {{ cleared: number, scanned: number, dryRun: boolean, threshold: number }}
 */
export function clearStaleFailedLogins(db, opts = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('clearStaleFailedLogins requires a db handle with prepare()');
  }
  const staleAfterMs = Number.isInteger(opts.staleAfterMs)
    ? opts.staleAfterMs
    : 24 * 60 * 60 * 1000; // 24 hours
  const dryRun = opts.dryRun === true;
  const now = typeof opts.now === 'function' ? opts.now() : Date.now();
  const thresholdMs = now - staleAfterMs;
  // SQLite stores datetimes in 'YYYY-MM-DD HH:MM:SS' format.
  // Compute the threshold in the same format so the
  // comparison is string-comparable (lexicographic =
  // chronological for this format).
  const threshold = new Date(thresholdMs)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  // Count scanned users with non-zero failed_logins (for
  // the metrics snapshot). Excludes the admin-sentinel
  // value 99 (locked by admin — see W59 bulk-unlock).
  const scannedRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM users
       WHERE failed_logins > 0
         AND failed_logins < 99
         AND last_failed_at IS NOT NULL`,
    )
    .get();
  const scanned = Number(scannedRow ? scannedRow.n : 0);

  if (dryRun) {
    return { cleared: 0, scanned, dryRun: true, threshold };
  }

  const result = db
    .prepare(
      `UPDATE users
       SET failed_logins = 0, locked_until = NULL
       WHERE failed_logins > 0
         AND failed_logins < 99
         AND last_failed_at IS NOT NULL
         AND last_failed_at < ?`,
    )
    .run(threshold);
  return {
    cleared: Number(result.changes || 0),
    scanned,
    dryRun: false,
    threshold,
  };
}

/**
 * Start a periodic purge worker. Mirrors the W60 audit
 * retention + W66 history worker pattern: opt-in via
 * `SBOS_LOCKOUT_PURGE_ENABLED=true`, default tick 24h
 * (floored at 60s), returns a handle with a `stop()`
 * method.
 *
 * The handle's `lastResult` getter exposes the most
 * recent clearStaleFailedLogins result so the operator
 * dashboard / smoke step can verify the worker is alive.
 *
 * @param {object} opts
 * @param {object} opts.db — sqlite handle
 * @param {number} [opts.tickMs=24*60*60*1000]
 * @returns {{ stop: () => void, lastResult: () => object|null }}
 */
export function startLockoutPurge({ db, tickMs = 24 * 60 * 60 * 1000 } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('startLockoutPurge requires a db handle with prepare()');
  }
  const tick = Math.max(60_000, Math.floor(tickMs));
  let result = null;
  // Run once on boot so a freshly-restarted server doesn't
  // wait a full tick to clear obvious stale rows.
  try {
    result = clearStaleFailedLogins(db);
  } catch (err) {
    // Defensive: log and keep the worker alive.
    console.error('[lockout-purge] initial run failed:', err && err.message);
  }
  const timer = setInterval(() => {
    try {
      result = clearStaleFailedLogins(db);
    } catch (err) {
      console.error('[lockout-purge] tick failed:', err && err.message);
    }
  }, tick);
  // Don't keep the process alive just for the worker.
  if (timer.unref) timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
    lastResult() {
      return result;
    },
  };
}
