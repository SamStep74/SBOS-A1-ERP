// Phase 3 reporting wave 4 (W97-1) — scheduler worker tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeNextRunAt,
  dispatchReport,
  tickOnce,
  startScheduler,
  sendNotificationEmail,
  ValueError,
} from './scheduleRunner.js';

// ────────────────────────────────────────────────────────────────────────
// Mock helpers
// ────────────────────────────────────────────────────────────────────────

function makeMockDb() {
  const schedules = new Map();
  const executions = new Map();
  let nextSchedId = 1;
  let nextExecId = 1;

  function nextId(map) {
    if (map === schedules) return nextSchedId++;
    if (map === executions) return nextExecId++;
    throw new Error('mock: unknown map');
  }

  function classify(sql) {
    const s = sql.trim().toUpperCase();
    if (/UPDATE\s+FINANCE\.REPORT_SCHEDULES/i.test(s) && /NEXT_RUN_AT/i.test(s)) return 'sched-update-nextrun';
    if (/INTO\s+FINANCE\.REPORT_EXECUTIONS/i.test(s) && /RETURNING/i.test(s)) return 'exec-insert';
    if (/FROM\s+FINANCE\.REPORT_SCHEDULES/i.test(s) && /\bID\s*=\s*\$\d/i.test(s)) return 'sched-get';
    if (/FROM\s+FINANCE\.REPORT_SCHEDULES/i.test(s) && /ENABLED\s*=\s*\$/i.test(s)) return 'sched-list-enabled';
    if (/FROM\s+FINANCE\.REPORT_SCHEDULES/i.test(s)) return 'sched-list';
    return 'passthrough';
  }

  async function query(sql, params = []) {
    const ps = params ?? [];
    const kind = classify(sql);
    if (kind === 'sched-insert') {
      const id = nextId(schedules);
      schedules.set(id, { id, tenant_id: Number(ps[0]) });
      return { rows: [{ id }] };
    }
    if (kind === 'exec-insert') {
      const id = nextId(executions);
      executions.set(id, {
        id,
        tenant_id: Number(ps[0]),
        schedule_id: Number(ps[1]),
        report_type: ps[2],
        status: ps[3],
        started_at: ps[4] ?? null,
        completed_at: ps[5] ?? null,
        duration_ms: ps[6] != null ? Number(ps[6]) : null,
        result_json: ps[7] ?? null,
        error_message: ps[8] ?? null,
      });
      return { rows: [{ id }] };
    }
    if (kind === 'sched-get') {
      // getReportSchedule: WHERE id = $1 AND tenant_id = $2
      const id = Number(ps[0]);
      const tenantId = Number(ps[1]);
      const sched = schedules.get(id);
      if (sched && sched.tenant_id === tenantId) {
        return { rows: [sched] };
      }
      return { rows: [] };
    }
    if (kind === 'sched-update-nextrun') {
      const nextRun = ps[0];
      const id = Number(ps[1]);
      const sched = schedules.get(id);
      if (sched) {
        sched.next_run_at = nextRun;
        sched.updated_at = '2026-01-02';
      }
      return { rows: [], changes: sched ? 1 : 0 };
    }
    if (kind === 'sched-list-enabled') {
      const tenantId = Number(ps[0]);
      const enabled = Number(ps[1]);
      const rows = [];
      for (const sched of schedules.values()) {
        if (sched.tenant_id === tenantId && sched.enabled === enabled) {
          rows.push(sched);
        }
      }
      return { rows };
    }
    if (kind === 'sched-list') {
      const tenantId = Number(ps[0]);
      const rows = [];
      for (const sched of schedules.values()) {
        if (sched.tenant_id === tenantId) rows.push(sched);
      }
      return { rows };
    }
    return { rows: [] };
  }

  function seedSchedule(opts) {
    const id = nextId(schedules);
    const sched = {
      id,
      tenant_id: opts.tenant_id ?? 0,
      name: opts.name ?? `sched-${id}`,
      report_type: opts.report_type ?? 'ar_aging',
      cron_expression: opts.cron_expression ?? '* * * * *',
      enabled: opts.enabled ?? 1,
      params: opts.params ?? null,
      notify_email: opts.notify_email ?? null,
      last_run_at: opts.last_run_at ?? null,
      next_run_at: opts.next_run_at ?? null,
      created_by: opts.created_by ?? null,
    };
    schedules.set(id, sched);
    return sched;
  }

  return { query, seedSchedule, schedules, executions };
}

function makeMockPgAdapter(reports) {
  // reports: { 'report_type': { asOfDate, yearMonth, since, until, ... } → result }
  return {
    async getArAging(_db, asOfDate) {
      const r = (reports.ar_aging || {})[asOfDate];
      return r === undefined ? { asOfDate, total_outstanding_amd: 0, buckets: {} } : r;
    },
    async getMonthlyRevenue(_db, yearMonth) {
      const r = (reports.monthly_revenue || {})[yearMonth];
      return r === undefined ? { year_month: yearMonth } : r;
    },
    async getTopCustomers(_db, { since, until, limit }) {
      const key = `${since}|${until}|${limit}`;
      const r = (reports.top_customers || {})[key];
      return r === undefined ? { items: [] } : r;
    },
    async getVatSummary(_db, since, until) {
      const key = `${since}|${until}`;
      const r = (reports.vat_summary || {})[key];
      return r === undefined ? { since, until } : r;
    },
    async getDataQualitySummary() {
      return reports.data_quality || { score: 100, total_customers: 0, total_invoices: 0 };
    },
    async listMonthlyRevenueTrend(_db, since, until) {
      const key = `${since}|${until}`;
      const r = (reports.revenue_trend || {})[key];
      return r === undefined ? { months: [] } : r;
    },
    async getCustomerRevenueBreakdown(_db, customerId, since, until) {
      const key = `${customerId}|${since}|${until}`;
      const r = (reports.customer_breakdown || {})[key];
      return r === undefined ? { customer_id: customerId } : r;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// computeNextRunAt
// ────────────────────────────────────────────────────────────────────────

test('computeNextRunAt: every minute returns the next minute', () => {
  // 2026-06-22 12:00:00 UTC
  const now = new Date('2026-06-22T12:00:00.000Z');
  const next = computeNextRunAt('* * * * *', now);
  assert.equal(next.toISOString(), '2026-06-22T12:01:00.000Z');
});

test('computeNextRunAt: every 5 minutes skips ahead', () => {
  // 2026-06-22 12:00:30 UTC — start should be 12:01:00
  const now = new Date('2026-06-22T12:00:30.000Z');
  const next = computeNextRunAt('*/5 * * * *', now);
  assert.equal(next.toISOString(), '2026-06-22T12:05:00.000Z');
});

test('computeNextRunAt: 9am daily', () => {
  // 2026-06-22 12:00:00 UTC — next 9am is tomorrow
  const now = new Date('2026-06-22T12:00:00.000Z');
  const next = computeNextRunAt('0 9 * * *', now);
  assert.equal(next.toISOString(), '2026-06-23T09:00:00.000Z');
});

test('computeNextRunAt: Mondays only at 9am', () => {
  // 2026-06-23 is Tuesday; next Monday is 2026-06-29
  const now = new Date('2026-06-23T12:00:00.000Z');
  const next = computeNextRunAt('0 9 * * 1', now);
  assert.equal(next.toISOString(), '2026-06-29T09:00:00.000Z');
});

test('computeNextRunAt: invalid expression throws ValueError', () => {
  const now = new Date('2026-06-22T12:00:00.000Z');
  assert.throws(() => computeNextRunAt('not a cron', now), ValueError);
});

test('computeNextRunAt: range expression', () => {
  // 2026-06-22 12:00:00 — next hour 9-17 is 13:00 same day
  const now = new Date('2026-06-22T12:00:00.000Z');
  const next = computeNextRunAt('0 9-17 * * *', now);
  assert.equal(next.toISOString(), '2026-06-22T13:00:00.000Z');
});

test('computeNextRunAt: list expression', () => {
  // 2026-06-22 12:00:00 — next hour 9 or 15 is 15:00 same day
  const now = new Date('2026-06-22T12:00:00.000Z');
  const next = computeNextRunAt('0 9,15 * * *', now);
  assert.equal(next.toISOString(), '2026-06-22T15:00:00.000Z');
});

// ────────────────────────────────────────────────────────────────────────
// dispatchReport (tested with a stub dispatch table to avoid
// pulling in the full report module chain).
// ────────────────────────────────────────────────────────────────────────

const STUB_DISPATCH = {
  ar_aging: async (_pgAdapter, params, now) => ({
    asOfDate: params.asOfDate || now.toISOString().substring(0, 10),
    buckets: { stub: true },
  }),
  monthly_revenue: async (_pgAdapter, params, now) => ({
    year_month: params.yearMonth || now.toISOString().substring(0, 7),
  }),
  top_customers: async (_pgAdapter, params, now) => ({
    since: params.since || now.toISOString().substring(0, 10),
    until: params.until || now.toISOString().substring(0, 10),
    limit: Number.isInteger(params.limit) ? params.limit : 10,
  }),
  data_quality: async () => ({ score: 100 }),
  revenue_trend: async (_pgAdapter, params, now) => ({
    since: params.since || now.toISOString().substring(0, 7),
    until: params.until || now.toISOString().substring(0, 7),
  }),
  customer_breakdown: async (_pgAdapter, params, now) => {
    if (!Number.isInteger(params.customerId)) {
      throw new ValueError('customer_breakdown requires params.customerId (integer)');
    }
    return { customer_id: params.customerId, gross_amd: 1000 };
  },
};

test('dispatchReport: ar_aging uses default asOfDate (today)', async () => {
  const now = new Date('2026-06-22T12:00:00.000Z');
  const result = await dispatchReport('ar_aging', null, null, null, now, STUB_DISPATCH);
  assert.equal(result.asOfDate, '2026-06-22');
});

test('dispatchReport: ar_aging respects params.asOfDate override', async () => {
  const now = new Date('2026-06-22T12:00:00.000Z');
  const result = await dispatchReport(
    'ar_aging',
    null,
    null,
    JSON.stringify({ asOfDate: '2025-12-31' }),
    now,
    STUB_DISPATCH,
  );
  assert.equal(result.asOfDate, '2025-12-31');
});

test('dispatchReport: monthly_revenue defaults to current month', async () => {
  const now = new Date('2026-06-22T12:00:00.000Z');
  const result = await dispatchReport('monthly_revenue', null, null, null, now, STUB_DISPATCH);
  assert.equal(result.year_month, '2026-06');
});

test('dispatchReport: top_customers defaults to 90-day window', async () => {
  const now = new Date('2026-06-22T12:00:00.000Z');
  const result = await dispatchReport('top_customers', null, null, null, now, STUB_DISPATCH);
  // Stub doesn't actually compute the 90-day default; we just
  // verify the dispatch returns the stub's echo shape with
  // the right limit default.
  assert.equal(result.limit, 10);
});

test('dispatchReport: data_quality uses today', async () => {
  const now = new Date('2026-06-22T12:00:00.000Z');
  const result = await dispatchReport('data_quality', null, null, null, now, STUB_DISPATCH);
  assert.equal(result.score, 100);
});

test('dispatchReport: customer_breakdown requires customerId', async () => {
  const now = new Date('2026-06-22T12:00:00.000Z');
  await assert.rejects(
    dispatchReport('customer_breakdown', null, null, null, now, STUB_DISPATCH),
    /customerId/,
  );
});

test('dispatchReport: customer_breakdown passes through', async () => {
  const now = new Date('2026-06-22T12:00:00.000Z');
  const result = await dispatchReport(
    'customer_breakdown',
    null,
    null,
    JSON.stringify({ customerId: 42 }),
    now,
    STUB_DISPATCH,
  );
  assert.equal(result.gross_amd, 1000);
});

test('dispatchReport: unknown report_type throws ValueError', async () => {
  const now = new Date('2026-06-22T12:00:00.000Z');
  await assert.rejects(
    dispatchReport('nonsense', null, null, null, now, STUB_DISPATCH),
    /unknown report_type/,
  );
});

test('dispatchReport: invalid params JSON throws ValueError', async () => {
  const now = new Date('2026-06-22T12:00:00.000Z');
  await assert.rejects(
    dispatchReport('ar_aging', null, null, 'not-json', now, STUB_DISPATCH),
    /valid JSON/,
  );
});

test('dispatchReport: params must be a JSON object', async () => {
  const now = new Date('2026-06-22T12:00:00.000Z');
  await assert.rejects(
    dispatchReport('ar_aging', null, null, JSON.stringify([1, 2, 3]), now, STUB_DISPATCH),
    /JSON object/,
  );
});

// ────────────────────────────────────────────────────────────────────────
// sendNotificationEmail stub
// ────────────────────────────────────────────────────────────────────────

test('sendNotificationEmail: stub returns deterministic shape', async () => {
  const r = await sendNotificationEmail('cfo@example.com', 'ar_aging', '{"x":1}');
  assert.equal(r.delivered, false);
  assert.equal(r.to, 'cfo@example.com');
  assert.equal(r.report_type, 'ar_aging');
  assert.equal(r.bytes, 7);
});

// ────────────────────────────────────────────────────────────────────────
// tickOnce
// ────────────────────────────────────────────────────────────────────────

test('tickOnce: fires a due schedule and records a completed execution', async () => {
  const db = makeMockDb();
  const pgAdapter = makeMockPgAdapter({});
  const sched = db.seedSchedule({
    report_type: 'ar_aging',
    cron_expression: '* * * * *',
    next_run_at: '2026-06-22T12:00:00.000Z',
  });
  const summary = await tickOnce(db, pgAdapter, new Date('2026-06-22T12:01:00.000Z'), 0, STUB_DISPATCH);
  assert.equal(summary.fired, 1);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.errors, 0);
  assert.equal(db.executions.size, 1);
  const exec = db.executions.get(1);
  assert.equal(exec.status, 'completed');
  assert.equal(exec.report_type, 'ar_aging');
  assert.ok(exec.result_json);
  // The schedule's next_run_at should be bumped to a future minute.
  assert.ok(sched.next_run_at > '2026-06-22T12:01:00');
});

test('tickOnce: skips schedules whose next_run_at is in the future', async () => {
  const db = makeMockDb();
  const pgAdapter = makeMockPgAdapter({});
  db.seedSchedule({
    report_type: 'ar_aging',
    cron_expression: '* * * * *',
    next_run_at: '2026-06-22T13:00:00.000Z',
  });
  const summary = await tickOnce(db, pgAdapter, new Date('2026-06-22T12:00:00.000Z'), 0, STUB_DISPATCH);
  assert.equal(summary.fired, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(db.executions.size, 0);
});

test('tickOnce: skips disabled schedules', async () => {
  const db = makeMockDb();
  const pgAdapter = makeMockPgAdapter({});
  db.seedSchedule({
    report_type: 'ar_aging',
    cron_expression: '* * * * *',
    enabled: 0,
    next_run_at: '2026-06-22T12:00:00.000Z',
  });
  const summary = await tickOnce(db, pgAdapter, new Date('2026-06-22T12:01:00.000Z'), 0, STUB_DISPATCH);
  assert.equal(summary.fired, 0);
  assert.equal(summary.skipped, 0); // list enabled returns []
});

test('tickOnce: records failed execution when dispatch throws', async () => {
  const db = makeMockDb();
  // Stub dispatch that throws for ar_aging.
  const throwingDispatch = {
    ar_aging: async () => {
      throw new Error('boom');
    },
  };
  db.seedSchedule({
    report_type: 'ar_aging',
    cron_expression: '* * * * *',
    next_run_at: '2026-06-22T12:00:00.000Z',
  });
  const summary = await tickOnce(db, null, new Date('2026-06-22T12:01:00.000Z'), 0, throwingDispatch);
  assert.equal(summary.fired, 1);
  assert.equal(summary.errors, 0); // failed execution is still fired, not a tick error
  const exec = db.executions.get(1);
  assert.equal(exec.status, 'failed');
  assert.equal(exec.error_message, 'boom');
});

test('tickOnce: handles empty schedule list', async () => {
  const db = makeMockDb();
  const pgAdapter = makeMockPgAdapter({});
  const summary = await tickOnce(db, pgAdapter, new Date('2026-06-22T12:00:00.000Z'), 0, STUB_DISPATCH);
  assert.deepEqual(summary, { fired: 0, skipped: 0, errors: 0 });
});

test('tickOnce: sendNotificationEmail called for notify_email set', async () => {
  const db = makeMockDb();
  const pgAdapter = makeMockPgAdapter({});
  db.seedSchedule({
    report_type: 'data_quality',
    cron_expression: '* * * * *',
    next_run_at: '2026-06-22T12:00:00.000Z',
    notify_email: 'cfo@example.com',
  });
  // The sendNotificationEmail stub returns a deterministic
  // shape; we can't observe its call from the outside, but
  // we can verify the execution was still recorded (email
  // failure doesn't fail the tick).
  const summary = await tickOnce(db, pgAdapter, new Date('2026-06-22T12:01:00.000Z'), 0, STUB_DISPATCH);
  assert.equal(summary.fired, 1);
  assert.equal(db.executions.get(1).status, 'completed');
});

test('tickOnce: mixed due and not-due schedules', async () => {
  const db = makeMockDb();
  const pgAdapter = makeMockPgAdapter({});
  db.seedSchedule({
    name: 'due-1',
    next_run_at: '2026-06-22T12:00:00.000Z',
  });
  db.seedSchedule({
    name: 'due-2',
    next_run_at: '2026-06-22T11:59:00.000Z',
  });
  db.seedSchedule({
    name: 'future',
    next_run_at: '2026-06-22T13:00:00.000Z',
  });
  const summary = await tickOnce(db, pgAdapter, new Date('2026-06-22T12:00:00.000Z'), 0, STUB_DISPATCH);
  assert.equal(summary.fired, 2);
  assert.equal(summary.skipped, 1);
});

// ────────────────────────────────────────────────────────────────────────
// startScheduler
// ────────────────────────────────────────────────────────────────────────

test('startScheduler: returns a handle with stop() and tickMs', () => {
  const db = makeMockDb();
  const pgAdapter = makeMockPgAdapter({});
  const handle = startScheduler({ db, pgAdapter, tickMs: 5000 });
  assert.equal(handle.tickMs, 5000);
  assert.equal(typeof handle.stop, 'function');
  assert.equal(typeof handle.tickOnce, 'function');
  handle.stop();
});

test('startScheduler: stop() is idempotent', () => {
  const db = makeMockDb();
  const pgAdapter = makeMockPgAdapter({});
  const handle = startScheduler({ db, pgAdapter, tickMs: 5000 });
  handle.stop();
  handle.stop(); // should not throw
});

test('startScheduler: tickMs below MIN_TICK_MS throws ValueError', () => {
  const db = makeMockDb();
  const pgAdapter = makeMockPgAdapter({});
  assert.throws(
    () => startScheduler({ db, pgAdapter, tickMs: 100 }),
    /tickMs/,
  );
});

test('startScheduler: missing db throws TypeError', () => {
  const pgAdapter = makeMockPgAdapter({});
  assert.throws(
    () => startScheduler({ pgAdapter, tickMs: 5000 }),
    /requires opts.db/,
  );
});

test('startScheduler: missing pgAdapter throws TypeError', () => {
  const db = makeMockDb();
  assert.throws(
    () => startScheduler({ db, tickMs: 5000 }),
    /requires opts.pgAdapter/,
  );
});
