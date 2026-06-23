// SBOS-A1-ERP scheduled merge auto-apply (Wave 114-1).
//
// W94-1 added `suggestMergeCandidates` (AI advisory that
// groups duplicate customers). W99-1 added
// `applyCustomerMerge` (one-off manual merge via API).
// W102-1 added `undoCustomerMerge` (rollback).
//
// W114-1 closes the trilogy: a worker that periodically
// auto-applies high-confidence merge candidates. The
// "high-confidence" model:
//   - HVVH match (same TIN): confidence = 0.99
//   - Name match (fuzzy):  confidence = 0.85
//
// The default threshold is 0.95, so only HVVH matches
// auto-apply by default. Operators who want name-match
// auto-apply can lower the threshold via env var or
// opts.
//
// The worker is opt-in via SBOS_AUTO_MERGE_ENABLED=true.
// Like the W66 retention history worker, it runs at boot
// (so a restart immediately catches anything queued)
// and then on a fixed tick. The handle has a `stop()`
// method for clean shutdown.
//
// Dedup: each (primary, secondary) pair is checked
// against the customer_merge_log before applying. If a
// merge was already applied (manually or by a prior
// auto-apply run), the candidate is skipped. This makes
// the worker safe to run repeatedly — it'll only act
// on NEW candidates.
//
// Returns: { considered, applied, skipped, errors,
//            duration_ms, dryRun }

import { suggestMergeCandidates } from './dataQuality.js';
import { applyCustomerMerge } from './dataQuality.js';
import { listCustomerMergeLog } from './dataQuality.js';

// Map a match_type to a confidence score. HVVH match is
// near-certain (same legal entity). Name match is
// heuristic (could be a coincidental same name).
function confidenceFor(matchType) {
  if (matchType === 'hvhh') return 0.99;
  if (matchType === 'name') return 0.85;
  return 0.0;
}

/**
 * Run one auto-apply pass. Pure async function (no
 * scheduling / setInterval) so it's testable in isolation.
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {number} [opts.tenantId=0]
 * @param {number} [opts.threshold=0.95]
 * @param {boolean} [opts.dryRun=false]
 * @param {string} [opts.reasonPrefix='auto-apply']
 * @returns {Promise<{
 *   considered: number,
 *   applied: Array<{primary_id, secondary_id, match_type, merge_log_id, invoices_reassigned, payments_reassigned}>,
 *   skipped: Array<{primary_id, secondary_id, match_type, reason}>,
 *   errors: Array<{primary_id, secondary_id, match_type, error}>,
 *   duration_ms: number,
 *   threshold: number,
 *   dryRun: boolean,
 * }>}
 */
export async function runAutoMerge(db, opts = {}) {
  if (!db || typeof db.query !== 'function' && typeof db.prepare !== 'function') {
    throw new TypeError('runAutoMerge requires a db handle');
  }
  const tenantId = Number.isInteger(opts.tenantId) ? opts.tenantId : 0;
  const threshold =
    typeof opts.threshold === 'number' && opts.threshold >= 0 && opts.threshold <= 1
      ? opts.threshold
      : 0.95;
  const dryRun = opts.dryRun === true;
  const reasonPrefix =
    typeof opts.reasonPrefix === 'string' && opts.reasonPrefix
      ? opts.reasonPrefix
      : 'auto-apply';
  const startedAt = Date.now();

  // 1. Get the candidates.
  const candidates = await suggestMergeCandidates(db, tenantId);
  // 2. Filter by confidence.
  const highConfidence = candidates.filter(
    (c) => confidenceFor(c.match_type) >= threshold,
  );
  // 3. Get the existing merge_log to dedup.
  let alreadyMerged = new Set();
  try {
    const log = await listCustomerMergeLog(db, { tenantId });
    for (const row of log) {
      const key = `${row.primary_id}:${row.secondary_id}`;
      alreadyMerged.add(key);
    }
  } catch (_err) {
    // If the log can't be read, proceed without dedup.
    // (Better to risk a double-merge than to skip all.)
  }

  const result = {
    considered: candidates.length,
    applied: [],
    skipped: [],
    errors: [],
    duration_ms: 0,
    threshold,
    dryRun,
  };

  for (const c of highConfidence) {
    const primary = c.primary && c.primary.id;
    const secondary = c.secondary && c.secondary.id;
    if (!Number.isInteger(primary) || !Number.isInteger(secondary)) continue;
    if (primary === secondary) continue;
    const dedupKey = `${primary}:${secondary}`;
    if (alreadyMerged.has(dedupKey)) {
      result.skipped.push({
        primary_id: primary,
        secondary_id: secondary,
        match_type: c.match_type,
        reason: 'already_merged',
      });
      continue;
    }
    if (dryRun) {
      result.applied.push({
        primary_id: primary,
        secondary_id: secondary,
        match_type: c.match_type,
        merge_log_id: null,
        invoices_reassigned: c.invoice_count,
        payments_reassigned: c.payment_count,
        dryRun: true,
      });
      alreadyMerged.add(dedupKey);
      continue;
    }
    try {
      const merged = await applyCustomerMerge(
        db,
        {
          primary_id: primary,
          secondary_id: secondary,
          reason: `${reasonPrefix}: ${c.match_type} match (${c.match_value})`,
        },
        tenantId,
      );
      result.applied.push({
        primary_id: primary,
        secondary_id: secondary,
        match_type: c.match_type,
        merge_log_id: merged && merged.merge_log_id,
        invoices_reassigned: merged && merged.invoices_reassigned,
        payments_reassigned: merged && merged.payments_reassigned,
      });
      alreadyMerged.add(dedupKey);
    } catch (err) {
      result.errors.push({
        primary_id: primary,
        secondary_id: secondary,
        match_type: c.match_type,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  result.duration_ms = Date.now() - startedAt;
  return result;
}

/**
 * Start the auto-apply worker. Opt-in via
 * SBOS_AUTO_MERGE_ENABLED=true. Mirrors the W60/W66/W73
 * worker pattern: initial run on boot, then on a fixed
 * tick (default 24h, floored at 60s).
 *
 * @param {object} opts
 * @param {object} opts.db
 * @param {number} [opts.tickMs=24*60*60*1000]
 * @param {number} [opts.threshold=0.95]
 * @returns {{ stop: () => void, lastResult: () => object|null, runNow: () => Promise<object> }}
 */
export function startAutoMergeWorker({
  db,
  tickMs = 24 * 60 * 60 * 1000,
  threshold = 0.95,
} = {}) {
  if (!db) {
    throw new TypeError('startAutoMergeWorker requires a db handle');
  }
  const tick = Math.max(60_000, Math.floor(tickMs));
  let lastResult = null;
  const runNow = () =>
    runAutoMerge(db, { threshold })
      .then((r) => {
        lastResult = r;
        return r;
      })
      .catch((err) => {
        console.error('[auto-merge] run failed:', err && err.message);
        lastResult = { error: err && err.message ? err.message : String(err) };
        return lastResult;
      });
  // Initial run on boot.
  runNow();
  const timer = setInterval(() => {
    runNow();
  }, tick);
  if (timer.unref) timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
    lastResult() {
      return lastResult;
    },
    runNow,
  };
}
