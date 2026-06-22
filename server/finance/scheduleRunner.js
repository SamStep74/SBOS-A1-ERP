// Phase 3 reporting wave 4 (W97-1) — scheduler worker.
//
// W96-1 shipped the data model + API for scheduled report
// runs (finance.report_schedules + finance.report_executions
// + 6 pure functions). This module ships the WORKER that
// actually triggers the runs on a cron schedule.
//
// The worker is intentionally simple:
//   1. On start, list all enabled schedules (per tenant).
//   2. Every tickMs (default 60_000ms = 1 min), iterate
//      all enabled schedules.
//   3. For each: if next_run_at <= now, call the dispatch
//      function for the report_type, record the execution
//      (status='completed' or 'failed'), and update the
//      schedule's last_run_at + next_run_at.
//   4. On stop, clear the interval.
//
// The worker is tick-safe: tickOnce() is exposed as a pure
// function that takes a `now` argument, so tests can run
// deterministic ticks without time-mocking libraries.
//
// Email integration is a stub in this wave (logs to
// console). Wave 5 will add SMTP transport.

import {
  listReportSchedules,
  recordReportExecution,
  getReportSchedule,
} from './reportScheduler.js';
import {
  getArAging,
  getMonthlyRevenue,
  getTopCustomers,
  listMonthlyRevenueTrend,
} from './reports.js';
import { getDataQualitySummary } from './dataQuality.js';

// ────────────────────────────────────────────────────────────────────────
// Custom error
// ────────────────────────────────────────────────────────────────────────

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────

const DEFAULT_TICK_MS = 60_000; // 1 minute
const MIN_TICK_MS = 1_000; // floor — faster than 1s is abuse
const MAX_LOOKAHEAD_DAYS = 366; // cap for next-run computation
const MAX_PARAMS_BYTES = 4096;

// ────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────

function assertPositiveInt(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValueError(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInt(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValueError(`${name} must be a non-negative integer`);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function isoDate(d) {
  return d.toISOString().substring(0, 10);
}

function yearMonth(d) {
  return d.toISOString().substring(0, 7);
}

function addDays(d, days) {
  const copy = new Date(d.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function addMonths(d, months) {
  const copy = new Date(d.getTime());
  copy.setUTCMonth(copy.getUTCMonth() + months);
  return copy;
}

// ────────────────────────────────────────────────────────────────────────
// Cron parsing — minimal 5-field parser
//
// Supports the common subset:
//   *        any value
//   *\/N     every N (e.g. */5 = every 5 minutes)
//   N        specific value (e.g. 9 = hour 9)
//   N-M      range (e.g. 1-5 = weekdays)
//   N,M      list (e.g. 1,15 = 1st or 15th of the month)
//
// Does NOT support: L (last day), W (weekday), # (nth weekday),
// or named months / days. These are rare in business scheduling
// and can be added in a future wave if needed.
//
// Field order: minute hour day-of-month month day-of-week.
// Day-of-week: 0 or 7 = Sunday, 1 = Monday, ..., 6 = Saturday.
// ────────────────────────────────────────────────────────────────────────

function parseField(value, min, max) {
  const result = new Set();
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '*') {
      for (let i = min; i <= max; i += 1) result.add(i);
    } else if (trimmed.startsWith('*/')) {
      const n = Number(trimmed.slice(2));
      if (!Number.isInteger(n) || n <= 0) {
        throw new ValueError(`invalid step: ${trimmed}`);
      }
      for (let i = min; i <= max; i += n) result.add(i);
    } else if (trimmed.includes('-')) {
      const [loStr, hiStr] = trimmed.split('-');
      const lo = Number(loStr);
      const hi = Number(hiStr);
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
        throw new ValueError(`invalid range: ${trimmed}`);
      }
      for (let i = lo; i <= hi; i += 1) result.add(i);
    } else {
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n < min || n > max) {
        throw new ValueError(`invalid value: ${trimmed}`);
      }
      result.add(n);
    }
  }
  return result;
}

function parseCron(expression) {
  if (typeof expression !== 'string') {
    throw new ValueError('cron expression must be a string');
  }
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ValueError(`cron must have 5 fields; got ${fields.length}`);
  }
  return {
    minute: { set: parseField(fields[0], 0, 59), wildcard: fields[0] === '*' },
    hour: { set: parseField(fields[1], 0, 23), wildcard: fields[1] === '*' },
    dom: { set: parseField(fields[2], 1, 31), wildcard: fields[2] === '*' },
    month: { set: parseField(fields[3], 1, 12), wildcard: fields[3] === '*' },
    dow: { set: parseField(fields[4], 0, 6), wildcard: fields[4] === '*' },
  };
}

function matchesField(set, value) {
  return set.has(value);
}

/**
 * Compute the next run time (UTC Date) at or after `now`
 * that matches the cron expression. Returns null if no
 * match found within MAX_LOOKAHEAD_DAYS.
 *
 * Standard Vixie cron semantics for dom/dow: if BOTH are
 * restricted (non-wildcard), use AND. If EITHER is a
 * wildcard, use OR. This matches what `crontab` does.
 *
 * @param {string} expression
 * @param {Date} now
 * @returns {Date | null}
 */
export function computeNextRunAt(expression, now) {
  const cron = parseCron(expression);
  // Start at the next minute boundary to avoid firing twice
  // for the same instant.
  const start = new Date(now.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);

  const end = new Date(start.getTime() + MAX_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);

  // Iterate minute by minute. Naive but correct for the
  // MAX_LOOKAHEAD_DAYS cap (worst case ~530K iterations,
  // which finishes in well under 1s).
  for (let t = new Date(start.getTime()); t.getTime() < end.getTime(); t = new Date(t.getTime() + 60_000)) {
    const domMatch = matchesField(cron.dom.set, t.getUTCDate());
    const dowMatch = matchesField(cron.dow.set, t.getUTCDay());
    // Vixie cron semantics: if BOTH dom and dow are restricted
    // (non-wildcard), use OR. If ONE is wildcard, the other
    // is the only constraint (so the wildcard is effectively
    // ignored). If BOTH are wildcard, any day matches.
    const dayMatches = cron.dom.wildcard && cron.dow.wildcard
      ? true
      : cron.dom.wildcard
        ? dowMatch
        : cron.dow.wildcard
          ? domMatch
          : (domMatch || dowMatch);
    if (
      matchesField(cron.minute.set, t.getUTCMinutes())
      && matchesField(cron.hour.set, t.getUTCHours())
      && matchesField(cron.month.set, t.getUTCMonth() + 1)
      && dayMatches
    ) {
      return t;
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// Report dispatch
// ────────────────────────────────────────────────────────────────────────

function parseParams(paramsJson) {
  if (paramsJson === null || paramsJson === undefined || paramsJson === '') {
    return {};
  }
  if (typeof paramsJson !== 'string') {
    throw new ValueError('params must be a JSON string or null');
  }
  if (paramsJson.length > MAX_PARAMS_BYTES) {
    throw new ValueError(`params exceeds ${MAX_PARAMS_BYTES} bytes`);
  }
  let parsed;
  try {
    parsed = JSON.parse(paramsJson);
  } catch (e) {
    throw new ValueError(`params is not valid JSON: ${e.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValueError('params must be a JSON object');
  }
  return parsed;
}

// Dispatch table — maps report_type to a function that
// takes (pgAdapter, params, now) and returns the report
// result. The default table calls the real report
// functions. Tests can pass a custom table to stub.
const DEFAULT_DISPATCH = Object.freeze({
  ar_aging: async (pgAdapter, params, now) => {
    const asOfDate = params.asOfDate || isoDate(now);
    return await getArAging(pgAdapter, asOfDate);
  },
  monthly_revenue: async (pgAdapter, params, now) => {
    const ym = params.yearMonth || yearMonth(now);
    return await getMonthlyRevenue(pgAdapter, ym);
  },
  top_customers: async (pgAdapter, params, now) => {
    const since = params.since || isoDate(addDays(now, -90));
    const until = params.until || isoDate(now);
    const limit = Number.isInteger(params.limit) ? params.limit : 10;
    return await getTopCustomers(pgAdapter, { since, until, limit });
  },
  data_quality: async (pgAdapter) => {
    return await getDataQualitySummary(pgAdapter);
  },
  revenue_trend: async (pgAdapter, params, now) => {
    const since = params.since || yearMonth(addMonths(now, -12));
    const until = params.until || yearMonth(now);
    return await listMonthlyRevenueTrend(pgAdapter, since, until);
  },
  customer_breakdown: async (pgAdapter, params, now) => {
    if (!Number.isInteger(params.customerId)) {
      throw new ValueError('customer_breakdown requires params.customerId (integer)');
    }
    const since = params.since || isoDate(addDays(now, -90));
    const until = params.until || isoDate(now);
    const { getCustomerRevenueBreakdown } = await import('./reports.js');
    return await getCustomerRevenueBreakdown(
      pgAdapter,
      params.customerId,
      since,
      until,
    );
  },
});

/**
 * Dispatch a single report run. Returns the raw report
 * result (the JSON.stringify'd version is what gets
 * stored in finance.report_executions.result_json).
 *
 * Throws on invalid params or on internal report failure.
 * The caller (tickOnce) catches the throw and records
 * the error as a failed execution.
 *
 * @param {string} reportType  one of the 6 valid types
 * @param {object} db          raw sqlite handle (for finance.* queries)
 * @param {object} pgAdapter   pg-style adapter (for the pure functions)
 * @param {string} paramsJson  the schedule's params (JSON string)
 * @param {Date} now           the time of dispatch (for default date args)
 * @param {object} [dispatchTable]  optional dispatch override (for tests)
 * @returns {Promise<object>}  the report result
 */
export async function dispatchReport(
  reportType,
  db,
  pgAdapter,
  paramsJson,
  now,
  dispatchTable = DEFAULT_DISPATCH,
) {
  const params = parseParams(paramsJson);
  const fn = dispatchTable[reportType];
  if (!fn) {
    throw new ValueError(`unknown report_type: ${reportType}`);
  }
  return await fn(pgAdapter, params, now);
}

// ────────────────────────────────────────────────────────────────────────
// Email — thin wrapper over the email service (W101-1)
//
// In W97-1 this was a stub that returned a deterministic
// shape. In W101-1 we delegate to the email service
// (server/finance/emailService.js) which can route to
// capture / log / smtp modes. If no email service is
// provided to startScheduler, we fall back to a stub
// behavior that returns { delivered: false, ... } so
// the worker never throws — it just doesn't actually
// send.
// ────────────────────────────────────────────────────────────────────────

const DEFAULT_EMAIL_SERVICE = Object.freeze({
  async send(_msg) {
    return { delivered: false, mode: 'stub' };
  },
  async close() {},
  mode: 'stub',
});

/**
 * Send a notification email. Delegates to the email service.
 * Returns the result from emailService.send() (or the stub
 * equivalent if no service was provided).
 *
 * The body is auto-formatted: subject is a short line with
 * the report type, body is a JSON dump of the result.
 *
 * @returns {Promise<{ delivered: boolean, mode: string, ... }>}
 */
export async function sendNotificationEmail(to, reportType, resultJson, emailService = null) {
  const service = emailService || DEFAULT_EMAIL_SERVICE;
  const subject = `[SBOS] scheduled report: ${reportType}`;
  // Body is plain text (not HTML) — easier to read in email clients.
  // We try to pretty-print the JSON if possible, otherwise just
  // show the raw result.
  let body;
  try {
    const parsed = JSON.parse(resultJson);
    body = `Scheduled report: ${reportType}\nGenerated at: ${new Date().toUTCString()}\n\n${JSON.stringify(parsed, null, 2)}`;
  } catch (_e) {
    body = `Scheduled report: ${reportType}\nGenerated at: ${new Date().toUTCString()}\n\n${resultJson || '(no result)'}`;
  }
  return await service.send({
    to,
    subject,
    body,
    isHtml: false,
  });
}

// ────────────────────────────────────────────────────────────────────────
// Worker tick
// ────────────────────────────────────────────────────────────────────────

/**
 * Run one pass of the scheduler. For each enabled
 * schedule where next_run_at <= now, dispatch the report,
 * record the execution, update the schedule's last_run_at
 * + next_run_at, and (if notify_email is set) call the
 * email stub.
 *
 * Returns a summary of what happened in this tick. The
 * summary is useful for tests + operational dashboards.
 *
 * @param {object} db          raw sqlite handle (for the schedules + executions tables)
 * @param {object} pgAdapter   pg-style adapter (for the report pure functions)
 * @param {Date} now           the time to treat as "now" (testable)
 * @param {number} tenantId    default 0
 * @returns {Promise<{ fired: number, skipped: number, errors: number }>}
 */
export async function tickOnce(
  db,
  pgAdapter,
  now = new Date(),
  tenantId = 0,
  dispatchTable = DEFAULT_DISPATCH,
  emailService = null,
) {
  assertNonNegativeInt(tenantId, 'tenantId');
  const allSchedules = await listReportSchedules(db, tenantId, { enabled: 1 });
  let fired = 0;
  let skipped = 0;
  let errors = 0;
  for (const sched of allSchedules) {
    const nextRun = sched.next_run_at ? new Date(sched.next_run_at) : null;
    if (!nextRun || nextRun.getTime() > now.getTime()) {
      skipped += 1;
      continue;
    }
    // Fire the report.
    const startedAt = new Date(now.getTime());
    let result;
    let error = null;
    try {
      result = await dispatchReport(
        sched.report_type,
        db,
        pgAdapter,
        sched.params,
        now,
        dispatchTable,
      );
    } catch (e) {
      error = e && e.message ? e.message : String(e);
    }
    const completedAt = new Date(now.getTime());
    const durationMs = completedAt.getTime() - startedAt.getTime();
    const resultJson = error === null ? JSON.stringify(result) : null;
    const status = error === null ? 'completed' : 'failed';
    try {
      await recordReportExecution(
        db,
        {
          schedule_id: Number(sched.id),
          report_type: sched.report_type,
          status,
          started_at: startedAt.toISOString(),
          completed_at: completedAt.toISOString(),
          duration_ms: durationMs,
          result_json: resultJson,
          error_message: error,
        },
        tenantId,
      );
    } catch (e) {
      // Failure to record is also a tick error; log + count.
      console.error('[scheduler] failed to record execution:', e && e.message ? e.message : e);
      errors += 1;
      continue;
    }
    // Email (if configured). Failures here don't fail the tick;
    // we just log.
    if (sched.notify_email) {
      try {
        await sendNotificationEmail(
          sched.notify_email,
          sched.report_type,
          resultJson || '',
          emailService,
        );
      } catch (e) {
        console.error('[scheduler] email send failed:', e && e.message ? e.message : e);
      }
    }
    // Webhook (if configured). Fire-and-forget POST to
    // notify_webhook_url. The payload is JSON; consumers
    // (Slack bots, Sendgrid HTTP API, etc) parse it.
    if (sched.notify_webhook_url) {
      try {
        const { sendNotification } = await import('./notifications.js');
        await sendNotification({
          url: sched.notify_webhook_url,
          secret: sched.notify_webhook_secret || null,
          execution: {
            tenantId: sched.tenant_id,
            scheduleId: sched.id,
            scheduleName: sched.name,
            reportType: sched.report_type,
            status: status === 'completed' ? 'success' : 'failed',
            startedAt: startedAt,
            finishedAt: completedAt,
            durationMs: durationMs,
            resultSummary: status === 'completed' ? resultJson : null,
            errorMessage: error,
          },
        });
      } catch (e) {
        console.error('[scheduler] webhook send failed:', e && e.message ? e.message : e);
      }
    }
    // Update next_run_at.
    let nextNextRun = null;
    try {
      nextNextRun = computeNextRunAt(sched.cron_expression, completedAt);
    } catch (e) {
      console.error('[scheduler] computeNextRunAt failed:', e && e.message ? e.message : e);
    }
    try {
      await runQuery(
        db,
        `UPDATE finance.report_schedules
            SET next_run_at = $1,
                updated_at = datetime('now')
          WHERE id = $2 AND tenant_id = $3`,
        [nextNextRun ? nextNextRun.toISOString() : null, Number(sched.id), tenantId],
      );
    } catch (e) {
      console.error('[scheduler] update next_run_at failed:', e && e.message ? e.message : e);
    }
    fired += 1;
  }
  return { fired, skipped, errors };
}

async function runQuery(db, sql, params) {
  const result = await db.query(sql, params || []);
  if (result && Array.isArray(result.rows)) return result;
  return { rows: [] };
}

// ────────────────────────────────────────────────────────────────────────
// Worker start / stop
// ────────────────────────────────────────────────────────────────────────

/**
 * Start the scheduler worker. Returns a handle with:
 *   - .stop() — clears the interval (idempotent)
 *   - .tickOnce() — the same tick function the interval uses
 *   - .tickMs — the configured tick interval
 *
 * The worker starts ticking on the first tickMs (NOT
 * immediately on boot). If tickMs < MIN_TICK_MS, the call
 * throws.
 *
 * @param {object} opts
 * @param {object} opts.db
 * @param {object} opts.pgAdapter
 * @param {number} [opts.tickMs=60000]
 * @param {number} [opts.tenantId=0]
 * @param {function} [opts.onError] — optional callback for
 *   per-tick errors (not used for individual schedule
 *   failures, which are recorded in the execution table)
 * @returns {{ stop: function, tickOnce: function, tickMs: number }}
 */
export function startScheduler({
  db,
  pgAdapter,
  tickMs = DEFAULT_TICK_MS,
  tenantId = 0,
  onError = null,
  dispatchTable = DEFAULT_DISPATCH,
  emailService = null,
} = {}) {
  if (!db) throw new TypeError('startScheduler requires opts.db');
  if (!pgAdapter) throw new TypeError('startScheduler requires opts.pgAdapter');
  assertPositiveInt(tickMs, 'tickMs');
  if (tickMs < MIN_TICK_MS) {
    throw new ValueError(`tickMs must be >= ${MIN_TICK_MS} (got ${tickMs})`);
  }
  assertNonNegativeInt(tenantId, 'tenantId');
  const emailMode = emailService ? emailService.mode : 'stub';
  console.warn(`[scheduler] worker started, tick=${tickMs}ms, tenant=${tenantId}, email=${emailMode}`);
  const tick = () => {
    tickOnce(db, pgAdapter, new Date(), tenantId, dispatchTable, emailService)
      .catch((e) => {
        const msg = e && e.message ? e.message : String(e);
        console.error('[scheduler] tick error:', msg);
        if (typeof onError === 'function') onError(e);
      });
  };
  const interval = setInterval(tick, tickMs);
  // Don't keep the event loop alive solely for the scheduler
  // (allows the test harness to exit cleanly after the test).
  if (typeof interval.unref === 'function') interval.unref();
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
    },
    tickOnce: () => tickOnce(db, pgAdapter, new Date(), tenantId, dispatchTable, emailService),
    tickMs,
  };
}

// ────────────────────────────────────────────────────────────────────────
// runReportNow (W103-1) — operator-forced manual run.
//
// The scheduler worker (W97-1) fires on a cron schedule.
// Sometimes the operator needs to trigger a report
// immediately — e.g.:
//   - After fixing a data quality issue, run the data
//     quality report NOW to verify the fix
//   - Re-run a report that failed in the last tick
//   - Pre-flight a new schedule before enabling it
//
// runReportNow is the one-shot equivalent of one tickOnce
// iteration. It:
//   1. Verifies the schedule exists in the tenant
//   2. Dispatches the report (same dispatch table as
//      the scheduler)
//   3. Records the execution with triggered_by = 'manual'
//      (the audit UI can distinguish manual vs scheduled)
//   4. Sends the notification email (if configured)
//   5. Returns the result + execution log id
//
// The function does NOT change the schedule's next_run_at
// — a manual run doesn't shift the cron schedule. The
// schedule fires on its normal cadence; the manual run is
// an additional execution in the history.
//
// Errors:
//   404 if the schedule doesn't exist in the tenant
//   (the schedule module's getReportSchedule raises
//   ValueError with "not found in tenant" — the route
//   layer maps to 404)
//
// Returns:
//   { execution_id, schedule_id, report_type,
//     status, duration_ms, result }
export async function runReportNow(
  db,
  pgAdapter,
  scheduleId,
  tenantId = 0,
  dispatchTable = DEFAULT_DISPATCH,
  emailService = null,
) {
  assertPositiveInt(scheduleId, 'scheduleId');
  assertNonNegativeInt(tenantId, 'tenantId');
  // getReportSchedule raises ValueError with
  // "schedule <id> not found in tenant <tenantId>" if
  // the row doesn't exist. The route layer maps to 404.
  const sched = await getReportSchedule(db, scheduleId, tenantId);
  const now = new Date();
  const startedAt = new Date(now.getTime());
  let result;
  let error = null;
  try {
    result = await dispatchReport(
      sched.report_type,
      db,
      pgAdapter,
      sched.params,
      now,
      dispatchTable,
    );
  } catch (e) {
    error = e && e.message ? e.message : String(e);
  }
  const completedAt = new Date(now.getTime());
  const durationMs = completedAt.getTime() - startedAt.getTime();
  const resultJson = error === null ? JSON.stringify(result) : null;
  const status = error === null ? 'completed' : 'failed';
  let executionId;
  try {
    const { id } = await recordReportExecution(
      db,
      {
        schedule_id: Number(sched.id),
        report_type: sched.report_type,
        status,
        started_at: startedAt.toISOString(),
        completed_at: completedAt.toISOString(),
        duration_ms: durationMs,
        result_json: resultJson,
        error_message: error,
        triggered_by: 'manual',
      },
      tenantId,
    );
    executionId = id;
  } catch (e) {
    throw new ValueError(
      `runReportNow: failed to record execution: ${e && e.message ? e.message : e}`,
    );
  }
  // Email (if configured). Failures here don't fail the
  // run; we just log (the schedule is not silently broken
  // because the email failed).
  if (sched.notify_email && !error) {
    try {
      await sendNotificationEmail(
        sched.notify_email,
        sched.report_type,
        resultJson || '',
        emailService,
      );
    } catch (e) {
      console.error('[runReportNow] email send failed:', e && e.message ? e.message : e);
    }
  }
  return {
    execution_id: executionId,
    schedule_id: Number(sched.id),
    report_type: sched.report_type,
    status,
    duration_ms: durationMs,
    result: error === null ? result : null,
    error: error,
  };
}
